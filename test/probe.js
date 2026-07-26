// In-frame autoplayer and telemetry. Injected by the smoke server ahead of the
// SDK; never part of public/forgecade-sdk.js, so nothing here ever reaches a
// real party.
//
// Why it exists: driving the game with CDP key events from the page level does
// not work. Those go to the focused frame only, so seven of eight players sit
// still, and a keyDown immediately followed by keyUp is invisible to a game
// that samples input at 10Hz. Measured on the same build: page-level driving
// produced a final score of eight zeros; dispatching inside each frame with
// real hold times produced 5,11,3,8,6,0,9,0. Every quality signal downstream
// depends on the game actually being played.
(() => {
  const params = new URLSearchParams(location.search);
  const seat = Number(params.get("seat") ?? 0);
  const seats = Number(params.get("p") ?? 2);
  if (params.get("bot") === "0") return;

  // Deterministic per seat: candidates for the same idea face identical input,
  // so comparing them measures the games and not the dice.
  let s = (seat + 1) * 2654435761 % 2147483647;
  const rnd = () => (s = Math.imul(48271, s) & 2147483647) / 2147483648;

  const T = { keys: 0, pointers: 0, holds: 0 };
  window.__FORGECADE_PROBE = T;

  const KEYS = [
    { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    { key: "a", code: "KeyA", keyCode: 65 },
    { key: "d", code: "KeyD", keyCode: 68 },
    { key: "w", code: "KeyW", keyCode: 87 },
    { key: "s", code: "KeyS", keyCode: 83 },
    { key: " ", code: "Space", keyCode: 32 },
    { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  ];

  const fire = (type, spec) => {
    const ev = new KeyboardEvent(type, {
      key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode,
      bubbles: true, cancelable: true,
    });
    for (const target of [document, window]) {
      try { target.dispatchEvent(ev); } catch { /* ignore */ }
    }
    T.keys++;
  };

  // Hold keys for a while instead of tapping them: a game polling a keys[] map
  // each frame only sees input that is still down when it looks.
  const held = new Map();
  function press(spec, ms) {
    if (held.has(spec.code)) return;
    held.set(spec.code, true);
    fire("keydown", spec);
    T.holds++;
    setTimeout(() => { fire("keyup", spec); held.delete(spec.code); }, ms);
  }

  function pointer(x, y, down) {
    const common = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1,
                     pointerType: "mouse", isPrimary: true, button: 0, buttons: down ? 1 : 0 };
    const el = document.elementFromPoint(x, y) ?? document.body;
    for (const type of down ? ["pointerdown", "mousedown"] : ["pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, common)); } catch { /* ignore */ }
    }
    T.pointers++;
  }

  // A seated player: steers for a stretch, then commits an action — closer to
  // how a person plays than uniform random mashing, and it keeps the seats out
  // of phase so they actually run into each other.
  let steering = KEYS[Math.floor(rnd() * 4)];
  function tick() {
    if (rnd() < 0.25) steering = KEYS[Math.floor(rnd() * 4)];
    press(steering, 300 + Math.floor(rnd() * 500));
    if (rnd() < 0.45) press(KEYS[4 + Math.floor(rnd() * 4)], 200 + Math.floor(rnd() * 400));
    if (rnd() < 0.55) press(KEYS[8], 120 + Math.floor(rnd() * 260));   // space
    if (rnd() < 0.2) press(KEYS[9], 400);                               // shift
    if (rnd() < 0.5) {
      const x = Math.round(innerWidth * (0.2 + rnd() * 0.6));
      const y = Math.round(innerHeight * (0.2 + rnd() * 0.6));
      pointer(x, y, true);
      setTimeout(() => pointer(x, y, false), 90);
    }
  }

  // Stagger the seats so eight bots do not act on the same frame.
  const start = 900 + seat * (700 / Math.max(1, seats));
  setTimeout(() => setInterval(tick, 420), start);
})();
