// Forgecade warm-up: a Chrome-offline-style pixel runner for the waiting
// room. Everyone in the room runs the same seeded obstacle course; you can
// bounce off the other players' heads. Own sprites, no external assets.
import { sound } from "/fx.js";

const W = 480, H = 130, GROUND = 108;
const GRAVITY = 0.0022, JUMP_V = -0.62, MOVE_V = 0.14, SCROLL_V = 0.15;
const CELL = 2; // sprite pixel size

// own pixel dino (not the Google one — ours has a rounder snout and a crest)
const BODY = [
  "..........#####.",
  ".........#######",
  ".........##.####",
  ".........#######",
  ".........####...",
  ".........######.",
  "#.......#####...",
  "#......######...",
  "##....#######...",
  "###.#########...",
  "#############...",
  ".###########....",
  "..#########.....",
  "...#######......",
];
const LEGS_A = ["...##....##.....", "...##.....##...."];
const LEGS_B = ["....##..##......", "....##...##....."];
const CACTUS = [
  "..##..",
  "..##.#",
  "#.##.#",
  "#.##.#",
  "#.####",
  "####..",
  "..##..",
  "..##..",
  "..##..",
];
const CLOUD = [
  "....####....",
  "..########..",
  "############",
];

const INK = "#535353", GHOST = "#b5b5b5", PAPER = "#f6f6f6";

let canvas = null, cx = null, raf = null;
let sendFn = () => {};
let players = [], myId = null, epoch = 0, clockOffset = 0;
let names = {};

// own state
let me = { x: 60, y: GROUND, vy: 0, score: 0, best: 0, stumbleUntil: 0, face: 1 };
let keys = {};
let lastSent = 0, lastTick = 0, aliveSince = 0;
// ghosts: id -> {x, y, score, stumble, seen}
const ghosts = new Map();

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = (k) => mulberry((epoch % 2147483647) + k * 7919)();

// obstacle k spawns at epoch + schedule; x depends only on synced time
function obstacleX(k, t) {
  const spawnT = 4000 + k * 1400 + rnd(k) * 900;
  return W + 10 + (spawnT - t) * SCROLL_V;
}
function cloudX(k, t) {
  const spawnT = k * 5200 + rnd(k + 999) * 4000;
  return W + 10 + (spawnT - t) * SCROLL_V * 0.3;
}

function drawSprite(map, x, y, color, flip = false) {
  cx.fillStyle = color;
  const w = map[0].length;
  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[r].length; c++) {
      if (map[r][c] === "#") {
        const col = flip ? w - 1 - c : c;
        cx.fillRect(Math.round(x + col * CELL), Math.round(y + r * CELL), CELL, CELL);
      }
    }
  }
}

function drawDino(x, y, color, frame, stumbled, face) {
  if (stumbled) {
    cx.save();
    cx.translate(Math.round(x + 16), Math.round(y + 26));
    cx.rotate(-Math.PI / 2);
    drawSprite(BODY, -16, -14, color, face < 0);
    cx.restore();
    return;
  }
  const legs = frame ? LEGS_A : LEGS_B;
  drawSprite(BODY, x, y, color, face < 0);
  drawSprite(legs, x, y + BODY.length * CELL, color, face < 0);
}

function dinoRect(x, y) {
  return { l: x + 4, r: x + 28, t: y, b: y + 32 };
}

function now() {
  return Date.now() + clockOffset - epoch;
}

