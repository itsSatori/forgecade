import Anthropic from "@anthropic-ai/sdk";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The project .env wins over inherited shell env (node --env-file does not
// override existing variables, which bites inside IDE/agent environments).
function loadDotenv() {
  const path = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // no .env — fall back to the inherited environment
  }
  return out;
}

const cfg = { ...process.env, ...loadDotenv() };

const SYSTEM_PROMPT = `You are the game generator of Forgecade, a self-hosted AI party game.
A group of friends is playing together, each on their own computer. Your job:
turn their game idea into a complete, playable MULTIPLAYER browser game.

## Multiplayer — the Forgecade SDK

The game runs inside a sandboxed iframe on every player's machine. Networking is
handled for you by the Forgecade SDK — you must NOT write any networking code
(no WebSocket, no fetch). Include the SDK exactly like this:

    <script src="/forgecade-sdk.js"></script>

API (global \`Forgecade\`):

    Forgecade.init((ctx) => { ... })
      // Called once when the game starts, on every player's machine.
      // ctx = { players: [{id, name}], me: {id, name}, isHost: boolean }
    Forgecade.send(data)
      // Broadcasts \`data\` (any JSON value) to all OTHER players. Not echoed to self.
    Forgecade.onMessage((data, fromPlayerId) => { ... })
      // Receives what other players sent.
    Forgecade.end({ scores: { [playerId]: number } })
      // Optional: call when a round is decided, to report scores.

## Required architecture: host-authoritative

Exactly one player has ctx.isHost === true. Structure every game like this:
- The HOST runs all game logic (state, physics, scoring, win conditions) and
  broadcasts the authoritative state to everyone via Forgecade.send(...)
  on a fixed tick (e.g. 10-20x per second, or per turn for turn-based games).
- NON-HOSTS only render the received state and send their inputs to the host.
- The host applies its OWN inputs directly (send() does not echo to self).
- Design for 2-8 players using ctx.players; every player must participate.
- If a state message names players, key it by player id and show their names.

## Rules for the game itself

- One single, self-contained HTML file. All CSS and JavaScript inline.
- Use Babylon.js for 3D (load via <script src="https://cdn.babylonjs.com/babylon.js"></script>).
  For 2D, plain <canvas> or DOM without any library is fine — pick what fits the idea.
- No build step, no server calls, no external assets — the SDK script tag and the
  Babylon.js CDN script tag are the only external resources allowed.
  Generate shapes, colors and sounds procedurally (WebAudio welcome).
- Show the controls on screen and make it obvious whose turn / what the goal is.
- Include scoring or a win condition so a round has a clear end; call Forgecade.end then.

## Quality bar — this ships to a party, make it land

- Open with a short title card: game name, one-line "how to play", the players' names.
  Start the round after ~4 seconds or when the host presses a key.
- Animate everything that moves: easing, squash-and-stretch, particles on hits,
  screen shake on big moments. Procedural WebAudio sound effects for key actions.
- Be FUNNY. Lean into the absurdity of the idea: silly labels, dramatic announcements,
  ridiculous game-over messages. The group should laugh within the first 30 seconds.
- Hide one small easter egg (a secret key, a 1-in-20 event, an absurd detail).
- Short rounds beat long ones: 2-4 minutes, then a scoreboard with drama.
- Readable from across the room: big type, high contrast, player colors.

Output format: respond with ONLY the HTML document, starting with <!DOCTYPE html>.
No markdown code fences, no explanation before or after.`;

