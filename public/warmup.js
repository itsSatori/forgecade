// Forgecade warm-up: a tiny Smash-style platform brawler in Chrome-offline
// pixel monochrome. Everyone in the room fights on the same stage while
// waiting — each player as their own golem (same head shapes as the lobby
// avatars). Percent damage, growing knockback, blast zones. No scoreboard,
// just violence. Alone? You get a sandbag.
import { sound, hashId } from "/fx.js";

const W = 480, H = 200, CELL = 2;
const F_W = 32, F_H = 30;
const GRAVITY = 0.0025, MOVE_V = 0.17, JUMP_V = -0.52, FRICTION = 0.86;
const ATK_MS = 120, ATK_CD = 380, HITSTUN = 320, RESPAWN_INVULN = 1500;
const INK = "#535353", GHOST = "#9e9e9e", MID = "#767676", PAPER = "#f6f6f6";

// stage: one main platform with open edges + three one-way clouds
const MAIN = { l: 70, r: 410, y: 168 };
const CLOUDS = [
  { l: 96, r: 190, y: 116 },
  { l: 290, r: 384, y: 116 },
  { l: 193, r: 287, y: 66 },
];
const BLAST = { l: -50, r: W + 50, t: -70, b: H + 50 };

// pixel golems — head variants match the lobby avatars (hash % 3)
const GOLEM_BODIES = [
  [ // 0: round helm
    "....########....",
    "..############..",
    ".##############.",
    ".##..######..##.",
    ".##############.",
    ".##############.",
    "..############..",
    "....########....",
    "...##########...",
    "...##########...",
    "...##########...",
    "....########....",
  ],
  [ // 1: bucket
    "..############..",
    "..############..",
    "..##..####..##..",
    "..############..",
    "..############..",
    "...##########...",
    ".....######.....",
    "....########....",
    "...##########...",
    "...##########...",
    "...##########...",
    "....########....",
  ],
  [ // 2: pot with rivets
    "......####......",
    "....########....",
    "..############..",
    ".##..######..##.",
    ".##############.",
    ".#.##########.#.",
    "..############..",
    "....########....",
    "...##########...",
    "...##########...",
    "...##########...",
    "....########....",
  ],
];
const LEGS_A = ["....##....##....", "...###....###..."];
const LEGS_B = ["...##......##...", "...##......##..."];
const SANDBAG = [
  ".######.",
  "########",
  "##.##.##",
  "########",
  "########",
  "##....##",
  "########",
  ".######.",
];
const CLOUD_TEX = ["..##..##..##..", "##############"];

let canvas = null, cx = null, raf = null;
let sendFn = () => {};
let myId = null, names = {};

function freshFighter(x) {
  return {
    x, y: 40, vx: 0, vy: 0, face: 1, dmg: 0, jumps: 2,
    atkUntil: 0, cdUntil: 0, stunUntil: 0, invulnUntil: 0, dropUntil: 0,
  };
}
let me = freshFighter(140);
const ghosts = new Map(); // id -> {x,y,face,dmg,atk,seen}
let dummy = null;         // sandbag when alone
let keys = {}, lastSent = 0, lastTick = 0, hitVictims = new Set();
let sparks = [];

const nowMs = () => performance.now();

// --- physics -----------------------------------------------------------------
function onPlatform(f) {
  const feet = f.y + F_H;
  if (f.vy < 0) return null;
  if (f.x + 26 > MAIN.l && f.x + 6 < MAIN.r && Math.abs(feet - MAIN.y) < 6) return MAIN;
  if (nowMs() > f.dropUntil) {
    for (const c of CLOUDS) {
      if (f.x + 26 > c.l && f.x + 6 < c.r && Math.abs(feet - c.y) < 6) return c;
    }
  }
  return null;
}

function stepFighter(f, dt, input) {
  const t = nowMs();
  const stunned = t < f.stunUntil;
  if (input && !stunned) {
    if (input.left) { f.vx = -MOVE_V; f.face = -1; }
    else if (input.right) { f.vx = MOVE_V; f.face = 1; }
    if (input.jump && !input._jumpHeld && f.jumps > 0) {
      f.vy = JUMP_V; f.jumps--; sound.tick();
    }
    input._jumpHeld = input.jump;
    if (input.down) f.dropUntil = t + 250;
  }
  f.vy += GRAVITY * dt;
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  const plat = onPlatform(f);
  if (plat) {
    f.y = plat.y - F_H;
    f.vy = 0;
    f.jumps = 2;
    if (!input || (!input.left && !input.right) || stunned) f.vx *= FRICTION;
  }
}

function respawn(f) {
  Object.assign(f, freshFighter(210 + Math.random() * 60));
  f.invulnUntil = nowMs() + RESPAWN_INVULN;
}

