// Plays a generated game before the party ever sees it.
//
// The validator only proves the JavaScript parses. Every game that shipped a
// dead title screen parsed perfectly — the defects were unreachable start
// gates, host-only code paths and broken state decoding, none of which a
// parser can see. This runs the real thing instead: headless Chrome, the real
// SDK, the real sandbox headers, N players in N frames relaying messages the
// way the server does, and a click in every frame.
//
// Judged on four signals, in order of how much they matter:
//   boot     every frame reached Forgecade.init and got its ctx
//   quiet    no frame reported an uncaught error (catches client-only crashes:
//            a host-authoritative game is two code paths and only one of them
//            runs on the host's machine)
//   finished the host reached Forgecade.end, i.e. the round actually resolves.
//            This is the one signal that cannot be faked: a game stuck on its
//            poster still animates its background and its host loop may still
//            broadcast state, so neither pixels nor traffic prove anything.
//   moving   the picture is still changing during play, i.e. it did not freeze
//
// Chrome is driven over CDP directly; ws is already a dependency, so this adds
// no new package. Chrome itself must be installed (see findChrome).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { GAME_HEADERS } from "./game-headers.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CHROME_CANDIDATES = [
  process.env.FORGECADE_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);

async function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { await access(p); return p; } catch { /* keep looking */ }
  }
  throw new Error(
    "no Chrome/Chromium found — install one or set FORGECADE_CHROME to its path",
  );
}

// Serves the harness, the real SDK and the candidate game. The game is served
// under the production CSP so the opaque origin (and everything it breaks) is
// part of the test.
async function serveGame(html) {
  const harness = await readFile(join(ROOT, "test", "harness.html"));
  const sdk = await readFile(join(ROOT, "public", "forgecade-sdk.js"));
  // The autoplayer rides in front of the SDK on the test server only. Games
  // request /forgecade-sdk.js anyway, so nothing about the document changes —
  // and public/forgecade-sdk.js stays clean, so no real party ever gets a bot.
  const probe = await readFile(join(ROOT, "test", "probe.js"));
  const sdkBundle = Buffer.concat([probe, Buffer.from("\n"), sdk]);
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/" || path === "/harness.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(harness);
    }
    if (path === "/forgecade-sdk.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(sdkBundle);
    }
    if (path === "/game/" || path === "/game/index.html") {
      res.writeHead(200, { "Content-Type": "text/html", ...GAME_HEADERS });
      return res.end(html);
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

// Minimal CDP client: request/response by id, events ignored.
function cdpClient(url) {
  const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
        }, 30000).unref();
      });
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chromeEndpoint(port, deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome did not expose its debugging port in time");
}

/**
 * Runs one game and reports whether it is fit to put in front of players.
 * Returns { passed, checks, errors, detail } — never throws for a bad game,
 * only for a broken setup (no Chrome, no port).
 */
