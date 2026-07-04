import { sound, burst, fireMode, avatarSVG } from "/fx.js";

"use strict";
const $ = (id) => document.getElementById(id);
let ws = null, state = null, myId = null;
let gameCtxSent = null;
let diceTimer = null, tick = null, prevPhase = null;
let tipTimer = null, forgeLineTimer = null, lastProgress = -1;

// --- funny content pools --------------------------------------------------
const PLACEHOLDERS = [
  "sumo wrestling but everyone is a fridge",
  "cooking show hosted by angry seagulls",
  "parallel parking, but the car is a whale",
  "speed dating for haunted furniture",
  "synchronized swimming in lava",
  "tax evasion: the rhythm game",
];
const TIPS = [
  "Tip: ideas containing goats are scientifically 30% funnier.",
  "Tip: the forge accepts any idea. The forge judges silently.",
  "Tip: 'but everyone is a fridge' improves most concepts.",
  "Tip: the dice has no favorites. The dice has grudges.",
  "Tip: shorter ideas forge faster. Probably. We never checked.",
  "Tip: the anvil is load-bearing. Do not remove the anvil.",
];
const FORGE_LINES = [
  "heating pixels to 1200°C…",
  "teaching the physics engine about consequences…",
  "hammering the fun into shape…",
  "quenching bugs in cold water…",
  "negotiating with the random number generator…",
  "adding one (1) unnecessary particle effect…",
  "convincing the goats to participate…",
  "sharpening the win condition…",
];

// --- connection -------------------------------------------------------------
function connect(onOpen) {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = onOpen;
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    const s = session();
    if (s) setTimeout(() => connect(() => send({ type: "rejoin", ...s })), 1000);
  };
}
function send(msg) { ws?.send(JSON.stringify(msg)); }
function session() {
  try { return JSON.parse(sessionStorage.getItem("forgecade")); } catch { return null; }
}

function handle(msg) {
  if (msg.type === "joined") {
    myId = msg.playerId;
    sessionStorage.setItem("forgecade", JSON.stringify({
      code: msg.code, playerId: msg.playerId, token: msg.token,
    }));
  } else if (msg.type === "room") {
    state = msg;
    render();
  } else if (msg.type === "game") {
    $("gameframe").contentWindow?.postMessage(
      { __forgecade: true, type: "msg", data: msg.data, from: msg.from }, "*");
  } else if (msg.type === "toast" || msg.type === "error") {
    toast(msg.message);
    if (msg.type === "error") sessionStorage.removeItem("forgecade");
  }
}

// --- rendering ----------------------------------------------------------------
function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + view).classList.add("active");
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function render() {
  if (!state) return show("home");
  const isHost = state.hostId === myId;
  const phase = state.phase;
  const entered = phase !== prevPhase;
  prevPhase = phase;

  clearInterval(tick); tick = null;
  clearInterval(forgeLineTimer); forgeLineTimer = null;
  if (phase !== "lobby") { clearInterval(tipTimer); tipTimer = null; }

  if (phase === "lobby") renderLobby(isHost, entered);
  else if (phase === "submitting") renderSubmitting(entered);
  else if (phase === "reveal") renderReveal(entered);
  else if (phase === "rolling") { show("rolling"); if (entered) renderDice($("dice-list")); }
  else if (phase === "forging") renderForging(entered);
  else if (phase === "ready") renderReady(isHost, entered);
  else if (phase === "playing") renderPlaying(isHost, entered);
}

function renderLobby(isHost, entered) {
  show("lobby");
  $("lobby-plates").innerHTML = [...state.code]
    .map((c) => `<span class="plate">${c}</span>`).join("");
  $("lobby-players").innerHTML = state.players.map((p) => `
    <div class="golem-card ${p.connected ? "" : "off"} ${p.id === state.hostId ? "host" : ""}">
      ${avatarSVG(p.id)}<div class="pname">${esc(p.name)}</div>
    </div>`).join("");
  $("start").style.display = isHost ? "" : "none";
  $("lobby-wait").style.display = isHost ? "none" : "";
  if (entered) {
    sound.whoosh();
    rotateLine($("lobby-tip"), TIPS, 6000, (t) => { tipTimer = t; });
  }
}

function renderSubmitting(entered) {
  show("submitting");
  const mine = state.submitted.includes(myId);
  $("submit-row").style.display = mine ? "none" : "";
  $("my-idea").style.display = mine ? "" : "none";
  const total = state.players.filter((p) => p.connected).length;
  $("submit-status").textContent =
    `${state.submitted.length}/${total} ideas in the fire` +
    (mine ? " — waiting for the slow hammers…" : "");
  if (entered) { sound.whoosh(); $("idea").placeholder = pick(PLACEHOLDERS); setTimeout(() => $("idea").focus(), 300); }
  let lastSec = null;
  tick = setInterval(() => {
    const leftMs = Math.max(0, state.deadline - Date.now());
    const sec = Math.ceil(leftMs / 1000);
    $("submit-timer").textContent = sec;
    $("submit-timer").classList.toggle("hurry", sec <= 10);
    $("fuse-bar").style.width = (leftMs / 30000) * 100 + "%";
    if (sec !== lastSec && sec <= 10 && sec > 0) sound.tick();
    lastSec = sec;
  }, 100);
}