function frame(ts) {
  const t = now();
  const dt = Math.min(40, ts - lastTick || 16);
  lastTick = ts;

  // --- physics (own dino) ---
  const stumbled = t < me.stumbleUntil;
  if (!stumbled) {
    if (keys.left) { me.x = Math.max(0, me.x - MOVE_V * dt); me.face = -1; }
    if (keys.right) { me.x = Math.min(W - 34, me.x + MOVE_V * dt); me.face = 1; }
    if (keys.jump && me.y >= GROUND - 32) { me.vy = JUMP_V; sound.tick(); }
  }
  me.vy += GRAVITY * dt;
  me.y = Math.min(GROUND - 32, me.y + me.vy * dt);
  if (me.y >= GROUND - 32) me.vy = 0;

  // survival score
  if (!stumbled) me.score += dt / 100;

  // --- obstacle collision ---
  const r = dinoRect(me.x, me.y);
  const kMax = Math.ceil((t - 4000) / 1400) + 2;
  for (let k = Math.max(0, kMax - 8); k < kMax; k++) {
    const ox = obstacleX(k, t);
    if (ox < -20 || ox > W + 20) continue;
    const or = { l: ox + 2, r: ox + CACTUS[0].length * CELL - 2, t: GROUND - CACTUS.length * CELL + 2, b: GROUND };
    if (!stumbled && r.r > or.l && r.l < or.r && r.b > or.t) {
      me.stumbleUntil = t + 900;
      me.best = Math.max(me.best, Math.floor(me.score));
      me.score = 0;
      sound.clang(0.5);
    }
  }

  // --- head bounce (Smash-lite) ---
  if (me.vy > 0.05) {
    for (const [id, g] of ghosts) {
      if (t - g.seen > 3000 || g.stumble) continue;
      if (Math.abs((me.x + 16) - (g.x + 16)) < 18 && Math.abs((me.y + 32) - g.y) < 8) {
        me.vy = JUMP_V * 0.75;
        sendFn({ sq: id });
        sound.tick();
      }
    }
  }

  // --- network: broadcast own state at ~8 Hz ---
  if (ts - lastSent > 125) {
    lastSent = ts;
    sendFn({ p: [Math.round(me.x), Math.round(me.y), Math.floor(me.score), stumbled ? 1 : 0] });
  }

  // --- render ---
  cx.fillStyle = PAPER;
  cx.fillRect(0, 0, W, H);

  // clouds
  cx.globalAlpha = 0.5;
  for (let k = Math.max(0, Math.ceil(t / 5200) - 4); k < Math.ceil(t / 5200) + 2; k++) {
    const x = cloudX(k, t);
    if (x > -30 && x < W + 30) drawSprite(CLOUD, x, 18 + rnd(k + 500) * 30, GHOST);
  }
  cx.globalAlpha = 1;

  // ground: line + seeded dirt specks
  cx.fillStyle = INK;
  cx.fillRect(0, GROUND, W, 1);
  const shift = Math.floor(t * SCROLL_V);
  for (let i = 0; i < 40; i++) {
    const gx = ((i * 53 + 13) - shift) % W;
    cx.fillRect((gx + W) % W, GROUND + 4 + ((i * 7) % 9), 2, 1);
  }

  // obstacles
  for (let k = Math.max(0, kMax - 8); k < kMax; k++) {
    const ox = obstacleX(k, t);
    if (ox > -20 && ox < W + 20) {
      drawSprite(CACTUS, ox, GROUND - CACTUS.length * CELL, INK);
    }
  }

  // ghosts (other players)
  cx.font = "8px ui-monospace, monospace";
  cx.textAlign = "center";
  for (const [id, g] of ghosts) {
    if (t - g.seen > 3000) continue;
    drawDino(g.x, g.y, GHOST, Math.floor(t / 120) % 2, g.stumble, 1);
    cx.fillStyle = GHOST;
    cx.fillText((names[id] ?? "?").toUpperCase().slice(0, 10), g.x + 16, g.y - 5);
  }

  // own dino
  drawDino(me.x, me.y, INK, Math.floor(t / 120) % 2, stumbled, me.face);

  // scores, Chrome style top right
  cx.fillStyle = INK;
  cx.textAlign = "right";
  cx.font = "10px ui-monospace, monospace";
  cx.fillText(String(Math.floor(me.score)).padStart(5, "0"), W - 6, 14);
  cx.fillStyle = GHOST;
  let sy = 26;
  for (const [id, g] of ghosts) {
    if (t - g.seen > 3000) continue;
    cx.fillText(`${(names[id] ?? "?").toUpperCase().slice(0, 8)} ${String(g.score).padStart(5, "0")}`, W - 6, sy);
    sy += 11;
  }

  // hint
  cx.textAlign = "left";
  cx.fillText("space jump · arrows move", 6, 14);

  raf = requestAnimationFrame(frame);
}

// --- keyboard (only while mounted, never while typing) ---------------------
function keydown(e) {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space" || e.code === "ArrowUp") { keys.jump = true; e.preventDefault(); }
  if (e.code === "ArrowLeft") keys.left = true;
  if (e.code === "ArrowRight") keys.right = true;
}
function keyup(e) {
  if (e.code === "Space" || e.code === "ArrowUp") keys.jump = false;
  if (e.code === "ArrowLeft") keys.left = false;
  if (e.code === "ArrowRight") keys.right = false;
}

// --- public API -------------------------------------------------------------
export const Warmup = {
  init(send) { sendFn = send; },

  setRoom(state, myPlayerId) {
    myId = myPlayerId;
    epoch = state.epoch ?? 0;
    if (state.now) clockOffset = state.now - Date.now();
    players = state.players;
    names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
  },

  receive(data, from) {
    if (data.p) {
      ghosts.set(from, {
        x: data.p[0], y: data.p[1], score: data.p[2], stumble: !!data.p[3],
        seen: now(),
      });
    } else if (data.sq === myId) {
      me.stumbleUntil = now() + 600; // squashed — score survives, dignity doesn't
      sound.clang(0.35);
    }
  },

  mount(slot) {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      canvas.className = "warmup";
      cx = canvas.getContext("2d");
      addEventListener("keydown", keydown);
      addEventListener("keyup", keyup);
      // touch/click = jump (for the couch laptop crowd)
      canvas.addEventListener("pointerdown", () => {
        if (me.y >= GROUND - 32) { me.vy = JUMP_V; sound.tick(); }
      });
    }
    if (canvas.parentElement !== slot) slot.appendChild(canvas);
    if (!raf) { lastTick = 0; raf = requestAnimationFrame(frame); }
  },

  unmount() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    canvas?.remove();
  },
};
