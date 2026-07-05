import { sound, burst, fireMode, avatarSVG, hashId } from "/fx.js";
import { Warmup } from "/warmup.js";

Warmup.init((data) => send({ type: "warmup", data }));

"use strict";
const $ = (id) => document.getElementById(id);
let ws = null, state = null, myId = null;
let prevPhase = null;
let clockOffset = 0;                 // server time minus local time
let phaseTimers = [];                // cleared on every phase change
let lastProgress = -1;
let bootWatch = null;                // iframe boot watchdog
let lastGameErr = 0;                 // throttles in-game error toasts
let gameEndTimer = null;
let spectatingSlug = null, freshJoin = false;
let playFlipTimer = null, lastReadySince = null;

// fixed palette for in-game player identity (V4) — bold enough for games
const PALETTE = ["#4bb956", "#ff453a", "#ff9f43", "#5b8db8", "#c76a5a", "#8a63c2", "#2f9e8f", "#b58900"];
const colorFor = (id) => PALETTE[hashId(String(id)) % PALETTE.length];
const serverNow = () => Date.now() + clockOffset;
const nameOf = (id) => state?.players.find((p) => p.id === id)?.name;
const roster = () => state.players.filter((p) => p.connected)
  .map((p) => ({ id: p.id, name: p.name, color: colorFor(p.id) }));

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
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; ws.close(); }
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = onOpen;
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    const s = session();
    if (s) setTimeout(() => connect(() => send({ type: "rejoin", ...s })), 1000);
  };
}
function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function session() {
  try { return JSON.parse(sessionStorage.getItem("forgecade")); } catch { return null; }
}
function resetToHome() {
  // stop and unload the game iframe first, or it keeps running (and playing
  // audio) invisibly on the home screen
  postToGame({ type: "pause" });
  $("gameframe").removeAttribute("src");
  hideGameEnd();
  sessionStorage.removeItem("forgecade");
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; ws.close(); ws = null; }
  phaseTimers.forEach(clearTimeout);
  phaseTimers = [];
  clearTimeout(bootWatch); bootWatch = null;
  state = null; myId = null; prevPhase = null; spectatingSlug = null;
  render();
}

function handle(msg) {
  if (msg.type === "joined") {
    myId = msg.playerId;
    sessionStorage.setItem("forgecade", JSON.stringify({
      code: msg.code, playerId: msg.playerId, token: msg.token,
    }));
  } else if (msg.type === "room") {
    clockOffset = msg.now - Date.now();
    const prev = state;
    state = msg;
    if (freshJoin) {
      freshJoin = false;
      // joined mid-game: the running game has no context for us
      if (msg.phase === "playing" && msg.currentGame) spectatingSlug = msg.currentGame.slug;
    }
    if (prev && prev.hostId !== msg.hostId && msg.phase === "playing" && msg.currentGame) {
      toast("host changed — restarting the round");
      reloadGame();
    }
    diffPlayers(prev?.players, msg.players);
    render();
  } else if (msg.type === "game") {
    postToGame({ type: "msg", data: msg.data, from: msg.from });
  } else if (msg.type === "game_end") {
    showGameEnd(msg.scores ?? {});
  } else if (msg.type === "warmup") {
    Warmup.receive(msg.data, msg.from);
  } else if (msg.type === "toast") {
    toast(msg.message);
  } else if (msg.type === "error") {
    toast(msg.message);
    resetToHome();
  }
}

