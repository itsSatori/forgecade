// Play any forged game yourself, with as many seats as you like, without
// starting a party. Same harness the smoke test uses — but the autoplayer is
// off, so the seats are yours.
//
//   node test/playground.js [port]
//   open http://127.0.0.1:4243/
//
// Every seat is a frame in one window: click a seat, then play it. Open the
// same URL in more windows (or on a phone on the same network) and each window
// drives its own seat — that is the closest thing to a real party without one.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_HEADERS } from "../src/game-headers.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GAMES = join(ROOT, "games");
const PORT = Number(process.argv[2]) || 4243;

async function listGames() {
  const out = [];
  for (const entry of await readdir(GAMES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    try {
      const meta = JSON.parse(await readFile(join(GAMES, entry.name, "meta.json"), "utf8"));
      out.push({ slug: entry.name, title: meta.title || entry.name, idea: meta.idea ?? "" });
    } catch { /* no meta — skip */ }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

const page = (games) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Forgecade playground</title><style>
body{margin:0;background:#111;color:#eee;font:14px system-ui,sans-serif}
#bar{padding:10px;background:#1c1c1c;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
select,button{font:inherit;background:#2a2a2a;color:#eee;border:1px solid #555;padding:6px 10px;border-radius:6px}
button{cursor:pointer}
a{color:#ff9f43}
.hint{color:#888;font-size:13px}
</style></head><body>
<div id="bar">
  <strong>Forgecade playground</strong>
  <select id="game">${games.map((g) =>
    `<option value="${g.slug}">${g.title}${g.idea ? ` — "${g.idea}"` : ""}</option>`).join("")}</select>
  <label class="hint">seats <select id="seats">${[2,3,4,6,8].map((n) =>
    `<option${n === 4 ? " selected" : ""}>${n}</option>`).join("")}</select></label>
  <button id="go">play</button>
  <span class="hint">click a seat to give it focus, then use the controls. Each extra window you open drives its own seat.</span>
</div>
<div id="hint" class="hint" style="padding:10px">pick a game and hit play</div>
<script>
document.getElementById("go").onclick = () => {
  const slug = document.getElementById("game").value;
  const seats = document.getElementById("seats").value;
  location.href = "/play/" + slug + "?players=" + seats + "&bot=0";
};
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page(await listGames()));
    }
    if (path === "/forgecade-sdk.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(await readFile(join(ROOT, "public", "forgecade-sdk.js")));
    }
    // the harness, told which game to load
    if (path.startsWith("/play/")) {
      const harness = await readFile(join(ROOT, "test", "harness.html"), "utf8");
      const slug = path.slice("/play/".length).replace(/[^a-zA-Z0-9._-]/g, "");
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(harness.replace('`/game/?p=${COUNT}&seat=${i}`',
        '`/game/' + slug + '/?p=${COUNT}&seat=${i}&bot=0`'));
    }
    if (path.startsWith("/game/")) {
      const rel = path.slice("/game/".length).replace(/\.\./g, "");
      const slug = rel.split("/")[0];
      const html = await readFile(join(GAMES, slug, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html", ...GAME_HEADERS });
      return res.end(html);
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500);
    res.end(String(err.message));
  }
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[playground] http://127.0.0.1:${PORT}/  — ${PORT === 4243 ? "" : ""}play any forged game, no party needed`));
