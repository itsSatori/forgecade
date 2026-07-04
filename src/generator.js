import Anthropic from "@anthropic-ai/sdk";

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
- Keep it fun and juicy within these constraints; short rounds beat long ones.

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

const client = process.env.FORGECADE_FAKE_GENERATOR ? null : new Anthropic();

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

export async function generateGame(idea, { onProgress } = {}) {
  if (process.env.FORGECADE_FAKE_GENERATOR) {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      onProgress?.(i * 1000);
    }
    return FAKE_GAME;
  }

  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Game idea: ${idea}` }],
  });

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
