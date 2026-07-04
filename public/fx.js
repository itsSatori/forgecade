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

// --- avatars: procedural forge golems ------------------------------------
export function hashId(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const hash = hashId;

const SKINS = ["#232323", "#7b7b7b", "#4bb956", "#ff9f43", "#5b8db8", "#c76a5a"];

export function avatarSVG(id) {
  const h = hash(id);
  const skin = SKINS[h % SKINS.length];
  const head = h % 3;          // 0 round helm, 1 bucket, 2 pot with rivets
  const eyes = (h >> 3) % 3;   // 0 dots, 1 visor, 2 sleepy
  const heads = [
    `<circle cx="32" cy="30" r="20" fill="${skin}"/><rect x="12" y="28" width="40" height="6" fill="#000" opacity=".18"/>`,
    `<rect x="14" y="12" width="36" height="38" rx="6" fill="${skin}"/><rect x="10" y="44" width="44" height="5" rx="2" fill="#000" opacity=".2"/>`,
    `<path d="M14 46 Q14 12 32 12 Q50 12 50 46 Z" fill="${skin}"/><circle cx="20" cy="40" r="2" fill="#000" opacity=".25"/><circle cx="44" cy="40" r="2" fill="#000" opacity=".25"/>`,
  ];
  const eyeSets = [
    `<circle cx="25" cy="32" r="4.4" fill="#f6f6f6"/><circle cx="39" cy="32" r="4.4" fill="#f6f6f6"/><circle cx="25" cy="32" r="2" fill="#232323"/><circle cx="39" cy="32" r="2" fill="#232323"/>`,
    `<rect x="19" y="28" width="26" height="7" rx="3.5" fill="#232323"/><rect x="21" y="30" width="9" height="3" rx="1.5" fill="#fef991"/>`,
    `<path d="M21 33 q4 -4 8 0" stroke="#f6f6f6" stroke-width="2.5" fill="none"/><path d="M35 33 q4 -4 8 0" stroke="#f6f6f6" stroke-width="2.5" fill="none"/>`,
  ];
  return `<svg viewBox="0 0 64 64" class="golem" aria-hidden="true">
    <ellipse cx="32" cy="58" rx="16" ry="4" fill="#000" opacity=".12"/>
    <rect x="22" y="44" width="20" height="12" rx="4" fill="${skin}" opacity=".85"/>
    ${heads[head]}${eyeSets[eyes]}
  </svg>`;
}

export { REDUCED };
