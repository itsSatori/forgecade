// Forgecade Warm-up Arena — a small but complete Smash-style platform
// brawler in Chrome-offline monochrome. Native-resolution rendering
// (DPR-aware), four distinct attacks, seeded random item spawns shared by
// the whole room, animated pixel golems, hitpause, screen shake, dust.
// Everyone waiting fights on the same stage. Alone? You get a sandbag.
import { sound, hashId, colorFor, GOLEM_HEADS, GOLEM_TORSO } from "/fx.js";

// logical coordinate space (canvas backing scales with element size × DPR)
const W = 720, H = 300, CELL = 2;
const F_W = 44, F_H = 38;
const GRAVITY = 0.004, MOVE_V = 0.28, JUMP_V = -0.85, FRICTION = 0.85;
const HITSTUN = 320, RESPAWN_INVULN = 1600, HITPAUSE = 55;
const INK = "#535353", GHOST = "#9e9e9e", MID = "#767676", PAPER = "#f6f6f6";

const MAIN = { l: 105, r: 615, y: 252 };
const CLOUDS = [
  { l: 144, r: 285, y: 174 },
  { l: 435, r: 576, y: 174 },
  { l: 290, r: 430, y: 99 },
];
const BLAST = { l: -70, r: W + 70, t: -100, b: H + 70 };
const SPAWNS = [
  { x: 150, y: 180 }, { x: 530, y: 180 },
  { x: 190, y: 110 }, { x: 340, y: 40 },
];

// --- moves ------------------------------------------------------------------
// m: 0 jab, 1 side smack, 2 uppercut, 3 dive
const MOVES = [
  { dmg: 7,  kx: 0.30, ky: -0.35, cd: 300, dur: 110, reach: 30, up: 0 },
  { dmg: 11, kx: 0.55, ky: -0.25, cd: 460, dur: 130, reach: 38, up: 0, lunge: 0.30 },
  { dmg: 10, kx: 0.10, ky: -0.78, cd: 460, dur: 130, reach: 26, up: -30 },
  { dmg: 13, kx: 0.18, ky: -0.55, cd: 600, dur: 400, reach: 30, up: 20 },
];

// --- pixel art: golem head/torso live in fx.js — the lobby avatar and the
// warm-up fighter are literally the same sprite -------------------------------
const HEADS = GOLEM_HEADS;
const TORSO = GOLEM_TORSO;
const LEGS_IDLE = [
  "......###....###......",
  "......###....###......",
  ".....####....####.....",
];
const LEGS_RUN1 = [
  ".....###......###.....",
  "....###........###....",
  "...###..........###...",
];
const LEGS_RUN2 = [
  ".......###..###.......",
  "........##..##........",
  ".......###..###.......",
];
const LEGS_AIR = [
  "......###..###........",
  ".......##.##..........",
  "......................",
];
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
const HAMMER = [
  "...########.",
  "..##########",
  "..##########",
  "...########.",
  ".....##.....",
  ".....##.....",
  ".....##.....",
  ".....##.....",
  ".....##.....",
];
const CLOUD_TEX = ["..##..##..##..", "##############"];

// --- module state --------------------------------------------------------------
let wrap = null, canvas = null, cx = null, raf = null, ro = null;
let scaleX = 1, scaleY = 1;
let sendFn = () => {};
let myId = null, names = {}, epoch = 0, clockOffset = 0;

function freshFighter(spawn) {
  const s = spawn ?? SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  return {
    x: s.x, y: s.y, vx: 0, vy: 0, face: 1, dmg: 0, jumps: 2,
    move: -1, atkUntil: 0, cdUntil: 0, stunUntil: 0,
    invulnUntil: 0, dropUntil: 0, diving: false, descending: true,
  };
}
let me = freshFighter();
const ghosts = new Map(); // id -> {x,y,seen, px,py,pt (prior snapshot), face,dmg,anim,hammer,atkUntil,move}
let dummy = null;
let keys = {}, lastSent = 0, lastTick = 0, hitVictims = new Set();
let touchMoveId = null, touchJumpId = null, lastTapAt = 0;
let sparks = [], dust = [], rings = [], trail = [];
let shake = 0, freezeUntil = 0, bannerUntil = 0, blinkAt = 0;
let hammer = null;        // {k, x, y, until} — the item on stage
let myHammerUntil = 0;    // holding period
const claimedHammers = new Set();

