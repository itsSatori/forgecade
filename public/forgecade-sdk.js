// Forgecade Game SDK — the fixed multiplayer bridge for generated games.
// Games run in a sandboxed iframe (opaque origin) and never touch the
// network directly: everything goes via postMessage to the party frame,
// which owns the WebSocket connection.
//
// API (window.Forgecade):
//   init(cb)             cb(ctx) with ctx = { players: [{id, name, color}],
//                        me: {id, name, color}, isHost, seed }. color is a hex
//                        string from a fixed palette, seed is a per-room number
//                        for deterministic randomness. Called exactly once.
//   send(data)           broadcast to all OTHER players' game instances
//                        (not echoed to self).
//   onMessage(cb)        cb(data, fromPlayerId) for messages from other players.
//   onPlayersChange(cb)  cb(players, isHost) when the roster or host changes
//                        mid-game. ctx.players / ctx.isHost are kept current.
//   onPause(cb)          the party frame left the game view — pause loops/sound.
//   onResume(cb)         the party frame is back — resume.
//   end(result)          report the round result, e.g. { scores: { [playerId]: 3 } }.
//
// Uncaught errors and unhandled rejections are reported to the party frame
// automatically (throttled, truncated).
(() => {
  let ctx = null;
  let initCb = null;
  let msgCb = null;
  let playersCb = null;
  let pauseCb = null;
  let resumeCb = null;

  const post = (m) => window.parent.postMessage({ __forgecade: true, ...m }, "*");

  // report crashes to the party frame: max 1 per 2s, 200 chars
  let lastErrorAt = 0;
  const reportError = (message) => {
    const now = Date.now();
    if (now - lastErrorAt < 2000) return;
    lastErrorAt = now;
    post({ type: "error", message: String(message).slice(0, 200) });
  };
  window.addEventListener("error", (e) => reportError(e.message || "Script error"));
  window.addEventListener("unhandledrejection", (e) =>
    reportError(e.reason?.message ?? e.reason ?? "Unhandled rejection"));

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.__forgecade !== true) return;
    if (m.type === "init") {
      if (ctx) return; // ignore duplicate init
      ctx = m.ctx;
      initCb?.(ctx);
    } else if (m.type === "msg") {
      msgCb?.(m.data, m.from);
    } else if (m.type === "players") {
      if (ctx) {
        ctx.players = m.players;
        ctx.isHost = m.isHost;
      }
      playersCb?.(m.players, m.isHost);
    } else if (m.type === "pause") {
      pauseCb?.();
    } else if (m.type === "resume") {
      resumeCb?.();
    }
  });

  window.Forgecade = {
    init(cb) {
      initCb = cb;
      if (ctx) cb(ctx);
      post({ type: "ready" });
    },
    send(data) {
      post({ type: "send", data });
    },
    onMessage(cb) {
      msgCb = cb;
    },
    onPlayersChange(cb) {
      playersCb = cb;
    },
    onPause(cb) {
      pauseCb = cb;
    },
    onResume(cb) {
      resumeCb = cb;
    },
    end(result) {
      post({ type: "end", result });
    },
  };
})();
