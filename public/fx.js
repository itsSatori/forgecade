// Forgecade FX — procedural sound, particles and avatars. No external assets.
"use strict";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- audio: tiny synthesizer -------------------------------------------
let actx = null;
let muted = localStorage.getItem("forgecade-muted") === "1";

function ac() {
  if (!actx) actx = new (window.AudioContext ?? window.webkitAudioContext)();
  if (actx.state === "suspended") actx.resume();
  return actx;
}

function envGain(ctx, t0, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  g.connect(ctx.destination);
  return g;
}

function noiseBuffer(ctx, seconds) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export const sound = {
  get muted() { return muted; },
  toggleMute() {
    muted = !muted;
    localStorage.setItem("forgecade-muted", muted ? "1" : "0");
    return muted;
  },
  // hammer on anvil: noise burst + ringing metal partials
  clang(strength = 1) {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.08);
    noise.connect(envGain(ctx, t, 0.25 * strength, 0.08));
    noise.start(t);
    for (const [freq, decay] of [[523, 0.4], [1046, 0.3], [1567, 0.2]]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq * (0.98 + Math.random() * 0.04);
      o.connect(envGain(ctx, t, 0.12 * strength, decay));
      o.start(t); o.stop(t + decay);
    }
  },
  tick() {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "square"; o.frequency.value = 880;
    o.connect(envGain(ctx, t, 0.05, 0.04));
    o.start(t); o.stop(t + 0.05);
  },
  drum() {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    o.connect(envGain(ctx, t, 0.3, 0.14));
    o.start(t); o.stop(t + 0.15);
  },
  ding() {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    for (const [freq, delay] of [[1318, 0], [1975, 0.09]]) {
      const o = ctx.createOscillator();
      o.type = "sine"; o.frequency.value = freq;
      o.connect(envGain(ctx, t + delay, 0.18, 0.9));
      o.start(t + delay); o.stop(t + delay + 0.9);
    }
  },
  whoosh() {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.4);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
    noise.connect(f);
    f.connect(envGain(ctx, t, 0.2, 0.4));
    noise.start(t);
  },
  // short winner fanfare: ascending major triad + octave
  fanfare() {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    const notes = [[523, 0, 0.25], [659, 0.13, 0.25], [784, 0.26, 0.25], [1046, 0.39, 0.7]];
    for (const [freq, delay, decay] of notes) {
      const o = ctx.createOscillator();
      o.type = "triangle"; o.frequency.value = freq;
      o.connect(envGain(ctx, t + delay, 0.18, decay));
      o.start(t + delay); o.stop(t + delay + decay);
    }
  },
  // generic one-shot for game SFX
  blip(freq = 600, decay = 0.1, peak = 0.1, type = "square") {
    if (muted) return;
    const ctx = ac(), t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.connect(envGain(ctx, t, peak, decay));
    o.start(t); o.stop(t + decay);
  },
};

// --- particles: one shared canvas ---------------------------------------
const canvas = document.createElement("canvas");
canvas.id = "fx-canvas";
document.body.prepend(canvas);
const cx = canvas.getContext("2d");
let parts = [];
let emberRate = 0.06; // ambient embers per frame
let fireModeUntil = 0;

function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
addEventListener("resize", resize);
resize();

function spawnEmber() {
  parts.push({
    x: Math.random() * canvas.width,
    y: canvas.height + 6,
    vx: (Math.random() - 0.5) * 0.4,
    vy: -(0.4 + Math.random() * 0.9),
    life: 1,
    fade: 0.002 + Math.random() * 0.004,
    r: 1 + Math.random() * 2,
    hot: Math.random() < 0.3,
  });
}

export function burst(xFrac, yFrac, n = 24, speed = 5) {
  if (REDUCED) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.7);
    parts.push({
      x: xFrac * canvas.width,
      y: yFrac * canvas.height,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 2,
      life: 1,
      fade: 0.02 + Math.random() * 0.02,
      r: 1 + Math.random() * 2.5,
      hot: true,
      grav: 0.15,
    });
  }
}

export function fireMode(seconds = 10) {
  fireModeUntil = Date.now() + seconds * 1000;
}

function frame() {
  cx.clearRect(0, 0, canvas.width, canvas.height);
  const rate = Date.now() < fireModeUntil ? 3 : emberRate;
  if (!REDUCED && Math.random() < rate) spawnEmber();
  parts = parts.filter((p) => p.life > 0);
  for (const p of parts) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.grav) p.vy += p.grav;
    p.life -= p.fade;
    const radius = p.r * Math.max(0, p.life);
    if (radius <= 0) continue;
    const alpha = Math.max(0, p.life) * 0.9;
    cx.fillStyle = p.hot
      ? `rgba(255,159,67,${alpha})`
      : `rgba(123,123,123,${alpha * 0.35})`;
    cx.beginPath();
    cx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    cx.fill();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- pixel art engine ------------------------------------------------------