function renderReveal(entered) {
  show("reveal");
  const ideas = state.revealed ?? [];
  $("reveal-list").innerHTML = ideas
    .map((i, n) => `<li class="card" style="--d:${n * 0.35}s">${esc(i)}</li>`).join("");
  if (entered) {
    ideas.forEach((_, n) => setTimeout(() => {
      sound.clang(0.8);
      burst(0.5, 0.35 + n * 0.1, 10, 3);
    }, n * 350 + 150));
  }
}

// roulette that slows down, sometimes fakes out, then lands with a clang
function renderDice(list) {
  const { options, chosenIndex } = state.rolling ?? {};
  if (!options) return;
  list.innerHTML = options.map((i) => `<li class="card">${esc(i)}</li>`).join("");
  const items = [...list.children];
  clearTimeout(diceTimer);
  let pos = 0, delay = 80, fakeout = false;
  const step = () => {
    items.forEach((el, i) => el.classList.toggle("chosen", i === pos % items.length));
    sound.drum();
    const onTarget = pos % items.length === chosenIndex;
    if (delay > 400 && onTarget) {
      if (!fakeout && items.length > 1 && Math.random() < 0.15) {
        fakeout = true; // the dice has second thoughts
        pos++; delay = 600;
        diceTimer = setTimeout(step, delay);
        return;
      }
      sound.clang(1.2);
      const r = items[chosenIndex].getBoundingClientRect();
      burst((r.x + r.width / 2) / innerWidth, (r.y + r.height / 2) / innerHeight, 30, 6);
      items.forEach((el, i) => el.classList.toggle("dud", i !== chosenIndex));
      return;
    }
    pos++;
    delay = Math.min(500, delay * 1.13);
    diceTimer = setTimeout(step, delay);
  };
  step();
}

function renderForging(entered) {
  show("forging");
  $("forge-idea").textContent = state.forging?.idea ?? "";
  updateForgeProgress($("forge-bar"), $("forge-kb"));
  if (entered) {
    lastProgress = -1;
    rotateLine($("forge-line"), FORGE_LINES, 3500, (t) => { forgeLineTimer = t; });
  }
}

function updateForgeProgress(bar, label) {
  const p = state.forging?.progress ?? 0;
  const kb = Math.round(p / 1024);
  label.textContent = `${kb} KB of pure nonsense forged`;
  bar.style.width = Math.min(95, kb * 1.5) + "%";
  if (p > lastProgress) {
    lastProgress = p;
    strikeAnvil();
  }
}

function strikeAnvil() {
  const arm = document.querySelector("#forge-scene .arm");
  if (!arm) return;
  arm.classList.remove("strike");
  void arm.offsetWidth; // restart animation
  arm.classList.add("strike");
  setTimeout(() => {
    sound.clang(0.7);
    const scene = $("forge-scene").getBoundingClientRect();
    if (scene.width) {
      burst((scene.x + scene.width * 0.42) / innerWidth,
            (scene.y + scene.height * 0.55) / innerHeight, 14, 4);
    }
  }, 140);
}

function renderReady(isHost, entered) {
  show("ready");
  $("ready-idea").textContent = state.readyGame?.idea ?? "";
  $("play").style.display = isHost ? "" : "none";
  $("ready-wait").style.display = isHost ? "none" : "";
  if (entered) { sound.ding(); burst(0.5, 0.3, 40, 7); }
}

function renderPlaying(isHost, entered) {
  show("playing");
  $("top-code").textContent = state.code;
  let status = "";
  if (state.rolling) status = "🎲 the dice decides what's next…";
  else if (state.forging) status = `⚒ forging: ${state.forging.idea} — ${Math.round(state.forging.progress / 1024)} KB`;
  else if (state.readyGame) status = `✨ ready: ${state.readyGame.idea}`;
  else if (state.queue.length) status = `${state.queue.length} idea(s) waiting for the fire`;
  $("top-status").textContent = status;
  $("mini-hammer").classList.toggle("on", Boolean(state.forging));
  $("top-play").style.display = isHost && state.readyGame ? "" : "none";
  const canRound = isHost && !state.forging && !state.readyGame && state.queue.length === 0;
  $("top-round").style.display = canRound ? "" : "none";
  if (state.readyGame && !renderPlaying.dinged) { sound.ding(); renderPlaying.dinged = true; }
  if (!state.readyGame) renderPlaying.dinged = false;
  mountGame();
}