function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({ x, y, vx: Math.cos(a) * 0.15, vy: Math.sin(a) * 0.15 - 0.05, life: 1, color });
  }
}

// --- combat -------------------------------------------------------------------
function attackBox(f) {
  return { l: f.x + 16 + f.face * 22 - 13, r: f.x + 16 + f.face * 22 + 13, t: f.y + 2, b: f.y + 28 };
}
function bodyBox(f) {
  return { l: f.x + 4, r: f.x + 28, t: f.y, b: f.y + F_H };
}
function overlap(a, b) {
  return a.r > b.l && a.l < b.r && a.b > b.t && a.t < b.b;
}
function knock(f, kx, ky, dmg, t) {
  f.dmg = Math.min(999, f.dmg + dmg);
  const scale = 1 + f.dmg / 55;
  f.vx = kx * scale;
  f.vy = ky * scale;
  f.stunUntil = t + HITSTUN;
}

function tryAttack(t) {
  if (t < me.cdUntil || t < me.stunUntil) return;
  me.cdUntil = t + ATK_CD;
  me.atkUntil = t + ATK_MS;
  hitVictims = new Set();
  sendFn({ atk: 1 });
  sound.whoosh();
}

function resolveAttack(t) {
  if (t > me.atkUntil) return;
  const box = attackBox(me);
  for (const [id, g] of ghosts) {
    if (hitVictims.has(id) || t - g.seen > 4000) continue;
    if (overlap(box, bodyBox(g))) {
      hitVictims.add(id);
      sendFn({ hit: { to: id, kx: me.face * 0.22, ky: -0.3, dmg: 9 } });
      burst(g.x + 16, g.y + 16, 6, MID);
      sound.clang(0.4);
    }
  }
  if (dummy && !hitVictims.has("sandbag") && overlap(box, bodyBox(dummy))) {
    hitVictims.add("sandbag");
    knock(dummy, me.face * 0.22, -0.3, 9, t);
    burst(dummy.x + 16, dummy.y + 16, 6, MID);
    sound.clang(0.4);
  }
}

// --- render -------------------------------------------------------------------
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

function drawFighter(f, id, color, t, label, dmg) {
  const blink = t < f.invulnUntil && Math.floor(t / 100) % 2;
  if (blink) return;
  const body = GOLEM_BODIES[hashId(id) % 3];
  const legs = Math.abs(f.vx) > 0.02 && f.vy === 0 ? (Math.floor(t / 100) % 2 ? LEGS_A : LEGS_B) : LEGS_A;
  drawSprite(body, f.x, f.y, color, f.face < 0);
  drawSprite(legs, f.x, f.y + body.length * CELL, color, f.face < 0);
  // attack slash
  if (t < f.atkUntil) {
    cx.fillStyle = color;
    const ax = f.x + 16 + f.face * 24;
    for (let i = 0; i < 4; i++) {
      cx.fillRect(Math.round(ax + f.face * i * 2), Math.round(f.y + 6 + i * 5), 3, 3);
    }
  }
  cx.font = "8px ui-monospace, monospace";
  cx.textAlign = "center";
  cx.fillStyle = color;
  cx.fillText(`${label} ${Math.floor(dmg)}%`, f.x + 16, f.y - 5);
}

function drawStage() {
  cx.fillStyle = INK;
  cx.fillRect(MAIN.l, MAIN.y, MAIN.r - MAIN.l, 2);
  for (let x = MAIN.l + 6; x < MAIN.r - 6; x += 24) {
    cx.fillRect(x, MAIN.y + 5 + (x % 3), 3, 1);
    cx.fillRect(x + 11, MAIN.y + 9 + (x % 2), 2, 1);
  }
  cx.globalAlpha = 0.55;
  for (const c of CLOUDS) {
    for (let x = c.l; x < c.r - 12; x += 24) drawSprite(CLOUD_TEX, x, c.y - 4, GHOST);
  }
  cx.globalAlpha = 1;
}

