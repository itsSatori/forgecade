import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, normalize, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { attachRooms, roomCount, broadcastAll } from "./rooms.js";
import { generatorInfo } from "./generator.js";
import { cfg } from "./env.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GAMES_DIR = join(ROOT, "games");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(cfg.FORGECADE_PORT ?? 4242);
// Bind to loopback by default; set FORGECADE_HOST=0.0.0.0 to open it up
// (e.g. on the box your friends connect to).
const HOST = cfg.FORGECADE_HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Generated games are untrusted LLM output. The sandbox CSP gives them an
// opaque origin: no access to the party frame, the WebSocket or the API —
// they can only talk to the party frame via the SDK's postMessage bridge.
// script-src hosts must stay in sync with ALLOWED_SCRIPT_HOSTS in generator.js —
// the validator refuses at forge time what this header would block at play time.
const GAME_HEADERS = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-pointer-lock; default-src 'none'; " +
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' " +
    "https://cdn.babylonjs.com https://cdnjs.cloudflare.com; " +
    "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; " +
    "connect-src 'none'",
};

async function listGames() {
  let entries = [];
  try {
    entries = await readdir(GAMES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const games = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    try {
      const meta = JSON.parse(
        await readFile(join(GAMES_DIR, entry.name, "meta.json"), "utf8"),
      );
      games.push(meta);
    } catch {
      // directory without meta.json — skip
    }
  }
  const sorted = games
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return { games: sorted.slice(0, 100), total: sorted.length };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function sendFile(res, filePath, extraHeaders = {}) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// Client assets (HTML/JS/CSS) have no versioned filenames, so tell browsers to
// always revalidate — after an update, returning players must not run stale
// client code against a newer protocol. Generated games live at immutable
// per-slug paths and stay cacheable.
const NO_CACHE = { "Cache-Control": "no-cache" };

// Serves a file from below baseDir, rejecting path traversal.
async function sendFrom(res, baseDir, relPath, extraHeaders = {}) {
  const target = normalize(join(baseDir, normalize(relPath).replace(/^\/+/, "")));
  if (!target.startsWith(baseDir + sep)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  return sendFile(res, target, extraHeaders);
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    // treat HEAD like GET for routing (link-preview bots probe with HEAD);
    // nginx strips the body from HEAD responses at the edge
    const method = req.method === "HEAD" ? "GET" : req.method;

    if (method === "GET" && path === "/") {
      return await sendFile(res, join(PUBLIC_DIR, "index.html"), NO_CACHE);
    }

    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        uptime: process.uptime(),
        rooms: roomCount(),
        model: generatorInfo.model,
        fake: generatorInfo.fake,
      });
    }

    if (method === "GET" && /^\/[\w.-]+\.(js|css|png)$/.test(path)) {
      return await sendFrom(res, PUBLIC_DIR, path.slice(1), NO_CACHE);
    }

    if (method === "GET" && path === "/api/games") {
      return sendJson(res, 200, await listGames());
    }

    if (method === "GET" && path.startsWith("/games/")) {
      const rel = path.slice("/games/".length) + (path.endsWith("/") ? "index.html" : "");
      const headers = rel.endsWith(".html") ? GAME_HEADERS : {};
      return await sendFrom(res, GAMES_DIR, rel, headers);
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error("[forgecade] request failed:", err);
    sendJson(res, 500, { error: "internal error" });
  }
});

attachRooms(server, GAMES_DIR, { accessCode: cfg.FORGECADE_ACCESS_CODE });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[forgecade] ${signal} — shutting down`);
  broadcastAll({
    type: "toast",
    message: "Server restarting — back in a moment, rejoin with your room code",
  });
  server.close();
  // give the toast a moment to flush, then go
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(`[forgecade] running on http://${HOST}:${PORT}`);
  if (generatorInfo.fake) {
    console.log("[forgecade] FAKE GENERATOR active — no API calls will be made");
  } else if (!generatorInfo.hasCredentials) {
    console.warn("[forgecade] warning: no API credentials — generation will fail");
  } else {
    console.log(`[forgecade] generator model: ${generatorInfo.model}`);
  }
});
