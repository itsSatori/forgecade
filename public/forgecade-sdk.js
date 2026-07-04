// Forgecade Game SDK — the fixed multiplayer bridge for generated games.
// Games run in a sandboxed iframe (opaque origin) and never touch the
// network directly: everything goes via postMessage to the party frame,
// which owns the WebSocket connection.
(() => {
  let ctx = null;
  let initCb = null;
  let msgCb = null;

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.__forgecade !== true) return;
    if (m.type === "init") {
      ctx = m.ctx;
      initCb?.(ctx);
    } else if (m.type === "msg") {
      msgCb?.(m.data, m.from);
    }
  });

  const post = (m) => window.parent.postMessage({ __forgecade: true, ...m }, "*");

  window.Forgecade = {
    // cb receives { players: [{id, name}], me: {id, name}, isHost }
    init(cb) {
      initCb = cb;
      if (ctx) cb(ctx);
      post({ type: "ready" });
    },
    // broadcast to all OTHER players' game instances (not echoed to self)
    send(data) {
      post({ type: "send", data });
    },
    onMessage(cb) {
      msgCb = cb;
    },
    // optional: report the round result, e.g. { scores: { [playerId]: 3 } }
    end(result) {
      post({ type: "end", result });
    },
  };
})();
