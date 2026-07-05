import Anthropic from "@anthropic-ai/sdk";
import vm from "node:vm";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./env.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SYSTEM_PROMPT = `You are the game generator of Forgecade, a self-hosted AI party game.
A group of friends is playing together, each on their own computer. Your job:
turn their game idea into a complete, playable MULTIPLAYER browser game.

## Multiplayer — the Forgecade SDK

The game runs inside a sandboxed iframe on every player's machine. Networking is
handled for you by the Forgecade SDK — you must NOT write any networking code
(no WebSocket, no fetch, no XMLHttpRequest, no EventSource; the sandbox blocks
them all). Include the SDK exactly like this:

    <script src="/forgecade-sdk.js"></script>

API (global \`Forgecade\`):

    Forgecade.init((ctx) => { ... })
      // Called once when the game starts, on every player's machine.
      // ctx = { players: [{id, name, color}], me: {id, name, color},
      //         isHost: boolean, seed: number }
    Forgecade.send(data)
      // Broadcasts \`data\` (any JSON value) to all OTHER players. Not echoed to self.
    Forgecade.onMessage((data, fromPlayerId) => { ... })
      // Receives what other players sent.
    Forgecade.onPlayersChange((players) => { ... })
      // Roster changed — players left or joined. Same shape as ctx.players.
    Forgecade.onPause(() => { ... }) / Forgecade.onResume(() => { ... })
      // The party switched away from the game / came back to it.
    Forgecade.end({ scores: { [playerId]: number } })
      // Reports the round result. Call exactly once, when the round is decided.

## Required architecture: host-authoritative

Exactly one player has ctx.isHost === true. Structure every game like this:
- The HOST runs all game logic (state, physics, scoring, win conditions) and
  broadcasts the authoritative state to everyone via Forgecade.send(...)
  on a fixed tick (e.g. 10-20x per second, or per turn for turn-based games).
- NON-HOSTS only render the received state and send their inputs to the host.
- The host applies its OWN inputs directly (send() does not echo to self).
- Design for 2-8 players using ctx.players; every player must participate.
- If a state message names players, key it by player id and show their names.

## Networking reality — design for latency

Player-to-player roundtrips take 100-300ms. Pick designs that tolerate that:
simultaneous decisions, turns, timing windows, races against the clock — NOT
precision physics duels or twitch head-to-head reaction contests.
- Keep send() payloads small (under 4KB) and send at most 20 messages per second.
- The host broadcasts the full authoritative state at least every 2 seconds,
  so missed messages heal themselves.
- Silently ignore malformed or unexpected incoming messages — never crash on one.

## Players come and go

- Players can drop mid-round and new ones can join late; handle
  Forgecade.onPlayersChange. Tolerate unknown player ids in messages — never
  crash on them. The game keeps running when someone disappears; late joiners
  spectate until the next round starts.
- On Forgecade.onPause, stop the game loop and mute all audio. Continue on
  Forgecade.onResume.

## Start, rounds, end

- Open with a big CLICK / TAP TO START overlay on top of the title card.
  Create AudioContexts and attach keyboard listeners only after that first
  click — autoplay is blocked and the iframe has no keyboard focus until then.
- A round runs 60-150 seconds with a visible countdown. When the timer runs out
  (or the win condition hits), the host MUST call Forgecade.end({ scores }) —
  exactly once per round. That ends the round for good.
- After that, show a scoreboard screen with drama — the final standings. Do NOT
  add an in-game "play again" button: a new round is started from Forgecade (the
  party frame), not from inside the game. The scoreboard just celebrates the result.

## Rules for the game itself

- One single, self-contained HTML file. All CSS and JavaScript inline.
- Use Babylon.js for 3D (load via <script src="https://cdn.babylonjs.com/babylon.js"></script>).
  For 2D, plain <canvas> or DOM without any library is fine — pick what fits the idea.
- No build step, no server calls, no external assets — the SDK script tag and the
  Babylon.js CDN script tag are the only external resources allowed.
  Generate shapes, colors and sounds procedurally (WebAudio welcome).
- Show the controls on screen and make it obvious whose turn / what the goal is.
- Every game must ALSO be playable by touch: on-screen buttons or tap zones
  next to any keyboard controls — someone always joins on a phone.
- Use ctx.players[i].color for everything that represents a player: sprites,
  labels, trails, scoreboard rows. Use ctx.seed for procedural generation so
  every client sees the same world.
- Inside inline JS strings, write <\\/script> instead of </script> so the
  document does not terminate early.

## Quality bar — this ships to a party, make it land

- <title> is the game's name — make it catchy. Show it big on the title screen,
  along with the original idea quoted verbatim, a one-line "how to play" and
  the players' names.
- Animate everything that moves: easing, squash-and-stretch, particles on hits,
  screen shake on big moments. Procedural WebAudio sound effects for key actions.
- Be FUNNY. Lean into the absurdity of the idea: silly labels, dramatic announcements,
  ridiculous game-over messages. The group should laugh within the first 30 seconds.
- Hide one small easter egg (a secret key, a 1-in-20 event, an absurd detail).
- Readable from across the room: big type, high contrast, player colors.

Output format: respond with ONLY the HTML document, starting with <!DOCTYPE html>
and ending with </html>. No markdown code fences, no explanation before or after.`;