export async function smokeTest(html, { players = 2, playSeconds = 180, width = 1280, height = 800, screenshotPath = null } = {}) {
  const chromePath = await findChrome();
  const { server, port } = await serveGame(html);
  const profile = await mkdtemp(join(tmpdir(), "forgecade-smoke-"));
  const debugPort = 9333 + Math.floor(Math.random() * 400);

  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--mute-audio", "--hide-scrollbars",
    // deterministic frames; without this the sampler can race the compositor
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "about:blank",
  ], { stdio: "ignore" });

  const errors = [];
  const checks = { boot: false, quiet: false, finished: false, moving: false };
  // raw numbers behind the verdict — printed so a wrong call can be diagnosed
  const signals = { sceneShift: null, broadcast: null, playSeconds,
    scoreSpread: null, scored: null, guestShare: null, payloadKinds: null, firstSendAt: null,
    rawScores: null };
  let detail = "";

  try {
    const browserWs = await chromeEndpoint(debugPort);
    const browser = cdpClient(browserWs);
    await browser.ready;

    const { targetId } = await browser.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/harness.html?players=${players}`,
    });
    // Talk to the page on its own socket rather than routing through the
    // browser session — fewer moving parts, no sessionId plumbing.
    browser.close();
    const cdp = cdpClient(`ws://127.0.0.1:${debugPort}/devtools/page/${targetId}`);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const evaluate = async (expression) => {
      const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
      return res.result.value;
    };
    const state = () => evaluate(
      "JSON.stringify({ready:HARNESS.ready,errors:HARNESS.errors,sends:HARNESS.sends," +
      "ended:HARNESS.ended,guestSends:HARNESS.guestSends,payloadKeys:HARNESS.payloadKeys," +
      "firstSendAt:HARNESS.firstSendAt,rects:HARNESS.rects()})",
    ).then(JSON.parse);

    // Sample the host frame as a grid of tiles rather than one whole-page hash.
    // A pulsing "CLICK TO START" label changes one tile; leaving the title
    // screen changes most of them. That difference is what separates "the game
    // started" from "the poster is animating", and a single hash cannot see it.
    const TILES = 6; // 3 x 2 across the host frame
    const tileHashes = async (rect) => {
      const out = [];
      for (let i = 0; i < TILES; i++) {
        const cx = i % 3, cy = Math.floor(i / 3);
        const { data } = await cdp.send("Page.captureScreenshot", {
          format: "jpeg", quality: 60,
          clip: {
            x: rect.x + (rect.w / 3) * cx, y: rect.y + (rect.h / 2) * cy,
            width: rect.w / 3, height: rect.h / 2, scale: 0.5,
          },
        });
        out.push(createHash("sha1").update(data).digest("hex"));
      }
      return out;
    };
    const changedTiles = (a, b) => a.reduce((n, h, i) => n + (h !== b[i] ? 1 : 0), 0);

    // 1. boot — every frame must reach Forgecade.init within 12s
    let s = null;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      try { s = await state(); } catch { continue; }
      if (s.ready.every(Boolean)) break;
    }
    if (!s) throw new Error("harness never became readable");
    checks.boot = s.ready.every(Boolean);
    if (!checks.boot) {
      detail = `only ${s.ready.filter(Boolean).length}/${players} frames called Forgecade.init`;
    }

    const host = s.rects[0];
    const beforeClick = await tileHashes(host);
    const sendsBefore = s.sends[0];

    // 2. open the start gate in every frame. Games put it in different places —
    // a full-canvas pointer handler, a centred DOM button, a key press — so try
    // the plausible ones rather than assuming. A game that survives all of this
    // without starting would not survive a real player either.
    // Start gates sit anywhere: a full-canvas pointer handler, or a DOM button
    // at an unpredictable spot. Sandboxed frames are separate CDP targets, so
    // the DOM cannot be queried from here — sweep a dense grid instead. Sumo
    // Spheres put its button at y=0.68 and a coarser grid missed it entirely.
    const CLICK_GRID = [];
    for (let gy = 1; gy <= 5; gy++) for (let gx = 1; gx <= 5; gx++) {
      CLICK_GRID.push([gx / 6, gy / 6]);
    }
    for (const r of s.rects) {
      for (const [fx, fy] of CLICK_GRID) {
        const x = Math.round(r.x + r.w * fx), y = Math.round(r.y + r.h * fy);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        }
        await sleep(35);
      }
      for (const key of [{ key: " ", code: "Space", windowsVirtualKeyCode: 32 },
                         { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }]) {
        for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, ...key });
      }
      await sleep(120);
    }

    // Play it out. This is the only judgement that cannot be faked: a game
    // stuck on its poster still animates its background and its host loop may
    // still broadcast, but it never reaches the ceremony. Nudge the controls
    // along the way so nothing stalls waiting for input.
    // Every player gets a DIFFERENT key each tick. Driving all eight with the
    // same input marches them in lockstep — they never meet, never collide, and
    // a game about players hitting each other looks inert. Offsetting per player
    // is the difference between measuring the game and measuring the bot.
    const KEYS = ["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
                  "KeyA", "KeyD", "KeyW", "KeyS", "ShiftLeft"];
    const deadline = Date.now() + playSeconds * 1000;
    let afterPlay = null, tick = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const now = await state();
      if (now.ended) break;
      if (!afterPlay && Date.now() > deadline - (playSeconds * 1000) / 2) {
        afterPlay = await tileHashes(host);
      }
      for (const [idx, r] of s.rects.entries()) {
        // prime-ish stride so players drift out of phase instead of cycling together
        const code = KEYS[(tick * 3 + idx * 7) % KEYS.length];
        // aim somewhere inside this player's frame, wandering over time
        const fx = 0.3 + ((tick * 13 + idx * 29) % 40) / 100;
        const fy = 0.3 + ((tick * 7 + idx * 17) % 40) / 100;
        const x = Math.round(r.x + r.w * fx), y = Math.round(r.y + r.h * fy);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        // occasional clicks — several games map their main action to pointers
        if ((tick + idx) % 3 === 0) {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
          }
        }
        for (const type of ["keyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", { type, code, key: code.replace("Key", "").toLowerCase() });
        }
      }
      tick++;
    }
    afterPlay ??= await tileHashes(host);
    await sleep(1200);
    const afterPlay2 = await tileHashes(host);
    const after = await state();
    if (screenshotPath) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(data, "base64"));
    }

    // 3. finished — the host reached Forgecade.end. A game that never leaves
    // its title screen cannot get here no matter how lively it looks.
    const sceneShift = changedTiles(beforeClick, afterPlay);
    checks.finished = after.ended !== null;
    // 4. moving — something is still animating now, i.e. it did not freeze
    checks.moving = changedTiles(afterPlay, afterPlay2) >= 1;
    // 5. quiet — no frame crashed (client paths break more often than host ones)
    errors.push(...after.errors);
    checks.quiet = after.errors.length === 0;
    const broadcast = after.sends[0] - sendsBefore;
    signals.sceneShift = sceneShift;
    signals.broadcast = broadcast;

    // Beyond pass/fail: how the match actually went. These do not decide the
    // verdict — a game is not broken for being dull — but they are what tells
    // two working candidates apart, which pass/fail never can.
    const scores = Object.values(after.ended?.scores ?? {}).map(Number).filter(Number.isFinite);
    const spread = scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0;
    signals.scoreSpread = spread;
    signals.scored = scores.some((s) => s !== 0);
    // guests staying silent means they were spectators, not players
    signals.guestShare = after.sends.reduce((a, b) => a + b, 0) > 0
      ? +(after.guestSends / after.sends.reduce((a, b) => a + b, 0)).toFixed(2)
      : 0;
    signals.payloadKinds = Object.keys(after.payloadKeys ?? {}).length;
    signals.firstSendAt = after.firstSendAt;
    signals.rawScores = after.ended?.scores ?? null;

    if (!detail) {
      if (!checks.finished) {
        detail = `never reached Forgecade.end within ${playSeconds}s — the round never resolves ` +
          `(scene moved ${sceneShift}/${TILES} tiles, host sent ${broadcast} messages)`;
      } else if (!checks.moving) detail = "the picture froze during play";
      else if (!checks.quiet) detail = `${after.errors.length} uncaught error(s), first: ${after.errors[0].player}: ${after.errors[0].message}`;
    }
    cdp.close();
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const passed = checks.boot && checks.quiet && checks.finished && checks.moving;
  return { passed, checks, errors, detail, signals };
}