// One visual language for the whole product: every asset is a pixel map
// rendered as run-length-merged SVG rects with crisp edges. The lobby golem
// IS the warm-up fighter — same maps, same silhouette.

export function hashId(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const hash = hashId;

// in-game player identity — the same color follows a player from the lobby
// card through the warm-up arena into every generated game
export const PALETTE = ["#4bb956", "#ff453a", "#ff9f43", "#5b8db8", "#c76a5a", "#8a63c2", "#2f9e8f", "#b58900"];
export const colorFor = (id) => PALETTE[hashId(String(id)) % PALETTE.length];

const INK = "#232323", SUB = "#7b7b7b", PAPER = "#f6f6f6";
const GLOW = "#ff9f43", MARK = "#fef991", BLOCK2 = "#e4e4e4";

// pixel map ("#" = filled) -> SVG rects, adjacent pixels merged per row
export function px(map, color, ox = 0, oy = 0, attrs = "") {
  let out = "";
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === "#") {
        let w = 1;
        while (row[x + w] === "#") w++;
        out += `<rect x="${ox + x}" y="${oy + y}" width="${w}" height="1" fill="${color}"${attrs ? " " + attrs : ""}/>`;
        x += w;
      } else x++;
    }
  });
  return out;
}

// --- the forge golem (22 px wide) — shared with the warm-up brawler ---------
export const GOLEM_HEADS = [
  [ // round helm
    ".......########.......",
    ".....############.....",
    "....##############....",
    "...################...",
    "...################...",
    "...################...",
    "...################...",
    "....##############....",
  ],
  [ // bucket
    "...################...",
    "...################...",
    "...################...",
    "...################...",
    "...################...",
    "....##############....",
    ".....############.....",
    ".....############.....",
  ],
  [ // pot with brim
    ".........####.........",
    ".......########.......",
    ".....############.....",
    "...################...",
    "...################...",
    "..##################..",
    "...################...",
    "....##############....",
  ],
];
export const GOLEM_TORSO = [
  ".....############.....",
  "......##########......",
  "......##########......",
  ".....############.....",
  "....##############....",
  "....##############....",
  ".....############.....",
  "......##########......",
];
export const GOLEM_LEGS = [
  "......###....###......",
  "......###....###......",
  ".....####....####.....",
];

export function avatarSVG(id) {
  const h = hash(id);
  const head = GOLEM_HEADS[h % 3];
  const color = colorFor(id);
  return `<svg viewBox="-1 -2 24 25" class="golem" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="4" y="20" width="14" height="1" fill="#000" opacity=".10"/>
    ${px(head, INK, 0, 0)}
    ${px(GOLEM_TORSO, INK, 0, 8)}
    ${px(GOLEM_LEGS, INK, 0, 16)}
    <g class="golem-eyes">
      <rect x="11" y="3" width="2" height="2" fill="${PAPER}"/>
      <rect x="15" y="3" width="2" height="2" fill="${PAPER}"/>
    </g>
    <rect class="golem-core" x="10" y="11" width="3" height="2" fill="${color}"/>
  </svg>`;
}

// --- shared anvil silhouette (34 x 11) ---------------------------------------
const ANVIL_PLATE = [
  "........##########################",
  "...###############################",
  "##################################",
];
const ANVIL_BODY = [
  "..####....###############.........",
  "..........###############.........",
  "............###########...........",
  "............###########...........",
  "..........###############.........",
  "........###################.......",
  "........###################.......",
  ".......#####################......",
];

// --- home hero: the idle forge (400 x 170 viewBox, 8px cells) ----------------
export function forgeHeroSVG() {
  const C = 8;
  const at = (inner) => `<g transform="scale(${C})">${inner}</g>`;
  return at(`
    <rect x="9" y="19" width="32" height="1" fill="#000" opacity=".08"/>
    ${px(ANVIL_PLATE, INK, 8, 7)}
    ${px(ANVIL_BODY, INK, 8, 10)}
    <rect x="16" y="7" width="26" height="1" fill="${SUB}" opacity=".55"/>
    <g class="hero-work">
      <rect x="21" y="5" width="12" height="2" fill="${GLOW}"/>
      <rect x="24" y="5" width="4" height="1" fill="${MARK}"/>
    </g>
    <g class="hammer-group">
      <rect x="34" y="4" width="2" height="3" fill="${SUB}"/>
      <rect x="29" y="0" width="12" height="4" fill="${INK}"/>
      <rect x="29" y="0" width="12" height="1" fill="${SUB}" opacity=".5"/>
    </g>
    <g fill="${GLOW}">
      <rect class="hero-ember hero-ember-1" x="22" y="4" width="1" height="1"/>
      <rect class="hero-ember hero-ember-2" x="25" y="3" width="1" height="1"/>
      <rect class="hero-ember hero-ember-3" x="28" y="4" width="1" height="1"/>
    </g>
  `);
}

