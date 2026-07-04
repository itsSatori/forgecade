import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, normalize, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateGame } from "./generator.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GAMES_DIR = join(ROOT, "games");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.FORGECADE_PORT ?? 4242);
// Bind to loopback by default; set FORGECADE_HOST=0.0.0.0 only behind a
// reverse proxy that adds auth + TLS (the API is unauthenticated).
const HOST = process.env.FORGECADE_HOST ?? "127.0.0.1";
const MAX_CONCURRENT_GENERATIONS = 3;
const MAX_IDEA_LENGTH = 500;
const ERROR_JOB_TTL_MS = 5 * 60 * 1000;

const MIME = {
  ".html": "text/html",
  ".json": "application/json",
};

// Generated games are untrusted (LLM output from user-supplied ideas).
// The sandbox CSP gives them an opaque origin so they can't call our API
// with the shelf's origin or touch anything the shelf page can.
const GAME_HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts allow-pointer-lock",
};

// In-flight and recently failed jobs; finished games live in games/<slug>/.
const jobs = new Map();

function slugify(idea) {
  const base = idea
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "game";
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}-${Date.now().toString(36)}${rand}`;
}

function activeGenerations() {
  return [...jobs.values()].filter((j) => j.status === "generating").length;
}

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

async function runGeneration(slug, idea) {
  const job = { slug, idea, status: "generating", progress: 0, error: null };
  jobs.set(slug, job);
  try {
    const html = await generateGame(idea, {
      onProgress: (chars) => {
        job.progress = chars;
      },
    });
    const dir = join(GAMES_DIR, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), html);
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify(
        { slug, idea, createdAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    jobs.delete(slug); // done — the game on disk is the record now
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    console.error(`[forgecade] generation failed for "${idea}":`, err.message);
    setTimeout(() => jobs.delete(slug), ERROR_JOB_TTL_MS).unref();
  }
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function readJsonBody(req) {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw httpError(415, "Content-Type must be application/json");
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw httpError(413, "Body too large");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;

    if (req.method === "GET" && path === "/") {
      return await sendFile(res, join(PUBLIC_DIR, "index.html"));
    }

    if (req.method === "GET" && path === "/api/games") {
      const games = await listGames();
      const pending = [...jobs.values()];
      return sendJson(res, 200, { games, pending });
    }

    if (req.method === "POST" && path === "/api/generate") {
      const { idea } = await readJsonBody(req);
      if (typeof idea !== "string" || idea.trim().length < 3) {
        return sendJson(res, 400, { error: "idea missing or too short" });
      }
      if (idea.length > MAX_IDEA_LENGTH) {
        return sendJson(res, 400, {
          error: `idea longer than ${MAX_IDEA_LENGTH} characters`,
        });
      }
      if (activeGenerations() >= MAX_CONCURRENT_GENERATIONS) {
        return sendJson(res, 429, {
          error: "too many generations running — try again in a minute",
        });
      }
      const slug = slugify(idea);
      runGeneration(slug, idea.trim()); // fire and forget; UI polls /api/games
      return sendJson(res, 202, { slug });
    }

    if (req.method === "GET" && path.startsWith("/games/")) {
      const rel = normalize(path.slice("/games/".length)).replace(/^\/+/, "");
      const target = normalize(join(GAMES_DIR, rel));
      if (!target.startsWith(GAMES_DIR + sep)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const file = path.endsWith("/") ? join(target, "index.html") : target;
      const headers = file.endsWith(".html") ? GAME_HEADERS : {};
      return await sendFile(res, file, headers);
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    if (err.status) {
      return sendJson(res, err.status, { error: err.message });
    }
    console.error("[forgecade] request failed:", err);
    sendJson(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[forgecade] running on http://${HOST}:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[forgecade] warning: ANTHROPIC_API_KEY is not set — generation will fail",
    );
  }
});