function rotateLine(el, pool, ms, keep) {
  let i = Math.floor(Math.random() * pool.length);
  el.textContent = pool[i];
  keep(setInterval(() => {
    el.style.opacity = 0;
    setTimeout(() => { i = (i + 1) % pool.length; el.textContent = pool[i]; el.style.opacity = 1; }, 350);
  }, ms));
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// --- game iframe bridge -------------------------------------------------------
function mountGame() {
  const frame = $("gameframe");
  const slug = state.currentGame?.slug;
  if (!slug) return;
  const src = `/games/${encodeURIComponent(slug)}/`;
  if (frame.getAttribute("src") !== src) {
    gameCtxSent = null;
    frame.setAttribute("src", src);
  }
}

window.addEventListener("message", (e) => {
  const frame = $("gameframe");
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || m.__forgecade !== true) return;
  if (m.type === "ready") {
    if (gameCtxSent === state.currentGame?.slug) return;
    gameCtxSent = state.currentGame?.slug;
    const players = state.players.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name }));
    const me = players.find((p) => p.id === myId) ?? { id: myId, name: "?" };
    frame.contentWindow.postMessage({
      __forgecade: true, type: "init",
      ctx: { players, me, isHost: state.hostId === myId },
    }, "*");
  } else if (m.type === "send") {
    send({ type: "game", data: m.data });
  } else if (m.type === "end") {
    const scores = m.result?.scores ?? {};
    const names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${names[id] ?? "?"}: ${n}`).join(" · ");
    sound.ding();
    burst(0.5, 0.15, 50, 8);
    toast(top ? `🏁 Round over — ${top}` : "🏁 Round over");
  }
});

// --- easter eggs ------------------------------------------------------------
const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
let konamiPos = 0;
addEventListener("keydown", (e) => {
  konamiPos = e.key === KONAMI[konamiPos] ? konamiPos + 1 : (e.key === KONAMI[0] ? 1 : 0);
  if (konamiPos === KONAMI.length) {
    konamiPos = 0;
    document.body.classList.add("fire-mode");
    fireMode(10);
    sound.clang(1.5); sound.ding();
    toast("🔥 OVERDRIVE — the forge remembers the old codes");
    setTimeout(() => document.body.classList.remove("fire-mode"), 10000);
  }
});

let logoClicks = 0;
$("logo").addEventListener("click", () => {
  sound.clang(0.6 + logoClicks * 0.1);
  burst(0.5, 0.2, 8 + logoClicks * 4, 4);
  if (++logoClicks === 7) {
    logoClicks = 0;
    for (let i = 0; i < 8; i++) setTimeout(() => { sound.clang(1); burst(Math.random(), 0.1, 20, 6); }, i * 150);
    toast("⚒ Achievement: Schmiedemeister. The anvil respects you now.");
  }
});

function ideaEasterEgg(text) {
  const t = text.toLowerCase();
  if (t.includes("obscurio") || t.includes("promptcade")) {
    toast("That name was taken. We checked. Twice.");
  }
}

// --- ui events -----------------------------------------------------------------
let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 5000);
}

$("mute").onclick = () => { $("mute").textContent = sound.toggleMute() ? "🔇" : "🔊"; };
$("mute").textContent = sound.muted ? "🔇" : "🔊";

$("create").onclick = () => {
  const name = $("name").value.trim();
  if (!name) return toast("The forge needs a name first.");
  sound.clang(1);
  connect(() => send({ type: "create", name }));
};
$("join").onclick = () => {
  const name = $("name").value.trim();
  const code = $("joincode").value.trim().toUpperCase();
  if (!name) return toast("The forge needs a name first.");
  if (code.length !== 4) return toast("Room codes have 4 letters.");
  sound.clang(1);
  connect(() => send({ type: "join", code, name }));
};
$("start").onclick = () => { sound.whoosh(); send({ type: "start_round" }); };
$("top-round").onclick = () => send({ type: "start_round" });
$("play").onclick = () => send({ type: "play_next" });
$("top-play").onclick = () => send({ type: "play_next" });
$("submit-idea").onclick = () => {
  const text = $("idea").value.trim();
  if (text.length < 3) return toast("The forge deserves more than that.");
  ideaEasterEgg(text);
  sound.clang(1.2);
  burst(0.5, 0.5, 20, 5);
  $("my-idea-text").textContent = text;
  send({ type: "idea", text });
  $("idea").value = "";
};
$("idea").addEventListener("keydown", (e) => { if (e.key === "Enter") $("submit-idea").click(); });
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("create").click(); });

// resume session after reload
const saved = session();
if (saved) connect(() => send({ type: "rejoin", ...saved }));