// CLI: node src/smoketest.js <file.html> [players]
if (process.argv[1] && process.argv[1].endsWith("smoketest.js")) {
  const file = process.argv[2];
  const players = Number(process.argv[3]) || 2;
  if (!file) {
    console.error("usage: node src/smoketest.js <game.html> [players]");
    process.exit(2);
  }
  const html = await readFile(file, "utf8");
  const result = await smokeTest(html, { players, screenshotPath: process.argv[4] ?? null });
  const mark = (ok) => (ok ? "PASS" : "FAIL");
  console.log(`boot    ${mark(result.checks.boot)}`);
  console.log(`quiet   ${mark(result.checks.quiet)}`);
  console.log(`finished ${mark(result.checks.finished)}`);
  console.log(`moving  ${mark(result.checks.moving)}`);
  console.log(`signals scene ${result.signals.sceneShift}/6 tiles, host broadcast ${result.signals.broadcast} msgs in ${result.signals.playSeconds}s`);
  console.log(`match   score spread ${result.signals.scoreSpread}, anyone scored: ${result.signals.scored}, ` +
    `guest traffic ${Math.round((result.signals.guestShare ?? 0) * 100)}%, ${result.signals.payloadKinds} payload kinds`);
  if (result.detail) console.log(`\n${result.detail}`);
  for (const e of result.errors.slice(0, 5)) console.log(`  ! ${e.player}: ${e.message}`);
  console.log(`\n=> ${result.passed ? "PASSED" : "FAILED"} (${players} players)`);
  process.exit(result.passed ? 0 : 1);
}