const nowMs = () => performance.now();
const roomT = () => Date.now() + clockOffset - epoch;

function seededRnd(k) {
  let s = ((epoch % 2147483647) ^ (k * 2654435761)) | 0;
  s = Math.imul(s ^ (s >>> 15), 1 | s);
  s = (s + Math.imul(s ^ (s >>> 7), 61 | s)) ^ s;
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

// --- physics ---------------------------------------------------------------------
function platforms() { return [MAIN, ...CLOUDS]; }
function onPlatform(f) {
  const feet = f.y + F_H;
  if (f.vy < 0) return null;
  if (f.x + F_W - 8 > MAIN.l && f.x + 8 < MAIN.r && Math.abs(feet - MAIN.y) < 7) return MAIN;
  if (nowMs() > f.dropUntil) {
    for (const c of CLOUDS) {
      if (f.x + F_W - 8 > c.l && f.x + 8 < c.r && Math.abs(feet - c.y) < 7) return c;
    }
  }
  return null;
}

function stepFighter(f, dt, input) {
  const t = nowMs();
  const stunned = t < f.stunUntil;
  const attacking = t < f.atkUntil;
  if (input && !stunned) {
    if (input.left) { f.vx = -MOVE_V; f.face = -1; }
    else if (input.right) { f.vx = MOVE_V; f.face = 1; }
    if (input.jump && !input._jumpHeld && f.jumps > 0 && !f.diving) {
      f.vy = JUMP_V; f.jumps--; f.descending = false;
      sound.blip(f.jumps === 1 ? 520 : 700, 0.09, 0.07);
      puffDust(f.x + F_W / 2, f.y + F_H, 3);
    }
    input._jumpHeld = input.jump;
    if (input.down && !input.attack) f.dropUntil = t + 250;
  }
  const g = f.descending ? GRAVITY * 0.22 : GRAVITY;
  f.vy += g * dt;
  if (f.diving) f.vy = Math.max(f.vy, 0.9);
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  const plat = onPlatform(f);
  if (plat) {
    const wasFalling = f.vy > 0.35 || f.diving;
    f.y = plat.y - F_H;
    f.vy = 0;
    f.jumps = 2;
    f.descending = false;
    if (f.diving) landDive(f);
    else if (wasFalling) puffDust(f.x + F_W / 2, f.y + F_H, 5);
    if (!input || (!input.left && !input.right) || stunned || attacking) f.vx *= FRICTION;
  }
}

function landDive(f) {
  f.diving = false;
  f.atkUntil = 0;
  shake = Math.max(shake, 7);
  rings.push({ x: f.x + F_W / 2, y: f.y + F_H, r: 6, life: 1 });
  puffDust(f.x + F_W / 2, f.y + F_H, 10);
  sound.drum(); sound.clang(0.7);
  // shockwave hits anyone close on the same height
  for (const [id, g] of ghosts) {
    if (nowMs() - g.seen > 4000) continue;
    if (Math.abs(g.x - f.x) < 70 && Math.abs((g.y + F_H) - (f.y + F_H)) < 24) {
      dealHit(id, g, 3);
    }
  }
  if (dummy && Math.abs(dummy.x - f.x) < 70 && Math.abs(dummy.y - f.y) < 30) {
    applyKnock(dummy, 3, Math.sign(dummy.x - f.x) || 1);
  }
}

function respawn(f) {
  Object.assign(f, freshFighter());
  f.invulnUntil = nowMs() + RESPAWN_INVULN;
}

// --- combat ----------------------------------------------------------------------
function attackBox(f, m) {
  const mv = MOVES[m];
  const cxr = f.x + F_W / 2 + f.face * (F_W / 2 + mv.reach / 2);
  const cy = f.y + F_H / 2 + mv.up;
  return { l: cxr - mv.reach / 2 - 6, r: cxr + mv.reach / 2 + 6, t: cy - 20, b: cy + 20 };
}
function bodyBox(f) {
  return { l: f.x + 6, r: f.x + F_W - 6, t: f.y, b: f.y + F_H };
}
const overlap = (a, b) => a.r > b.l && a.l < b.r && a.b > b.t && a.t < b.b;

function applyKnock(f, m, dir, boosted = false) {
  const mv = MOVES[m];
  const mult = boosted ? 1.8 : 1;
  f.dmg = Math.min(999, f.dmg + Math.round(mv.dmg * (boosted ? 1.6 : 1)));
  const scale = (1 + f.dmg / 50) * mult;
  f.vx = mv.kx * dir * scale;
  f.vy = mv.ky * scale;
  f.stunUntil = nowMs() + HITSTUN;
}

function dealHit(id, g, m) {
  if (hitVictims.has(id)) return;
  hitVictims.add(id);
  const boosted = nowMs() < myHammerUntil;
  sendFn({ hit: { to: id, m, dir: me.face, boost: boosted ? 1 : 0 } });
  burstAt(g.x + F_W / 2, g.y + F_H / 2, 8, MID);
  freezeUntil = nowMs() + HITPAUSE;
  shake = Math.max(shake, boosted ? 8 : 4);
  sound.clang(boosted ? 1.3 : 0.5 + m * 0.12);
}

function tryAttack(t) {
  if (t < me.cdUntil || t < me.stunUntil || me.diving) return;
  const airborne = me.vy !== 0 || !onPlatform(me);
  let m = 0;
  if (keys.down && airborne) m = 3;
  else if (keys.jump || keys.upAtk) m = 2;
  else if (keys.left || keys.right) m = 1;
  const mv = MOVES[m];
  me.move = m;
  me.cdUntil = t + mv.cd;
  me.atkUntil = t + mv.dur;
  hitVictims = new Set();
  if (m === 1) me.vx = me.face * (MOVE_V + mv.lunge);
  if (m === 3) { me.diving = true; sound.blip(180, 0.25, 0.1, "sawtooth"); }
  else sound.blip([300, 240, 420, 200][m], 0.07, 0.06, "sawtooth");
  sendFn({ atk: m });
}

function resolveAttack(t) {
  if (t > me.atkUntil || me.move < 0) return;
  const box = me.diving
    ? { l: me.x + 4, r: me.x + F_W - 4, t: me.y + F_H / 2, b: me.y + F_H + 16 }
    : attackBox(me, me.move);
  for (const [id, g] of ghosts) {
    if (t - g.seen > 4000) continue;
    if (overlap(box, bodyBox(g))) dealHit(id, g, me.move);
  }
  if (dummy && !hitVictims.has("sandbag") && overlap(box, bodyBox(dummy))) {
    hitVictims.add("sandbag");
    applyKnock(dummy, me.move, me.face, t < myHammerUntil);
    burstAt(dummy.x + F_W / 2, dummy.y + F_H / 2, 8, MID);
    freezeUntil = t + HITPAUSE;
    shake = Math.max(shake, 4);
    sound.clang(0.5 + me.move * 0.12);
  }
}

// --- hammer item (seeded, shared by the room) ---------------------------------------
function updateHammer(t) {
  const rt = roomT();
  if (!hammer) {
    // find the current scheduled hammer window
    for (let k = Math.max(0, Math.floor((rt - 30000) / 28000)); k <= Math.floor(rt / 28000) + 1; k++) {
      if (claimedHammers.has(k)) continue;
      const spawnT = 20000 + k * 28000 + seededRnd(k) * 9000;
      if (rt >= spawnT && rt < spawnT + 12000) {
        const plat = platforms()[Math.floor(seededRnd(k + 7) * platforms().length)];
        const x = plat.l + 20 + seededRnd(k + 13) * (plat.r - plat.l - 40);
        hammer = { k, x, y: plat.y - 26, spawnT };
        sound.blip(1568, 0.3, 0.06); sound.blip(2093, 0.4, 0.05);
        break;
      }
    }
  } else {
    if (roomT() > hammer.spawnT + 12000 || claimedHammers.has(hammer.k)) { hammer = null; return; }
    if (Math.random() < 0.05) sparks.push({ x: hammer.x + 12, y: hammer.y, vx: 0, vy: -0.03, life: 0.7, color: GHOST });
    // pickup
    if (overlap(bodyBox(me), { l: hammer.x - 6, r: hammer.x + 30, t: hammer.y - 10, b: hammer.y + 24 })) {
      claimedHammers.add(hammer.k);
      sendFn({ item: { k: hammer.k } });
      myHammerUntil = nowMs() + 8000;
      sound.blip(1046, 0.15, 0.08); sound.blip(1318, 0.25, 0.08);
      burstAt(hammer.x + 12, hammer.y + 10, 12, INK);
      hammer = null;
    }
  }
}

// --- particles ------------------------------------------------------------------------
function burstAt(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({ x, y, vx: Math.cos(a) * 0.2, vy: Math.sin(a) * 0.2 - 0.06, life: 1, color });
  }
}
function puffDust(x, y, n) {
  for (let i = 0; i < n; i++) {
    dust.push({ x: x + (Math.random() - 0.5) * 16, y: y - 2, vx: (Math.random() - 0.5) * 0.08, vy: -0.02 - Math.random() * 0.04, life: 1 });
  }
}

