import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, normalize, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { attachRooms } from "./rooms.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GAMES_DIR = join(ROOT, "games");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.FORGECADE_PORT ?? 4242);
// Bind to loopback by default; set FORGECADE_HOST=0.0.0.0 to open it up
// (e.g. on the box your friends connect to).
const HOST = process.env.FORGECADE_HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
};

// Generated games are untrusted LLM output. The sandbox CSP gives them an
// opaque origin: no access to the party frame, the WebSocket or the API —
// they can only talk to the party frame via the SDK's postMessage bridge.
const GAME_HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts allow-pointer-lock",
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
  return games.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

    if (req.method === "GET" && path === "/") {
      return await sendFile(res, join(PUBLIC_DIR, "index.html"));
    }

    if (req.method === "GET" && path === "/forgecade-sdk.js") {
      return await sendFile(res, join(PUBLIC_DIR, "forgecade-sdk.js"));
    }

    if (req.method === "GET" && path === "/api/games") {
      return sendJson(res, 200, { games: await listGames() });
    }

    if (req.method === "GET" && path.startsWith("/games/")) {
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

attachRooms(server, GAMES_DIR);

server.listen(PORT, HOST, () => {
  console.log(`[forgecade] running on http://${HOST}:${PORT}`);
  if (process.env.FORGECADE_FAKE_GENERATOR) {
    console.log("[forgecade] FAKE GENERATOR active — no API calls will be made");
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[forgecade] warning: ANTHROPIC_API_KEY is not set — generation will fail",
    );
  }
});
