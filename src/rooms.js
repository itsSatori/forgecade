import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { generateGame } from "./generator.js";

const SUBMIT_MS = 30_000;
const REVEAL_MS = 8_000;
const DICE_MS = 4_000;
const MAX_IDEA_LENGTH = 500;

const rooms = new Map();

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
    revealed: room.phase === "reveal" ? [...room.ideas.values()] : null,
    rolling: room.rolling,
    forging: room.forging && { idea: room.forging.idea, progress: room.forging.progress },
    readyGame: room.readyGame,
    currentGame: room.currentGame,
    queue: room.queue.map((q) => q.idea),
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

function toReveal(room) {
  clearTimeout(room.timer);
  room.deadline = null;
  if (room.ideas.size === 0) {
    room.phase = room.currentGame ? "playing" : "lobby";
    return sync(room);
  }
  for (const [by, idea] of room.ideas) room.queue.push({ idea, by });
  room.phase = "reveal";
  sync(room);
  setTimer(room, REVEAL_MS, () => toRolling(room));
}

function toRolling(room) {
  if (room.queue.length === 0) {
    room.phase = room.currentGame ? "playing" : "lobby";
    return sync(room);
  }
  const chosenIndex = Math.floor(Math.random() * room.queue.length);
  room.rolling = { options: room.queue.map((q) => q.idea), chosenIndex };
  if (!room.currentGame) room.phase = "rolling";
  sync(room);
  setTimer(room, DICE_MS, () => startForge(room, chosenIndex));
}

async function startForge(room, index) {
  const [entry] = room.queue.splice(index, 1);
  room.rolling = null;
  room.forging = { idea: entry.idea, progress: 0 };
  if (!room.currentGame) room.phase = "forging";
  sync(room);

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
    const dir = join(room.gamesDir, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), html);
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({ slug, idea: entry.idea, createdAt: new Date().toISOString() }, null, 2),
    );
    room.forging = null;
    room.readyGame = { slug, idea: entry.idea };
    if (room.phase === "forging") room.phase = "ready";
    sync(room);
  } catch (err) {
    console.error(`[forgecade] forge failed for "${entry.idea}":`, err.message);
    room.forging = null;
    broadcast(room, { type: "toast", message: `Forge failed: ${entry.idea}` });
    if (room.queue.length > 0) return toRolling(room);
    if (!room.currentGame) room.phase = room.readyGame ? "ready" : "lobby";
    sync(room);
  }
}

function playNext(room) {
  if (!room.readyGame) return;
  room.currentGame = room.readyGame;
  room.readyGame = null;
  room.phase = "playing";
  sync(room);
  if (room.queue.length > 0 && !room.forging) toRolling(room);
}

const handlers = {
  start_round(room, player) {
    if (player.id !== room.hostId) return;
    const idleInLobby = room.phase === "lobby";
    const idleInGame = room.phase === "playing" && !room.forging && !room.readyGame && room.queue.length === 0;
    if (!idleInLobby && !idleInGame) return;
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
    if (room.ideas.size >= connectedPlayers(room).length) return toReveal(room);
    sync(room);
  },

  play_next(room, player) {
    if (player.id !== room.hostId) return;
    playNext(room);
  },

  game(room, player, msg) {
    const json = JSON.stringify({ type: "game", data: msg.data, from: player.id });
    for (const p of room.players.values()) {
      if (p.id !== player.id) p.ws?.send(json);
    }
  },
};

function joinRoom(room, ws, name) {
  const player = {
    id: randomUUID(),
    token: randomUUID(),
    name: String(name ?? "").trim().slice(0, 24) || "Anon",
    ws,
  };
  room.players.set(player.id, player);
  room.hostId ??= player.id;
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
  const alive = connectedPlayers(room);
  if (alive.length === 0) {
    // Raum eine Stunde offen halten (Rejoin nach Browser-Crash), dann weg
    clearTimeout(room.reaper);
    room.reaper = setTimeout(() => rooms.delete(room.code), 60 * 60 * 1000);
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
  sync(room);
}

export function attachRooms(server, gamesDir) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let room = null;
    let player = null;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (!room) {
        if (msg.type === "create") {
          room = {
            code: makeCode(),
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
          };
          rooms.set(room.code, room);
          player = joinRoom(room, ws, msg.name);
        } else if (msg.type === "join") {
          const target = rooms.get(String(msg.code ?? "").toUpperCase());
          if (!target) {
            return ws.send(JSON.stringify({ type: "error", message: "Raum nicht gefunden" }));
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
          player = existing;
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

      handlers[msg.type]?.(room, player, msg);
    });

    ws.on("close", () => {
      if (room && player && player.ws === ws) handleClose(room, player);
    });
  });
}