function diffPlayers(prev, next) {
  if (!prev) return;
  const before = new Map(prev.map((p) => [p.id, p.connected]));
  for (const p of next) {
    if (p.id === myId) continue;
    const was = before.get(p.id);
    if (was === undefined) { toast(`${p.name} joined the forge`); sound.blip(880, 0.12, 0.07); }
    else if (was && !p.connected) { toast(`${p.name} left`); sound.blip(240, 0.16, 0.07); }
    else if (!was && p.connected) { toast(`${p.name} is back`); sound.blip(660, 0.12, 0.07); }
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
  if (!state) { show("home"); Warmup.mount($("wslot-home")); return; }
  const isHost = state.hostId === myId;
  const phase = state.phase;
  const entered = phase !== prevPhase;
  const before = prevPhase;
  prevPhase = phase;

  if (entered) {
    phaseTimers.forEach(clearTimeout);
    phaseTimers = [];
    if (before === "playing") postToGame({ type: "pause" });
    else if (phase === "playing" && before) postToGame({ type: "resume" });
  }
  if (!state.currentGame && bootWatch) { clearTimeout(bootWatch); bootWatch = null; }
  armPlayFlip();

  if (phase === "lobby") renderLobby(isHost, entered);
  else if (phase === "submitting") renderSubmitting(entered);
  else if (phase === "reveal") renderReveal(entered);
  else if (phase === "rolling") { show("rolling"); maybeRenderDice(entered); }
  else if (phase === "forging") renderForging(entered);
  else if (phase === "ready") renderReady(isHost, entered);
  else if (phase === "playing") renderPlaying(isHost, entered);
  else if (phase === "ceremony") renderCeremony(isHost, entered);

  // warm-up runner fills every waiting moment
  Warmup.setRoom(state, myId);
  if (phase === "lobby") Warmup.mount($("wslot-lobby"));
  else if (phase === "submitting" && state.submitted.includes(myId)) Warmup.mount($("wslot-submitting"));
  else if (phase === "forging") Warmup.mount($("wslot-forging"));
  else if (phase === "ready") Warmup.mount($("wslot-ready"));
  else Warmup.unmount();
}

// server unlocks play_next for everyone 45s after a game is ready (V3)
const playUnlocked = () =>
  Boolean(state?.readySince && serverNow() - state.readySince >= 45_000);

function armPlayFlip() {
  const since = state.readySince ?? null;
  if (since === lastReadySince) return;
  lastReadySince = since;
  clearTimeout(playFlipTimer);
  if (!since) return;
  const left = 45_000 - (serverNow() - since);
  if (left > 0) playFlipTimer = setTimeout(render, left + 250);
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
  $("lobby-error").textContent = state.forgeError ?? "";
  renderReplay($("lobby-replay"), isHost);
  if (entered) {
    sound.whoosh();
    rotateLine($("lobby-tip"), TIPS, 6000);
  }
}

function renderSubmitting(entered) {
  show("submitting");
  const mine = state.submitted.includes(myId);
  $("submit-row").style.display = mine ? "none" : "";
  $("my-idea").style.display = mine ? "" : "none";
  const connected = new Set(state.players.filter((p) => p.connected).map((p) => p.id));
  const done = state.submitted.filter((id) => connected.has(id)).length;
  $("submit-status").textContent =
    `${done}/${connected.size} ideas in the fire` +
    (mine ? " — waiting for the slow hammers…" : "");
  $("submit-golems").innerHTML = state.players.filter((p) => p.connected).map((p) => `
    <div class="golem-card sm ${state.submitted.includes(p.id) ? "" : "pending"}">
      ${avatarSVG(p.id)}<div class="pname">${esc(p.name)}</div>
    </div>`).join("");
  if (entered) {
    sound.whoosh();
    $("idea").placeholder = pick(PLACEHOLDERS);
    phaseTimers.push(setTimeout(() => $("idea").focus(), 300));
    let lastSec = null;
    phaseTimers.push(setInterval(() => {
      const leftMs = Math.max(0, state.deadline - serverNow());
      const sec = Math.ceil(leftMs / 1000);
      $("submit-timer").textContent = sec;
      $("submit-timer").classList.toggle("hurry", sec <= 10);
      $("fuse-bar").style.width = (leftMs / 30000) * 100 + "%";
      if (sec !== lastSec && sec <= 10 && sec > 0) sound.tick();
      lastSec = sec;
    }, 100));
  }
}

// V3 entries are {idea, by}; tolerate plain strings while pieces land
function ideaCard(entry, attrs = "") {
  const idea = entry?.idea ?? entry ?? "";
  const name = entry?.by ? nameOf(entry.by) : null;
  return `<li class="card" ${attrs}>
    ${name ? `<span class="byline">${avatarSVG(entry.by)}${esc(name)}</span>` : ""}
    ${esc(idea)}</li>`;
}

function renderReveal(entered) {
  show("reveal");
  const ideas = state.revealed ?? [];
  $("reveal-list").innerHTML = ideas
    .map((entry, n) => ideaCard(entry, `style="--d:${n * 0.35}s"`)).join("");
  if (entered) {
    ideas.forEach((_, n) => phaseTimers.push(setTimeout(() => {
      sound.clang(0.8);
      burst(0.5, 0.35 + n * 0.1, 10, 3);
    }, n * 350 + 150)));
  }
}

// re-run the dice animation on entry AND whenever the server re-rolls (the
// forge-capacity backoff keeps phase "rolling" and swaps in a new pick)
let lastRollSig = null;
function maybeRenderDice(entered) {
  const sig = state.rolling
    ? `${state.rolling.chosenIndex}:${state.rolling.options?.length}:${state.rolling.options?.map((o) => o.idea).join("|")}`
    : null;
  if (!entered && sig === lastRollSig) return;
  lastRollSig = sig;
  renderDice($("dice-list"));
}

// roulette that slows down, sometimes fakes out, then lands with a clang
function renderDice(list) {
  const { options, chosenIndex } = state.rolling ?? {};
  if (!options) return;
  list.innerHTML = options.map((o) => ideaCard(o)).join("");
  const items = [...list.children];
  let pos = 0, delay = 80, fakeout = false;
  const step = () => {
    items.forEach((el, i) => el.classList.toggle("chosen", i === pos % items.length));
    sound.drum();
    const onTarget = pos % items.length === chosenIndex;
    if (delay > 400 && onTarget) {
      if (!fakeout && items.length > 1 && Math.random() < 0.15) {
        fakeout = true; // the dice has second thoughts
        pos++; delay = 600;
        phaseTimers.push(setTimeout(step, delay));
        return;
      }
      sound.clang(1.2);
      const r = items[chosenIndex].getBoundingClientRect();
      burst((r.x + r.width / 2) / innerWidth, (r.y + r.height / 2) / innerHeight, 30, 6);
      items.forEach((el, i) => el.classList.toggle("dud", i !== chosenIndex));
      const name = nameOf(options[chosenIndex]?.by);
      if (name) toast(`the forge chose ${name}'s idea`);
      return;
    }
    pos++;
    delay = Math.min(500, delay * 1.13);
    phaseTimers.push(setTimeout(step, delay));
  };
  step();
}

function renderForging(entered) {
  show("forging");
  $("forge-idea").textContent = state.forging?.idea ?? "";
  updateForgeProgress($("forge-bar"), $("forge-kb"));
  if (entered) {
    lastProgress = -1;
    rotateLine($("forge-line"), FORGE_LINES, 3500);
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
  $("ready-title").textContent = state.readyGame?.title ?? state.readyGame?.idea ?? "";
  $("ready-idea").textContent = state.readyGame?.idea ?? "";
  const canPlay = isHost || playUnlocked();
  $("play").style.display = canPlay ? "" : "none";
  $("reforge").style.display = isHost ? "" : "none";
  $("ready-wait").style.display = canPlay ? "none" : "";
  if (entered) { sound.ding(); burst(0.5, 0.3, 40, 7); }
}

function renderPlaying(isHost, entered) {
  show("playing");
  $("top-code").textContent = state.code;
  let status = "";
  if (state.rolling) status = "🎲 the dice decides what's next…";
  else if (state.forging) status = `⚒ forging: ${state.forging.idea} — ${Math.round(state.forging.progress / 1024)} KB`;
  else if (state.readyGame) status = `✨ ready: ${state.readyGame.title ?? state.readyGame.idea}`;
  else if (state.queue.length) status = `${state.queue.length} idea(s) waiting for the fire`;
  else if (state.forgeError) status = `⚠ ${state.forgeError}`;
  else if (state.currentGame) status = `▶ ${state.currentGame.title ?? state.currentGame.idea}`;
  $("top-status").textContent = status;
  $("mini-hammer").classList.toggle("on", Boolean(state.forging));
  $("top-play").style.display = (isHost || playUnlocked()) && state.readyGame ? "" : "none";
  const idle = !state.forging && !state.readyGame && state.queue.length === 0;
  $("top-round").style.display = isHost && idle ? "" : "none";
  $("top-endnight").style.display = isHost && idle ? "" : "none";
  $("top-skip").style.display = isHost && state.currentGame ? "" : "none";
  $("top-roster").innerHTML = state.players.map((p) =>
    `<span class="top-golem ${p.connected ? "" : "off"}" title="${esc(p.name)}">${avatarSVG(p.id)}</span>`).join("");
  $("spectate-banner").hidden = !(spectatingSlug && state.currentGame?.slug === spectatingSlug);
  if (state.readyGame && !renderPlaying.dinged) { sound.ding(); renderPlaying.dinged = true; }
  if (!state.readyGame) renderPlaying.dinged = false;
  mountGame(entered);
  postToGame({ type: "players", players: roster(), isHost });
  if (entered) $("gameframe").focus();
}

function renderCeremony(isHost, entered) {
  show("ceremony");
  const totals = state.totals ?? {};
  // rank from totals so a high-scorer who already left still gets their podium
  // spot (the server keeps their points); present players fill in at 0
  const byId = new Map();
  for (const p of state.players) byId.set(p.id, { id: p.id, name: p.name, pts: 0 });
  for (const [id, pts] of Object.entries(totals)) {
    const row = byId.get(id) ?? { id, name: nameOf(id) ?? "???", pts: 0 };
    row.pts = Number(pts) || 0;
    byId.set(id, row);
  }
  const ranked = [...byId.values()].sort((a, b) => b.pts - a.pts).slice(0, 3);
  const order = [ranked[1], ranked[0], ranked[2]].filter(Boolean);
  $("podium").innerHTML = order.map((p) => {
    const place = ranked.indexOf(p) + 1;
    return `<div class="podium-slot place-${place}">
      ${avatarSVG(p.id)}
      <div class="pname">${esc(p.name)}</div>
      <div class="pedestal"><span>${place}</span><span class="pts">${p.pts} pts</span></div>
    </div>`;
  }).join("");
  $("ceremony-count").textContent = `${(state.history ?? []).length} games forged tonight`;
  $("one-more").style.display = isHost ? "" : "none";
  renderReplay($("ceremony-replay"), isHost);
  if (entered) { sound.fanfare?.(); fireMode(4); burst(0.5, 0.25, 50, 7); }
}

function renderReplay(el, isHost) {
  const hist = state.history ?? [];
  if (!isHost || hist.length === 0) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="dim">replay:</span>` +
    [...hist].reverse().slice(0, 8).map((h) =>
      `<button class="ghost chip" data-slug="${esc(h.slug)}">${esc(h.title ?? h.idea)}</button>`).join("");
}

function rotateLine(el, pool, ms) {
  let i = Math.floor(Math.random() * pool.length);
  el.textContent = pool[i];
  el.style.opacity = 1;
  phaseTimers.push(setInterval(() => {
    el.style.opacity = 0;
    setTimeout(() => { i = (i + 1) % pool.length; el.textContent = pool[i]; el.style.opacity = 1; }, 350);
  }, ms));
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// --- game iframe bridge -------------------------------------------------------
const postToGame = (m) =>
  $("gameframe").contentWindow?.postMessage({ __forgecade: true, ...m }, "*");

function armBootWatch() {
  clearTimeout(bootWatch);
  bootWatch = setTimeout(() => toast("this game won't boot — host can skip it"), 12_000);
}

function mountGame(entered) {
  const frame = $("gameframe");
  const slug = state.currentGame?.slug;
  if (!slug) return;
  const src = `/games/${encodeURIComponent(slug)}/`;
  if (frame.getAttribute("src") !== src) {
    frame.setAttribute("src", src);           // new game — load it
    armBootWatch();
  } else if (entered) {
    reloadGame();                             // replaying the same slug fresh
  }
}

function reloadGame() {
  const frame = $("gameframe");
  const src = frame.getAttribute("src");
  if (!src) return;
  frame.removeAttribute("src");
  frame.setAttribute("src", src);
  armBootWatch();
}

function showGameEnd(scores) {
  // scores arrive from the sandboxed game — coerce every value to a number
  // before it ever reaches innerHTML (the server sanitizes too; belt + braces)
  const ranked = Object.entries(scores)
    .map(([id, s]) => [id, Math.floor(Number(s)) || 0])
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  const winner = ranked[0] ? nameOf(ranked[0][0]) ?? "?" : null;
  $("gameend-name").textContent = winner ? `${winner} wins` : "round over";
  $("gameend-top").innerHTML = ranked.map(([id, s]) => `
    <div class="podium-slot">${avatarSVG(id)}
      <div class="pname">${esc(nameOf(id) ?? "?")}</div>
      <div class="pts">${s}</div>
    </div>`).join("");
  $("game-end").hidden = false;
  sound.fanfare?.();
  burst(0.5, 0.3, 60, 8);
  clearTimeout(gameEndTimer);
  gameEndTimer = setTimeout(hideGameEnd, 7000);
}
function hideGameEnd() {
  clearTimeout(gameEndTimer);
  $("game-end").hidden = true;
}
$("game-end").onclick = hideGameEnd;

window.addEventListener("message", (e) => {
  const frame = $("gameframe");
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || m.__forgecade !== true) return;
  if (m.type === "ready") {
    clearTimeout(bootWatch); bootWatch = null;
    if (!state) return;
    // every ready gets an init — the SDK dedupes (V4)
    postToGame({
      type: "init",
      ctx: {
        players: roster(),
        me: { id: myId, name: nameOf(myId) ?? "?", color: colorFor(myId) },
        isHost: state.hostId === myId,
        seed: state.epoch,
      },
    });
  } else if (m.type === "send") {
    send({ type: "game", data: m.data });
  } else if (m.type === "end") {
    // the host's result is authoritative; server broadcasts game_end back
    if (state?.hostId === myId) send({ type: "game_end", scores: m.result?.scores ?? {} });
  } else if (m.type === "error") {
    if (Date.now() - lastGameErr > 5000) {
      lastGameErr = Date.now();
      toast(`the game hiccuped: ${String(m.message ?? "unknown").slice(0, 120)}`);
    }
  }
});

$("gameframe").addEventListener("load", () => {
  if (state?.phase === "playing") $("gameframe").focus();
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

// optional ?access=… lets a locked instance (FORGECADE_ACCESS_CODE) create rooms
const accessCode = new URLSearchParams(location.search).get("access") ?? undefined;
$("create").onclick = () => {
  const name = $("name").value.trim();
  if (!name) return toast("The forge needs a name first.");
  sound.clang(1);
  connect(() => send({ type: "create", name, access: accessCode }));
};
$("join").onclick = () => {
  const name = $("name").value.trim();
  const code = $("joincode").value.trim().toUpperCase();
  if (!name) return toast("The forge needs a name first.");
  if (code.length !== 4) return toast("Room codes have 4 letters.");
  sound.clang(1);
  freshJoin = true;
  connect(() => send({ type: "join", code, name }));
};
$("start").onclick = () => { sound.whoosh(); send({ type: "start_round" }); };
$("top-round").onclick = () => send({ type: "start_round" });
$("one-more").onclick = () => { sound.whoosh(); send({ type: "start_round" }); };
$("play").onclick = () => send({ type: "play_next" });
$("top-play").onclick = () => send({ type: "play_next" });
$("top-skip").onclick = () => send({ type: "skip_game" });
$("reforge").onclick = () => send({ type: "discard_ready" });
$("top-endnight").onclick = () => send({ type: "end_night" });
$("top-leave").onclick = () => resetToHome();
$("leave-lobby").onclick = () => resetToHome();
$("copy-invite").onclick = async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/?join=${state?.code ?? ""}`);
    toast("invite link copied — send it to your crew");
  } catch {
    toast("couldn't copy — the code works too");
  }
};
for (const id of ["lobby-replay", "ceremony-replay"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("[data-slug]");
    if (b) send({ type: "play_game", slug: b.dataset.slug });
  });
}
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
$("joincode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join").click(); });

// invite links: /?join=CODE prefills the room code
const invite = new URLSearchParams(location.search).get("join");
if (invite) {
  $("joincode").value = invite.toUpperCase().slice(0, 4);
  $("name").focus();
}

fetch("/api/games")
  .then((r) => r.json())
  .then(({ total }) => {
    if (total > 0) $("forged-count").textContent =
      `${total >= 100 ? "100+" : total} game${total === 1 ? "" : "s"} forged so far`;
  })
  .catch(() => {});

// resume session after reload
const saved = session();
if (saved) connect(() => send({ type: "rejoin", ...saved }));
render();