// --- drawing ----------------------------------------------------------------------------
function drawSprite(map, x, y, color, flip = false, cell = CELL) {
  cx.fillStyle = color;
  const w = map[0].length;
  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[r].length; c++) {
      if (map[r][c] === "#") {
        const col = flip ? w - 1 - c : c;
        cx.fillRect(x + col * cell, y + r * cell, cell, cell);
      }
    }
  }
}

function legsFor(f, t, anim) {
  if (anim === 2 || f.vy !== 0) return LEGS_AIR;
  if (anim === 1 || Math.abs(f.vx) > 0.05) return Math.floor(t / 90) % 2 ? LEGS_RUN1 : LEGS_RUN2;
  return LEGS_IDLE;
}

function drawFighter(f, id, color, t, label, dmg, opts = {}) {
  const blinkInv = t < f.invulnUntil && Math.floor(t / 100) % 2;
  if (blinkInv) return;
  const stunned = t < (f.stunUntil ?? 0) || opts.anim === 3;
  const idle = !stunned && Math.abs(f.vx ?? 0) < 0.05 && (f.vy ?? 0) === 0 && t > (f.atkUntil ?? 0);
  const bob = idle ? Math.round(Math.sin(t / 320 + (hashId(id) % 7)) * 1.5) : 0;
  const head = HEADS[hashId(id) % 3];

  cx.save();
  cx.translate(f.x + F_W / 2, f.y + F_H / 2);
  if (stunned) cx.rotate(0.18 * (f.face ?? 1));
  cx.translate(-(f.x + F_W / 2), -(f.y + F_H / 2));

  drawSprite(head, f.x, f.y + bob, color, f.face < 0);
  drawSprite(TORSO, f.x, f.y + 16 + bob, color, f.face < 0);
  drawSprite(legsFor(f, t, opts.anim), f.x, f.y + 32 + bob, color, f.face < 0);

  // forge core in the player's game color — same identity as the lobby card
  cx.fillStyle = colorFor(id);
  cx.fillRect(f.x + (f.face < 0 ? 9 : 10) * CELL, f.y + 16 + 3 * CELL + bob, 3 * CELL, 2 * CELL);

  // eyes (blink every ~3.4s)
  if (!(t > blinkAt && t < blinkAt + 130 && id === myId)) {
    cx.fillStyle = PAPER;
    const ey = f.y + 6 + bob;
    const e1 = f.face < 0 ? 5 : 11, e2 = f.face < 0 ? 9 : 15;
    cx.fillRect(f.x + e1 * CELL, ey, CELL * 2, CELL * 2);
    cx.fillRect(f.x + e2 * CELL, ey, CELL * 2, CELL * 2);
  }

  // hammer in hand
  if (opts.hammer) {
    drawSprite(HAMMER, f.x + (f.face > 0 ? F_W - 6 : -18), f.y + 6, color, f.face < 0);
  }

  // attack slashes
  const attacking = t < (f.atkUntil ?? 0);
  if (attacking && (opts.move ?? me.move) >= 0) {
    const m = opts.move ?? me.move;
    cx.fillStyle = color;
    const hx = f.x + F_W / 2 + f.face * (F_W / 2 + 8);
    const hy = f.y + F_H / 2;
    if (m === 0) for (let i = 0; i < 3; i++) cx.fillRect(hx + f.face * i * 6, hy - 2 + i * 2, 5, 3);
    if (m === 1) for (let i = 0; i < 5; i++) cx.fillRect(hx + f.face * i * 7, hy - 6 + (i % 2) * 10, 6, 4);
    if (m === 2) for (let i = 0; i < 4; i++) cx.fillRect(f.x + F_W / 2 + f.face * (6 + i * 3), f.y - 8 - i * 7, 4, 5);
    if (m === 3) for (let i = 0; i < 3; i++) cx.fillRect(f.x + 8 + i * 12, f.y + F_H + 4, 6, 4);
  }
  cx.restore();

  cx.font = "11px ui-monospace, monospace";
  cx.textAlign = "center";
  cx.fillStyle = color;
  cx.fillText(`${label} ${Math.floor(dmg)}%`, f.x + F_W / 2, f.y - 8);
}