// Fixed mini-game for development: full party flow + SDK relay without API costs.
const FAKE_GAME = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Click Race</title><style>
body{background:#12141a;color:#e8e6e1;font:18px ui-monospace,monospace;display:flex;flex-direction:column;align-items:center;gap:1rem;padding:2rem}
button{font:inherit;font-size:2rem;padding:1rem 3rem;border-radius:12px;border:0;background:#f2a03d;cursor:pointer}
ul{list-style:none;padding:0}
</style></head><body>
<h2>Click Race — first to 20</h2>
<button id="b">CLICK!</button>
<ul id="s"></ul>
<script src="/forgecade-sdk.js"></script>
<script>
Forgecade.init((ctx) => {
  const counts = Object.fromEntries(ctx.players.map(p => [p.id, 0]));
  const names = Object.fromEntries(ctx.players.map(p => [p.id, p.name]));
  let over = false;
  const render = () => {
    document.getElementById("s").innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => "<li>" + names[id] + ": " + n + (n >= 20 ? " 🏆" : "") + "</li>").join("");
  };
  const tally = (id) => {
    if (over) return;
    counts[id]++;
    if (counts[id] >= 20) { over = true; Forgecade.end({ scores: counts }); }
    Forgecade.send({ counts });
    render();
  };
  document.getElementById("b").onclick = () => {
    if (ctx.isHost) tally(ctx.me.id);
    else Forgecade.send({ click: true });
  };
  Forgecade.onMessage((data, from) => {
    if (ctx.isHost && data.click) tally(from);
    if (data.counts) { Object.assign(counts, data.counts); render(); }
  });
  render();
});
</script></body></html>`;

const MODEL = cfg.FORGECADE_MODEL ?? "claude-opus-4-8";
const FAKE = Boolean(cfg.FORGECADE_FAKE_GENERATOR);

const client = FAKE
  ? null
  : new Anthropic({
      baseURL: cfg.ANTHROPIC_BASE_URL,
      authToken: cfg.ANTHROPIC_AUTH_TOKEN ?? null,
      apiKey: cfg.ANTHROPIC_AUTH_TOKEN ? null : (cfg.ANTHROPIC_API_KEY ?? null),
    });

export const generatorInfo = {
  model: MODEL,
  fake: FAKE,
  hasCredentials: Boolean(cfg.ANTHROPIC_AUTH_TOKEN || cfg.ANTHROPIC_API_KEY),
};

// Strips markdown fences in case the model wraps the document anyway.
function extractHtml(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  const html = fenced ? fenced[1] : trimmed;
  if (!/^<!doctype html>/i.test(html.trim())) {
    throw new Error("Generator returned no HTML document");
  }
  return html;
}

// LLMs occasionally emit broken JS — syntax-check every inline script so a
// party never gets a game that dies on load. Throws with the parser message.
function validateGameHtml(html) {
  const scripts = html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const [, attrs, code] of scripts) {
    if (/type\s*=\s*["']?module/i.test(attrs)) continue; // vm.Script can't parse modules
    if (!code.trim()) continue;
    try {
      new vm.Script(code);
    } catch (err) {
      throw new Error(`generated JS is broken: ${err.message}`);
    }
  }
}

async function requestGame(messages, onProgress) {
  const request = {
    model: MODEL,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    messages,
  };
  // adaptive thinking is Claude-specific; compat APIs (e.g. GLM) reject it
  if (MODEL.startsWith("claude")) request.thinking = { type: "adaptive" };
  const stream = client.messages.stream(request);

  let chars = 0;
  stream.on("text", (delta) => {
    chars += delta.length;
    onProgress?.(chars);
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "max_tokens") {
    throw new Error("Generation hit the token limit — game is incomplete");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return extractHtml(text);
}

export async function generateGame(idea, { onProgress } = {}) {
  if (FAKE) {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      onProgress?.(i * 1000);
    }
    validateGameHtml(FAKE_GAME);
    return FAKE_GAME;
  }

  const base = [{ role: "user", content: `Game idea: ${idea}` }];
  const html = await requestGame(base, onProgress);
  try {
    validateGameHtml(html);
    return html;
  } catch (err) {
    console.warn(`[forgecade] validation failed (${err.message}) — repair round`);
    const repaired = await requestGame(
      [
        ...base,
        { role: "assistant", content: html },
        {
          role: "user",
          content: `Your game does not run — ${err.message}. ` +
            `Output the complete corrected HTML document: same game, fixed code. ` +
            `Same output rules: respond with ONLY the HTML document, no fences, no explanation.`,
        },
      ],
      onProgress,
    );
    validateGameHtml(repaired); // still broken → forge-failed path handles it
    return repaired;
  }
}