// Fixed mini-game for development: full party flow + SDK relay without API costs.
const FAKE_GAME = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Click Race</title><style>
body{background:#12141a;color:#e8e6e1;font:18px ui-monospace,monospace;display:flex;flex-direction:column;align-items:center;gap:1rem;padding:2rem}
h2{margin:0}
button{font:inherit;font-size:2rem;padding:1rem 3rem;border-radius:12px;border:0;background:#f2a03d;cursor:pointer}
button:active{transform:scale(.96)}
ul{list-style:none;padding:0;text-align:center}
p.hint{color:#8a8880;font-size:14px;margin:0}
#ov{position:fixed;inset:0;background:#12141a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;cursor:pointer;user-select:none;z-index:9}
#ov b{font-size:2.5rem;letter-spacing:.1em}
</style></head><body>
<div id="ov"><b>CLICK TO START</b><p class="hint">fake dev game — no tokens were harmed</p></div>
<h2>Click Race — first to 20</h2>
<p class="hint">mash the button. that's it. that's the game.</p>
<button id="b">CLICK!</button>
<ul id="s"></ul>
<script src="/forgecade-sdk.js"></script>
<script>
document.getElementById("ov").onclick = () => document.getElementById("ov").remove();
Forgecade.init((ctx) => {
  const counts = Object.fromEntries(ctx.players.map(p => [p.id, 0]));
  const names = Object.fromEntries(ctx.players.map(p => [p.id, p.name]));
  let over = false;
  const render = () => {
    document.getElementById("s").innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => "<li>" + (names[id] ?? "???") + ": " + n + (n >= 20 ? " 🏆" : "") + "</li>").join("");
  };
  const tally = (id) => {
    if (over) return;
    counts[id] ??= 0;
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
const FAKE = ["1", "true", "yes"].includes(String(cfg.FORGECADE_FAKE_GENERATOR).toLowerCase());
const MAX_TOKENS = Number(cfg.FORGECADE_MAX_TOKENS) || 64000;
const FORGE_TIMEOUT_MS = Number(cfg.FORGECADE_FORGE_TIMEOUT_MS) || 240000;
const STALL_MS = 60000;

const client = FAKE
  ? null
  : new Anthropic({
      baseURL: cfg.ANTHROPIC_BASE_URL,
      authToken: cfg.ANTHROPIC_AUTH_TOKEN ?? null,
      apiKey: cfg.ANTHROPIC_AUTH_TOKEN ? null : (cfg.ANTHROPIC_API_KEY ?? null),
      maxRetries: 1,
    });

export const generatorInfo = {
  model: MODEL,
  fake: FAKE,
  hasCredentials: Boolean(cfg.ANTHROPIC_AUTH_TOKEN || cfg.ANTHROPIC_API_KEY),
};

// Tolerant extraction: drop fence lines, slice from the first <!doctype html>
// to the last </html>, ignoring any prose the model wrapped around it.
function extractHtml(text) {
  const cleaned = text.replace(/^\s*```[a-z]*\s*$/gim, "");
  const start = cleaned.search(/<!doctype html>/i);
  if (start === -1) throw new Error("output contains no <!DOCTYPE html> document");
  let html = cleaned.slice(start);
  const end = html.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) html = html.slice(0, end + "</html>".length);
  return html.trim();
}

// Guards the party from broken games. Structural checks first, with precise
// messages (they feed the repair round), then a syntax check of every inline
// script so a game never dies on load.
function validateGameHtml(html) {
  if (html.length < 2000) {
    throw new Error(`document is only ${html.length} chars — far too short for a complete game`);
  }
  if (!/<\/html>\s*$/i.test(html)) {
    throw new Error("document does not end with </html> — the output was cut off");
  }
  if (!/<script[^>]*\bsrc\s*=\s*["']?\/forgecade-sdk\.js["']?/i.test(html)) {
    throw new Error(`missing <script src="/forgecade-sdk.js"> tag — the game cannot reach the other players without it`);
  }
  if (!/Forgecade\.init\s*\(/.test(html)) {
    throw new Error("never calls Forgecade.init(...) — the game would never start");
  }
  for (const banned of ["new WebSocket", "fetch(", "XMLHttpRequest", "EventSource("]) {
    if (html.includes(banned)) {
      throw new Error(`uses ${banned} — the sandbox blocks all network access (connect-src 'none'); use the Forgecade SDK instead`);
    }
  }
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

// Keeps the raw output of a failed forge around for postmortems. listGames
// ignores this directory because it never gets a meta.json.
async function archiveFailedForge(idea, text, error) {
  try {
    const slug = idea.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
    const dir = join(ROOT, "games", "_failed", `${Date.now()}-${slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dump.html"), text);
    await writeFile(join(dir, "error.txt"), `idea: ${idea}\nerror: ${error}\n`);
    console.warn(`[forgecade] failed forge archived in ${dir}`);
  } catch (err) {
    console.warn(`[forgecade] could not archive failed forge: ${err.message}`);
  }
}

// Streams one generation attempt and returns the raw text — callers extract
// and validate. charOffset keeps onProgress monotonic across repair rounds.
async function requestGame(messages, onProgress, charOffset = 0) {
  const request = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  };
  // adaptive thinking is Claude-specific; compat APIs (e.g. GLM) reject it
  if (MODEL.startsWith("claude")) request.thinking = { type: "adaptive" };

  // Watchdog: hard total timeout plus a stall timer re-armed on ANY stream
  // progress — a hung stream must not wedge the forge queue forever, but a
  // model that thinks for a while before emitting text is not hung. Adaptive
  // thinking (and long GLM ramp-ups) emit no text deltas during reasoning, so
  // arming only on "text" would kill healthy generations; refresh on the raw
  // event stream, which also covers thinking, pings, and tool events.
  const controller = new AbortController();
  let abortReason = null;
  const abort = (reason) => {
    abortReason = reason;
    controller.abort();
  };
  const totalTimer = setTimeout(() => abort("generation timed out"), FORGE_TIMEOUT_MS);
  const stallTimer = setTimeout(() => abort("stream stalled"), STALL_MS);

  const stream = client.messages.stream(request, { signal: controller.signal });

  stream.on("streamEvent", () => stallTimer.refresh());

  let chars = charOffset;
  stream.on("text", (delta) => {
    chars += delta.length;
    onProgress?.(chars);
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    throw abortReason ? new Error(abortReason) : err;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(stallTimer);
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, stopReason: message.stop_reason, chars };
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

  const started = Date.now();
  const base = [{ role: "user", content: `Game idea: ${idea}` }];

  let first;
  try {
    first = await requestGame(base, onProgress);
  } catch (err) {
    await archiveFailedForge(idea, "", err.message);
    throw err;
  }

  let doc = null;
  let failure;
  if (first.stopReason === "max_tokens") {
    failure = "output hit the token limit and was cut off";
  } else {
    try {
      doc = extractHtml(first.text);
      validateGameHtml(doc);
      console.log(`[forgecade] forged "${idea}" in ${Date.now() - started}ms (${MODEL})`);
      return doc;
    } catch (err) {
      failure = err.message;
    }
  }

  console.warn(`[forgecade] first pass failed (${failure}) — repair round`);
  const instruction =
    first.stopReason === "max_tokens"
      ? "Your output hit the token limit and was cut off. Rewrite it tighter — same game, leaner code — as one complete HTML document."
      : `Your game does not run — ${failure}. Output the complete corrected HTML document: same game, fixed code.`;

  // When extraction failed there is no clean document — hand the raw text back.
  let lastText = doc ?? first.text;
  try {
    const second = await requestGame(
      [
        ...base,
        { role: "assistant", content: lastText || "(empty output)" },
        {
          role: "user",
          content: `${instruction} Same output rules: respond with ONLY the HTML document, no fences, no explanation.`,
        },
      ],
      onProgress,
      first.chars,
    );
    lastText = second.text;
    if (second.stopReason === "max_tokens") {
      throw new Error("Generation hit the token limit — game is incomplete");
    }
    const repaired = extractHtml(second.text);
    validateGameHtml(repaired);
    console.log(`[forgecade] forged "${idea}" in ${Date.now() - started}ms (${MODEL}, repaired)`);
    return repaired;
  } catch (err) {
    await archiveFailedForge(idea, lastText, err.message);
    throw err;
  }
}