// --- rolling screen: pixel die -----------------------------------------------
export function dieSVG() {
  return `<svg class="pixel-die" viewBox="0 0 14 14" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="1" y="0" width="12" height="14" fill="${INK}"/>
    <rect x="0" y="1" width="14" height="12" fill="${INK}"/>
    <rect x="2" y="1" width="10" height="12" fill="${PAPER}"/>
    <rect x="1" y="2" width="12" height="10" fill="${PAPER}"/>
    <rect x="3" y="3" width="2" height="2" fill="${INK}"/>
    <rect x="6" y="6" width="2" height="2" fill="${INK}"/>
    <rect x="9" y="9" width="2" height="2" fill="${INK}"/>
  </svg>`;
}

// --- forging screen: pixel forge scene (380 x 220 viewBox, 4px cells) --------
// Keeps the class/geometry contract of the CSS animation: .arm pivots at
// (245,96), impact lands at (190,114), .anvil-top recoils, sparks fan out.
const FLAME_A = [
  ".....##.....#...",
  "..#..###...##...",
  "..##.####..##...",
  ".############...",
  ".#############..",
  "..############..",
  "...##########...",
];
const FLAME_B = [
  "...#...##.......",
  "..##..####..#...",
  "..###.####.##...",
  "..############..",
  ".#############..",
  ".############...",
  "...##########...",
];
const FLAME_CORE = [
  "....##....",
  "..######..",
  ".########.",
  "..######..",
];
export function forgeSceneSVG() {
  const C = 4;
  const cell = (inner) => `<g transform="scale(${C})">${inner}</g>`;
  const sparks = [-158, -130, -104, -78, -52, -24]
    .map((a, i) => `<g transform="translate(190 113) rotate(${a})"><rect class="spark" x="0" y="-2" width="${[7, 9, 8, 9, 7, 6][i]}" height="4"/></g>`)
    .join("");
  return `
    <rect class="glow" x="128" y="186" width="130" height="6" fill="${GLOW}" opacity=".10"/>
    <rect x="112" y="194" width="160" height="5" fill="#000" opacity=".07"/>
    <rect x="30" y="194" width="60" height="5" fill="#000" opacity=".07"/>
    ${cell(`
      <!-- fire pit -->
      <rect x="8" y="46" width="24" height="2" fill="${BLOCK2}"/>
      <rect x="9" y="48" width="22" height="3" fill="${BLOCK2}"/>
      <g class="flame-a">${px(FLAME_A, GLOW, 12, 39)}${px(FLAME_CORE, MARK, 15, 42)}</g>
      <g class="flame-b">${px(FLAME_B, GLOW, 12, 39)}${px(FLAME_CORE, MARK, 14, 42)}</g>
      <g fill="${GLOW}">
        <rect class="ember ember-1" x="16" y="40" width="1" height="1"/>
        <rect class="ember ember-2" x="21" y="39" width="1" height="1"/>
        <rect class="ember ember-3" x="14" y="41" width="1" height="1"/>
        <rect class="ember ember-4" x="24" y="40" width="1" height="1"/>
      </g>
      <!-- anvil body (static) -->
      ${px(ANVIL_BODY, INK, 31, 31)}
    `)}
    <g class="anvil-top">
      ${cell(`${px(ANVIL_PLATE, INK, 31, 28)}<rect x="39" y="28" width="24" height="1" fill="${SUB}" opacity=".5"/>`)}
      <rect class="workpiece" x="164" y="104" width="52" height="8" fill="${GLOW}"/>
      <rect x="176" y="104" width="16" height="4" fill="${MARK}" opacity=".9"/>
    </g>
    <g class="impact-flash" fill="${MARK}">
      <rect x="184" y="108" width="12" height="12"/>
      <rect x="176" y="112" width="28" height="4"/>
      <rect x="188" y="100" width="4" height="28"/>
    </g>
    <g class="shock-ring" fill="none" stroke="${MARK}" stroke-width="3">
      <path d="M182 114 h-6 M198 114 h6 M190 106 v-4 M190 122 v4 M181 108 l-4 -3 M199 108 l4 -3 M181 120 l-4 3 M199 120 l4 3"/>
    </g>
    <g class="sparks" fill="${MARK}">${sparks}</g>
    <g class="arm">
      ${cell(`
        <rect x="60" y="10" width="2" height="14" fill="${SUB}"/>
        <rect x="55" y="5" width="11" height="5" fill="${INK}"/>
        <rect x="55" y="5" width="11" height="1" fill="${SUB}" opacity=".5"/>
      `)}
    </g>`;
}

export { REDUCED };
