import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { generateGame } from "./generator.js";

const SUBMIT_MS = 30_000;
const DICE_MS = 4_000;
const MAX_IDEA_LENGTH = 500;
const MAX_ROOMS = 200;
const MAX_PLAYERS_PER_ROOM = 16;
const MAX_FORGES = 2; // process-wide concurrent generations
const READY_TAKEOVER_MS = 45_000; // after this, anyone may play_next
const GHOST_MS = 5 * 60_000; // disconnected this long → dropped on next round
const RELAY_RATE = 40; // game/warmup relay messages per second per connection

const rooms = new Map();

export function roomCount() {
  return rooms.size;
}

export function broadcastAll(msg) {
  for (const room of rooms.values()) broadcast(room, msg);
}

let activeForges = 0;
const forgeWaitlist = new Set(); // rooms backed off because the forge was busy

function pumpForge() {
  let free = MAX_FORGES - activeForges;
  for (const room of [...forgeWaitlist]) {
    if (free <= 0) return;
    forgeWaitlist.delete(room);
    if (
      !rooms.has(room.code) ||
      room.forging ||
      room.queue.length === 0 ||
      room.phase === "ceremony"
    ) continue;
    free--;
    toRolling(room);
  }
}

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // ohne I/O — leichter vorzulesen
  let code;
  do {
    code = Array.from(
      { length: 4 },
      () => letters[Math.floor(Math.random() * letters.length)],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function slugify(idea) {
  const base = idea
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "game";
  return `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function snapshot(room) {
  return {
    type: "room",
    now: Date.now(),
    epoch: room.createdAt,
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    deadline: room.deadline,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.ws !== null,
    })),
    submitted: [...room.ideas.keys()],
    revealed: room.phase === "reveal"
      ? [...room.ideas].map(([by, idea]) => ({ idea, by }))
      : null,
    rolling: room.rolling,
    forging: room.forging && { idea: room.forging.idea, progress: room.forging.progress },
    readyGame: room.readyGame,
    currentGame: room.currentGame,
    queue: room.queue.map((q) => ({ idea: q.idea, by: q.by })),
    totals: room.totals,
    history: room.history,
    readySince: room.readySince,
    forgeError: room.forgeError,
  };
}

function broadcast(room, msg) {
  const json = JSON.stringify(msg);
  for (const p of room.players.values()) p.ws?.send(json);
}

function sync(room) {
  broadcast(room, snapshot(room));
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.deadline = null;
    fn();
  }, ms);
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.ws !== null);
}

function allConnectedSubmitted(room) {
  const alive = connectedPlayers(room);
  return alive.length > 0 && alive.every((p) => room.ideas.has(p.id));
}

function toReveal(room) {
  clearTimeout(room.timer);
  room.deadline = null;
  if (room.ideas.size === 0) {
    room.phase = room.currentGame ? "playing" : "lobby";
    return sync(room);
  }
  const revealMs = 5000 + room.ideas.size * 1500;
  for (const [by, idea] of room.ideas) room.queue.push({ idea, by });
  room.phase = "reveal";
  sync(room);
  setTimer(room, revealMs, () => toRolling(room));
}

function toRolling(room) {
  if (room.queue.length === 0) {
    room.phase = room.currentGame ? "playing" : "lobby";
    return sync(room);
  }
  const chosenIndex = Math.floor(Math.random() * room.queue.length);
  room.rolling = {
    options: room.queue.map((q) => ({ idea: q.idea, by: q.by })),
    chosenIndex,
  };
  room.phase = room.currentGame ? "playing" : "rolling";
  sync(room);
  setTimer(room, DICE_MS, () => startForge(room, chosenIndex));
}

async function startForge(room, index) {
  if (room.forging) return; // re-entrancy guard: never run two forges for one room
  if (connectedPlayers(room).length === 0) {
    // nobody left — keep the idea queued and park the room for the reaper
    room.rolling = null;
    room.phase = room.currentGame ? "playing" : "lobby";
    return;
  }
  if (activeForges >= MAX_FORGES) {
    // idea stays queued; pumpForge re-rolls once a slot frees up
    forgeWaitlist.add(room);
    broadcast(room, { type: "toast", message: "the forge is at capacity — queued" });
    return;
  }

  const [entry] = room.queue.splice(index, 1);
  if (!entry) return;
  room.rolling = null;
  room.forging = { idea: entry.idea, progress: 0 };
  room.forgeError = null;
  room.phase = room.currentGame ? "playing" : "forging";
  sync(room);

  const started = Date.now();
  console.log(`[forgecade] ${room.code} forge start: "${entry.idea}"`);
  activeForges++;
  try {
    let lastSync = 0;
    const html = await generateGame(entry.idea, {
      onProgress: (chars) => {
        room.forging.progress = chars;
        if (Date.now() - lastSync > 1000) {
          lastSync = Date.now();
          sync(room);
        }
      },
    });
    const slug = slugify(entry.idea);
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || entry.idea;
    const dir = join(room.gamesDir, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), html);
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify(
        { slug, idea: entry.idea, title, createdAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    room.forging = null;
    room.readyGame = { slug, idea: entry.idea, title };
    room.readySince = Date.now();
    if (room.phase === "forging") room.phase = "ready";
    console.log(
      `[forgecade] ${room.code} forge done in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${(html.length / 1024).toFixed(1)} KB): ${slug}`,
    );
    sync(room);
  } catch (err) {
    console.error(`[forgecade] ${room.code} forge failed for "${entry.idea}":`, err.message);
    room.forging = null;
    room.forgeError = `the forge choked on: ${entry.idea}`;
    if (!entry.retried) {
      entry.retried = true; // one more roll, then it's out
      room.queue.push(entry);
    }
    if (room.phase === "ceremony") return sync(room);
    if (room.queue.length > 0) return toRolling(room);
    if (room.phase === "forging") room.phase = room.readyGame ? "ready" : "lobby";
    sync(room);
  } finally {
    activeForges--;
    pumpForge();
  }
}

function playNext(room) {
  if (!room.readyGame) return;
  room.currentGame = room.readyGame;
  room.readyGame = null;
  room.readySince = null;
  room.gameEnded = false;
  room.history.push({
    slug: room.currentGame.slug,
    idea: room.currentGame.idea,
    title: room.currentGame.title,
  });
  room.phase = "playing";
  sync(room);
  if (room.queue.length > 0 && !room.forging) toRolling(room);
}

const handlers = {
  start_round(room, player) {
    if (player.id !== room.hostId) return;
    // start a round only from a settled state — the same idle conditions apply
    // whether we're in the lobby, mid-game, or on the ceremony screen, or a
    // second round can be started on top of a running forge (double forge).
    const idle = !room.forging && !room.readyGame && room.queue.length === 0;
    if (!["lobby", "ceremony", "playing"].includes(room.phase) || !idle) return;
    // drop ghosts: players gone for more than five minutes
    for (const [id, p] of room.players) {
      if (p.ws === null && p.disconnectedAt && Date.now() - p.disconnectedAt > GHOST_MS) {
        room.players.delete(id);
      }
    }
    room.ideas = new Map();
    room.phase = "submitting";
    sync(room);
    setTimer(room, SUBMIT_MS, () => toReveal(room));
  },

  idea(room, player, msg) {
    if (room.phase !== "submitting") return;
    const text = String(msg.text ?? "").trim().slice(0, MAX_IDEA_LENGTH);
    if (text.length < 3) return;
    room.ideas.set(player.id, text);
    if (allConnectedSubmitted(room)) return toReveal(room);
    sync(room);
  },

  play_next(room, player) {
    if (!["ready", "playing"].includes(room.phase) || !room.readyGame) return;
    const overdue = room.readySince && Date.now() - room.readySince > READY_TAKEOVER_MS;
    if (player.id !== room.hostId && !overdue) return;
    playNext(room);
  },

  skip_game(room, player) {
    if (!["playing", "lobby", "ceremony"].includes(room.phase)) return;
    if (player.id !== room.hostId || !room.currentGame) return;
    room.currentGame = null;
    room.gameEnded = false;
    if (room.readyGame) room.phase = "ready";
    else if (room.forging) room.phase = "forging";
    else if (room.queue.length > 0) return toRolling(room);
    else room.phase = "lobby";
    sync(room);
  },

  discard_ready(room, player) {
    if (!["ready", "playing"].includes(room.phase)) return;
    if (player.id !== room.hostId || !room.readyGame) return;
    room.readyGame = null;
    room.readySince = null;
    if (room.queue.length > 0 && !room.forging) return toRolling(room);
    room.phase = room.currentGame ? "playing" : room.forging ? "forging" : "lobby";
    sync(room);
  },

  play_game(room, player, msg) {
    if (!["playing", "lobby", "ceremony"].includes(room.phase)) return;
    if (player.id !== room.hostId) return;
    const entry = room.history.find((h) => h.slug === msg.slug);
    if (!entry) return;
    room.currentGame = { ...entry };
    room.gameEnded = false;
    room.phase = "playing";
    sync(room);
  },

  end_night(room, player) {
    if (player.id !== room.hostId) return;
    clearTimeout(room.timer);
    room.deadline = null;
    room.rolling = null;
    room.currentGame = null;
    room.gameEnded = false;
    room.phase = "ceremony";
    sync(room);
  },

  game_end(room, player, msg) {
    if (player.id !== room.hostId || !room.currentGame || room.gameEnded) return;
    const raw =
      msg.scores && typeof msg.scores === "object" && !Array.isArray(msg.scores)
        ? msg.scores
        : {};
    // scores come from the untrusted game iframe — coerce every value to a
    // finite number before it touches any client (blocks HTML/XSS smuggling).
    const scores = {};
    for (const id of Object.keys(raw)) scores[id] = Number(raw[id]) || 0;
    room.gameEnded = true;
    broadcast(room, { type: "game_end", scores, from: player.id });
    // placement points: best score +3, second +2, third +1; ties share
    const entries = Object.entries(scores)
      .filter(([id]) => room.players.has(id))
      .map(([id, s]) => [id, s]);
    const distinct = [...new Set(entries.map(([, s]) => s))].sort((a, b) => b - a);
    for (const [id, s] of entries) {
      const points = [3, 2, 1][distinct.indexOf(s)] ?? 0;
      if (points) room.totals[id] = (room.totals[id] ?? 0) + points;
    }
    sync(room);
  },

  game(room, player, msg) {
    const json = JSON.stringify({ type: "game", data: msg.data, from: player.id });
    for (const p of room.players.values()) {
      if (p.id !== player.id) p.ws?.send(json);
    }
  },

  // separate channel for the built-in warm-up mini game (lobby / waiting)
  warmup(room, player, msg) {
    const json = JSON.stringify({ type: "warmup", data: msg.data, from: player.id });
    for (const p of room.players.values()) {
      if (p.id !== player.id) p.ws?.send(json);
    }
  },
};

const HOST_GRACE_MS = 5000; // matches the reload grace in handleClose

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host?.ws != null) return; // host is connected — nothing to do
  const alive = connectedPlayers(room);
  if (alive.length === 0) return;
  // Reassign only if the host is gone for good or has been away longer than the
  // reload grace. A fresh reload (recent disconnectedAt) keeps the crown — the
  // hostGrace timer in handleClose decides once the grace elapses. Otherwise the
  // first player to reconnect during a mass reconnect would steal the host role.
  if (!host || (host.disconnectedAt && Date.now() - host.disconnectedAt > HOST_GRACE_MS)) {
    room.hostId = alive[0].id;
  }
}

function joinRoom(room, ws, name) {
  const player = {
    id: randomUUID(),
    token: randomUUID(),
    name: String(name ?? "").trim().slice(0, 24) || "Anon",
    ws,
    disconnectedAt: null,
  };
  room.players.set(player.id, player);
  room.hostId ??= player.id;
  ensureHost(room);
  ws.send(JSON.stringify({
    type: "joined",
    code: room.code,
    playerId: player.id,
    token: player.token,
  }));
  sync(room);
  return player;
}

function handleClose(room, player) {
  player.ws = null;
  player.disconnectedAt = Date.now();
  const alive = connectedPlayers(room);
  if (alive.length === 0) {
    // Raum eine Stunde offen halten (Rejoin nach Browser-Crash), dann weg
    clearTimeout(room.reaper);
    room.reaper = setTimeout(() => {
      clearTimeout(room.timer);
      clearTimeout(room.hostGrace);
      forgeWaitlist.delete(room);
      rooms.delete(room.code);
      console.log(`[forgecade] room ${room.code} reaped`);
    }, 60 * 60 * 1000);
    room.reaper.unref();
    return;
  }
  // Host-Wechsel erst nach Karenzzeit — ein Seiten-Reload soll die
  // Host-Rolle nicht kosten (Rejoin kommt typischerweise in <5s zurück).
  if (player.id === room.hostId) {
    clearTimeout(room.hostGrace);
    room.hostGrace = setTimeout(() => {
      const stillAlive = connectedPlayers(room);
      if (stillAlive.length > 0 && !stillAlive.some((p) => p.id === room.hostId)) {
        room.hostId = stillAlive[0].id;
        sync(room);
      }
    }, 5000);
    room.hostGrace.unref();
  }
  if (room.phase === "submitting" && allConnectedSubmitted(room)) return toReveal(room);
  sync(room);
}

export function attachRooms(server, gamesDir, { accessCode } = {}) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
  wss.on("error", (err) => console.warn("[forgecade] wss error:", err.message));

  // keepalive: keeps idle sockets alive through reverse proxies and
  // terminates dead clients (which triggers the normal close handling)
  const pinger = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  pinger.unref();

  wss.on("connection", (ws) => {
    let room = null;
    let player = null;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("error", (err) => console.warn("[forgecade] ws error:", err.message));

    // token bucket for the game/warmup relay — excess is dropped silently
    let relayTokens = RELAY_RATE;
    let relayStamp = Date.now();
    const allowRelay = () => {
      const now = Date.now();
      relayTokens = Math.min(RELAY_RATE, relayTokens + ((now - relayStamp) / 1000) * RELAY_RATE);
      relayStamp = now;
      if (relayTokens < 1) return false;
      relayTokens -= 1;
      return true;
    };

    ws.on("message", (raw) => {
      try {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (!room) {
          if (msg.type === "create") {
            if (rooms.size >= MAX_ROOMS) {
              return ws.send(JSON.stringify({ type: "error", message: "server is full" }));
            }
            if (accessCode && msg.access !== accessCode) {
              return ws.send(JSON.stringify({ type: "error", message: "wrong access code" }));
            }
            room = {
              code: makeCode(),
              createdAt: Date.now(),
              gamesDir,
              players: new Map(),
              hostId: null,
              phase: "lobby",
              ideas: new Map(),
              queue: [],
              rolling: null,
              forging: null,
              readyGame: null,
              currentGame: null,
              deadline: null,
              timer: null,
              reaper: null,
              hostGrace: null,
              totals: {},
              history: [],
              readySince: null,
              forgeError: null,
              gameEnded: false,
            };
            rooms.set(room.code, room);
            console.log(`[forgecade] room ${room.code} created`);
            player = joinRoom(room, ws, msg.name);
          } else if (msg.type === "join") {
            const target = rooms.get(String(msg.code ?? "").toUpperCase());
            if (!target) {
              return ws.send(JSON.stringify({ type: "error", message: "Raum nicht gefunden" }));
            }
            if (target.players.size >= MAX_PLAYERS_PER_ROOM) {
              return ws.send(JSON.stringify({ type: "error", message: "room is full" }));
            }
            room = target;
            clearTimeout(room.reaper);
            player = joinRoom(room, ws, msg.name);
          } else if (msg.type === "rejoin") {
            const target = rooms.get(String(msg.code ?? "").toUpperCase());
            const existing = target?.players.get(msg.playerId);
            if (!existing || existing.token !== msg.token) {
              return ws.send(JSON.stringify({ type: "error", message: "Rejoin fehlgeschlagen" }));
            }
            room = target;
            clearTimeout(room.reaper);
            existing.ws?.close();
            existing.ws = ws;
            existing.disconnectedAt = null;
            player = existing;
            ensureHost(room);
            ws.send(JSON.stringify({
              type: "joined",
              code: room.code,
              playerId: player.id,
              token: player.token,
            }));
            sync(room);
          }
          return;
        }

        if ((msg.type === "game" || msg.type === "warmup") && !allowRelay()) return;
        if (Object.hasOwn(handlers, msg.type)) handlers[msg.type](room, player, msg);
      } catch (err) {
        console.warn("[forgecade] message handling failed:", err);
      }
    });

    ws.on("close", () => {
      if (room && player && player.ws === ws) handleClose(room, player);
    });
  });
}