function drawStage() {
  cx.fillStyle = INK;
  cx.fillRect(MAIN.l, MAIN.y, MAIN.r - MAIN.l, 3);
  for (let x = MAIN.l + 8; x < MAIN.r - 8; x += 26) {
    cx.fillRect(x, MAIN.y + 7 + (x % 4), 4, 2);
    cx.fillRect(x + 13, MAIN.y + 12 + (x % 3), 3, 2);
  }
  cx.globalAlpha = 0.5;
  for (const c of CLOUDS) {
    for (let x = c.l; x < c.r - 20; x += 30) drawSprite(CLOUD_TEX, x, c.y - 5, GHOST);
  }
  cx.globalAlpha = 1;
}

function drawHud(t) {
  const others = [...ghosts.entries()].filter(([, g]) => t - g.seen < 5000);
  const cards = [[myId, "YOU", me.dmg, INK, t < myHammerUntil], ...others.map(([id, g]) =>
    [id, (names[id] ?? "?").toUpperCase().slice(0, 8), g.dmg, GHOST, g.hammer])];
  if (dummy) cards.push(["sandbag", "SANDBAG", dummy.dmg, MID, false]);
  const cw = 108, total = cards.length * cw + (cards.length - 1) * 10;
  let x = (W - total) / 2;
  for (const [, label, dmg, color, hasHammer] of cards) {
    cx.strokeStyle = color;
    cx.globalAlpha = 0.9;
    cx.strokeRect(x + 0.5, H - 34.5, cw, 26);
    cx.globalAlpha = 1;
    cx.fillStyle = color;
    cx.textAlign = "left";
    cx.font = "10px ui-monospace, monospace";
    cx.fillText((hasHammer ? "⚒ " : "") + label, x + 8, H - 23);
    cx.textAlign = "right";
    cx.font = "13px ui-monospace, monospace";
    cx.fillText(`${Math.floor(dmg)}%`, x + cw - 8, H - 15);
    x += cw + 10;
  }
}