// --- main loop ------------------------------------------------------------------
function frame(ts) {
  const t = nowMs();
  const dt = Math.min(40, ts - (lastTick || ts - 16));
  lastTick = ts;

  stepFighter(me, dt, keys);
  if (keys.attack && !keys._atkHeld) tryAttack(t);
  keys._atkHeld = keys.attack;
  resolveAttack(t);

  // sandbag appears when nobody else is around
  const anyoneAlive = [...ghosts.values()].some((g) => t - g.seen < 5000);
  if (!anyoneAlive && !dummy) dummy = freshFighter(300);
  if (anyoneAlive) dummy = null;
  if (dummy) {
    stepFighter(dummy, dt, null);
    const b = bodyBox(dummy);
    if (b.l < BLAST.l || b.r > BLAST.r || b.t > BLAST.b) {
      burst(Math.max(10, Math.min(W - 10, dummy.x)), Math.max(10, Math.min(H - 10, dummy.y)), 14, INK);
      sound.ding();
      dummy = freshFighter(300);
    }
  }

  // own KO?
  const mb = bodyBox(me);
  if (mb.l < BLAST.l || mb.r > BLAST.r || mb.t > BLAST.b || mb.b < BLAST.t) {
    const kx = Math.max(10, Math.min(W - 10, me.x));
    const ky = Math.max(10, Math.min(H - 10, me.y));
    sendFn({ ko: { x: kx, y: ky } });
    burst(kx, ky, 16, INK);
    sound.clang(1.1);
    respawn(me);
  }

  if (ts - lastSent > 100) {
    lastSent = ts;
    sendFn({ p: [Math.round(me.x), Math.round(me.y), me.face, Math.floor(me.dmg), t < me.atkUntil ? 1 : 0] });
  }

  // --- draw ---
  cx.fillStyle = PAPER;
  cx.fillRect(0, 0, W, H);
  drawStage();

  for (const [id, g] of ghosts) {
    if (t - g.seen > 5000) continue;
    const gf = { x: g.x, y: g.y, face: g.face, vx: 0, vy: 0, atkUntil: g.atk ? t + 1 : 0, invulnUntil: 0 };
    drawFighter(gf, id, GHOST, t, (names[id] ?? "?").toUpperCase().slice(0, 8), g.dmg);
  }
  if (dummy) {
    drawSprite(SANDBAG, dummy.x + 8, dummy.y + 14, MID);
    cx.font = "8px ui-monospace, monospace";
    cx.textAlign = "center";
    cx.fillStyle = MID;
    cx.fillText(`SANDBAG ${Math.floor(dummy.dmg)}%`, dummy.x + 16, dummy.y + 6);
  }
  drawFighter(me, myId ?? "me", INK, t, "YOU", me.dmg);

  // sparks
  sparks = sparks.filter((s) => s.life > 0);
  for (const s of sparks) {
    s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 0.0008 * dt; s.life -= 0.03;
    cx.fillStyle = s.color;
    cx.fillRect(Math.round(s.x), Math.round(s.y), 2, 2);
  }

  cx.font = "10px ui-monospace, monospace";
  cx.textAlign = "left";
  cx.fillStyle = GHOST;
  cx.fillText("a/d move · w jump ×2 · s drop · space attack", 6, 14);

  raf = requestAnimationFrame(frame);
}

// --- keyboard: WASD + space attack (arrows work too) ----------------------------
function keydown(e) {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "KeyW" || e.code === "ArrowUp") { keys.jump = true; e.preventDefault(); }
  if (e.code === "KeyA" || e.code === "ArrowLeft") { keys.left = true; e.preventDefault(); }
  if (e.code === "KeyD" || e.code === "ArrowRight") { keys.right = true; e.preventDefault(); }
  if (e.code === "KeyS" || e.code === "ArrowDown") { keys.down = true; e.preventDefault(); }
  if (e.code === "Space") { keys.attack = true; e.preventDefault(); }
}
function keyup(e) {
  if (e.code === "KeyW" || e.code === "ArrowUp") keys.jump = false;
  if (e.code === "KeyA" || e.code === "ArrowLeft") keys.left = false;
  if (e.code === "KeyD" || e.code === "ArrowRight") keys.right = false;
  if (e.code === "KeyS" || e.code === "ArrowDown") keys.down = false;
  if (e.code === "Space") keys.attack = false;
}

// --- public API (unchanged) ---------------------------------------------------------
export const Warmup = {
  init(send) { sendFn = send; },

  setRoom(state, myPlayerId) {
    myId = myPlayerId;
    names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
  },

  receive(data, from) {
    const t = nowMs();
    if (data.p) {
      ghosts.set(from, { x: data.p[0], y: data.p[1], face: data.p[2], dmg: data.p[3], atk: !!data.p[4], seen: t });
    } else if (data.atk) {
      const g = ghosts.get(from);
      if (g) { g.atk = true; setTimeout(() => { g.atk = false; }, ATK_MS); }
    } else if (data.hit && data.hit.to === myId) {
      if (t < me.invulnUntil) return;
      knock(me, data.hit.kx, data.hit.ky, data.hit.dmg, t);
      burst(me.x + 16, me.y + 16, 6, INK);
      sound.clang(0.45);
    } else if (data.ko) {
      burst(data.ko.x ?? W / 2, data.ko.y ?? H / 2, 16, GHOST);
      sound.ding();
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
      canvas.addEventListener("pointerdown", () => {
        if (me.jumps > 0) { me.vy = JUMP_V; me.jumps--; sound.tick(); }
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