// --- main loop -----------------------------------------------------------------------------
function frame(ts) {
  raf = requestAnimationFrame(frame); // schedule first so the loop survives render exceptions
  const t = nowMs();
  const dt = Math.min(40, ts - (lastTick || ts - 16));
  lastTick = ts;
  const frozen = t < freezeUntil;

  if (!frozen) {
    stepFighter(me, dt, keys);
    if (keys.attack && !keys._atkHeld) tryAttack(t);
    keys._atkHeld = keys.attack;
    resolveAttack(t);
    updateHammer(t);
  }

  if (t > blinkAt + 3400 + (hashId(myId ?? "x") % 900)) blinkAt = t;

  // sandbag when alone
  const anyoneAlive = [...ghosts.values()].some((g) => t - g.seen < 5000);
  if (!anyoneAlive && !dummy) dummy = freshFighter();
  if (anyoneAlive) dummy = null;
  if (dummy && !frozen) {
    stepFighter(dummy, dt, null);
    const b = bodyBox(dummy);
    if (b.l < BLAST.l || b.r > BLAST.r || b.t > BLAST.b) {
      burstAt(Math.max(20, Math.min(W - 20, dummy.x)), Math.max(20, Math.min(H - 20, dummy.y)), 18, INK);
      shake = Math.max(shake, 9);
      sound.ding();
      dummy = freshFighter();
    }
  }

  // own KO
  const mb = bodyBox(me);
  if (mb.l < BLAST.l || mb.r > BLAST.r || mb.t > BLAST.b || mb.b < BLAST.t) {
    const kx = Math.max(20, Math.min(W - 20, me.x)), ky = Math.max(20, Math.min(H - 20, me.y));
    sendFn({ ko: { x: kx, y: ky } });
    burstAt(kx, ky, 22, INK);
    shake = Math.max(shake, 11);
    sound.clang(1.2); sound.ding();
    respawn(me);
  }

  // trail while flying fast
  if (Math.hypot(me.vx, me.vy) > 0.55) {
    trail.push({ x: me.x, y: me.y, face: me.face, life: 1 });
    if (trail.length > 5) trail.shift();
  }

  if (ts - lastSent > 50) {
    lastSent = ts;
    const anim = t < me.stunUntil ? 3 : t < me.atkUntil ? 2 : Math.abs(me.vx) > 0.05 ? 1 : 0;
    sendFn({ p: [Math.round(me.x), Math.round(me.y), me.face, Math.floor(me.dmg), anim, t < myHammerUntil ? 1 : 0, me.move] });
  }

  // --- render ---
  shake *= 0.86;
  const shx = (Math.random() - 0.5) * shake, shy = (Math.random() - 0.5) * shake;
  cx.setTransform(scaleX, 0, 0, scaleY, shx * scaleX, shy * scaleY);
  cx.clearRect(-20, -20, W + 40, H + 40);
  cx.fillStyle = PAPER;
  cx.fillRect(-20, -20, W + 40, H + 40);

  drawStage();

  // hammer on stage
  if (hammer) {
    const bobY = Math.sin(t / 250) * 3;
    drawSprite(HAMMER, hammer.x, hammer.y + bobY, INK);
  }

  // trail afterimages
  trail = trail.filter((p) => (p.life -= 0.08) > 0);
  for (const p of trail) {
    cx.globalAlpha = p.life * 0.18;
    drawSprite(TORSO, p.x, p.y + 16, INK, p.face < 0);
    cx.globalAlpha = 1;
  }

  // ghosts, rendered one send-interval (~60ms) in the past and interpolated
  // between the last two snapshots — remote fighters move as smoothly as the
  // local one; the delay must match the 50ms send rate so the render time
  // always falls inside the buffered snapshot pair
  for (const [id, g] of ghosts) {
    if (t - g.seen > 5000) continue;
    let gx = g.x, gy = g.y;
    const span = g.seen - g.pt;
    // skip interpolation across teleports (respawn) and stale gaps
    if (span > 0 && span < 400 && Math.hypot(g.x - g.px, g.y - g.py) < 200) {
      const k = Math.max(0, Math.min(1, (t - 60 - g.pt) / span));
      gx = g.px + (g.x - g.px) * k;
      gy = g.py + (g.y - g.py) * k;
    }
    const gf = { x: gx, y: gy, face: g.face, vx: 0, vy: g.anim === 2 ? 0.1 : 0, atkUntil: g.atkUntil ?? 0, stunUntil: g.anim === 3 ? t + 1 : 0, invulnUntil: 0 };
    drawFighter(gf, id, GHOST, t, (names[id] ?? "?").toUpperCase().slice(0, 8), g.dmg, { anim: g.anim, hammer: g.hammer, move: g.move });
  }

  // sandbag
  if (dummy) {
    cx.save();
    if (t < dummy.stunUntil) { cx.translate(dummy.x + 16, dummy.y + 20); cx.rotate(0.3); cx.translate(-(dummy.x + 16), -(dummy.y + 20)); }
    drawSprite(SANDBAG, dummy.x + 6, dummy.y + 6, MID, false, 4);
    cx.restore();
    cx.font = "11px ui-monospace, monospace";
    cx.textAlign = "center";
    cx.fillStyle = MID;
    cx.fillText(`SANDBAG ${Math.floor(dummy.dmg)}%`, dummy.x + F_W / 2, dummy.y - 6);
  }

  // spawn cloud while descending
  if (me.descending && t < me.invulnUntil) {
    cx.globalAlpha = 0.6;
    drawSprite(CLOUD_TEX, me.x + 6, me.y + F_H + 2, GHOST);
    cx.globalAlpha = 1;
  }
  drawFighter(me, myId ?? "me", INK, t, "YOU", me.dmg, { hammer: t < myHammerUntil });

  // dust, sparks, rings
  dust = dust.filter((d) => (d.life -= 0.035) > 0);
  for (const d of dust) {
    d.x += d.vx * dt; d.y += d.vy * dt;
    cx.globalAlpha = d.life * 0.5;
    cx.fillStyle = GHOST;
    cx.fillRect(Math.round(d.x), Math.round(d.y), 4, 4);
  }
  cx.globalAlpha = 1;
  sparks = sparks.filter((s) => (s.life -= 0.03) > 0);
  for (const s of sparks) {
    s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 0.0009 * dt;
    cx.fillStyle = s.color;
    cx.globalAlpha = s.life;
    cx.fillRect(Math.round(s.x), Math.round(s.y), 3, 3);
  }
  cx.globalAlpha = 1;
  rings = rings.filter((r) => (r.life -= 0.05) > 0);
  for (const r of rings) {
    r.r += 3.5;
    cx.strokeStyle = MID;
    cx.globalAlpha = r.life * 0.7;
    cx.beginPath();
    cx.ellipse(r.x, r.y, r.r, r.r * 0.3, 0, 0, Math.PI * 2);
    cx.stroke();
  }
  cx.globalAlpha = 1;

  drawHud(t);

  // intro banner
  if (t < bannerUntil) {
    const a = Math.min(1, (bannerUntil - t) / 600);
    cx.globalAlpha = a;
    cx.fillStyle = INK;
    cx.font = "26px ui-monospace, monospace";
    cx.textAlign = "center";
    cx.fillText("WARM-UP ARENA", W / 2, 48);
    cx.globalAlpha = 1;
  }
}

// --- keyboard: WASD + space attack (arrows as fallback) --------------------------------------
function keydown(e) {
  if (e.target.closest?.("input, textarea, button, select")) return;
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
function blurReset() { keys = {}; } // no stuck keys after tab switch

// --- touch: hold a side to run, tap the top half to jump, double-tap to attack ---
function pointerdown(e) {
  e.preventDefault();
  canvas.setPointerCapture?.(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  const t = nowMs();
  // double-tap = attack, but only a genuine single-finger double-tap: if another
  // finger is already holding move or jump, this is the normal move+jump combo,
  // not an attack.
  if (t - lastTapAt < 280 && touchMoveId === null && touchJumpId === null) {
    keys.attack = true; // released on pointerup
  }
  lastTapAt = t;
  if (y < H / 2) {
    touchJumpId = e.pointerId;
    keys.jump = true;
  } else {
    touchMoveId = e.pointerId;
    keys.left = x < me.x + F_W / 2;
    keys.right = !keys.left;
  }
}
function pointerup(e) {
  if (e.pointerId === touchMoveId) { touchMoveId = null; keys.left = keys.right = false; }
  if (e.pointerId === touchJumpId) { touchJumpId = null; keys.jump = false; }
  keys.attack = false;
}

function resizeBacking() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  scaleX = canvas.width / W;
  scaleY = canvas.height / H;
}

// --- public API (unchanged) --------------------------------------------------------------------
export const Warmup = {
  init(send) { sendFn = send; },

  setRoom(state, myPlayerId) {
    myId = myPlayerId;
    epoch = state.epoch ?? 0;
    if (state.now) clockOffset = state.now - Date.now();
    names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
  },

  receive(data, from) {
    const t = nowMs();
    const live = raf !== null; // unmounted: bookkeeping only, no fx
    if (data.p) {
      const prev = ghosts.get(from) ?? {};
      ghosts.set(from, {
        ...prev,
        // previous snapshot, kept for interpolated rendering
        px: prev.x ?? data.p[0], py: prev.y ?? data.p[1], pt: prev.seen ?? t,
        x: data.p[0], y: data.p[1], face: data.p[2], dmg: data.p[3],
        anim: data.p[4], hammer: !!data.p[5], move: data.p[6], seen: t,
      });
    } else if (data.atk !== undefined) {
      const g = ghosts.get(from);
      if (g) { g.atkUntil = t + (MOVES[data.atk]?.dur ?? 120); g.move = data.atk; }
      if (live) sound.blip(280, 0.05, 0.025, "sawtooth");
    } else if (data.hit && data.hit.to === myId) {
      if (!live || t < me.invulnUntil) return;
      applyKnock(me, data.hit.m, data.hit.dir, !!data.hit.boost);
      me.diving = false;
      burstAt(me.x + F_W / 2, me.y + F_H / 2, 8, INK);
      freezeUntil = t + HITPAUSE;
      shake = Math.max(shake, data.hit.boost ? 9 : 5);
      sound.clang(data.hit.boost ? 1.3 : 0.55);
    } else if (data.ko) {
      if (!live) return;
      burstAt(data.ko.x ?? W / 2, data.ko.y ?? H / 2, 18, GHOST);
      shake = Math.max(shake, 7);
      sound.ding();
    } else if (data.item) {
      claimedHammers.add(data.item.k);
      if (hammer?.k === data.item.k) hammer = null;
      const g = ghosts.get(from);
      if (g) g.hammer = true;
    }
  },

  mount(slot) {
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "warmup-wrap";
      canvas = document.createElement("canvas");
      canvas.className = "warmup";
      canvas.style.touchAction = "none"; // pointer events handle every gesture
      wrap.appendChild(canvas);
      const cap = document.createElement("div");
      cap.className = "warmup-caption";
      const coarse = matchMedia("(pointer: coarse)").matches;
      cap.innerHTML = `<span>Warm-up arena</span>
        <span class="k">${coarse
          ? "tap sides to move · tap top to jump · double-tap to attack"
          : "A/D move · W jump ×2 · S drop · SPACE attack (+dir) · grab the ⚒"}</span>`;
      wrap.appendChild(cap);
      cx = canvas.getContext("2d");
      canvas.addEventListener("pointerdown", pointerdown);
      canvas.addEventListener("pointerup", pointerup);
      canvas.addEventListener("pointercancel", pointerup);
      ro = new ResizeObserver(resizeBacking);
      ro.observe(canvas);
      bannerUntil = nowMs() + 1800;
    }
    // repeat mounts are fine: same handler refs, addEventListener dedupes
    addEventListener("keydown", keydown);
    addEventListener("keyup", keyup);
    addEventListener("blur", blurReset);
    if (wrap.parentElement !== slot) slot.appendChild(wrap);
    resizeBacking();
    if (!raf) { lastTick = 0; raf = requestAnimationFrame(frame); }
  },

  unmount() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    removeEventListener("keydown", keydown);
    removeEventListener("keyup", keyup);
    removeEventListener("blur", blurReset);
    keys = {};
    touchMoveId = touchJumpId = null;
    wrap?.remove();
  },
};
