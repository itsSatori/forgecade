// Generated games are untrusted LLM output. The sandbox CSP gives them an
// opaque origin: no access to the party frame, the WebSocket or the API —
// they can only talk to the party frame via the SDK's postMessage bridge.
// script-src hosts must stay in sync with ALLOWED_SCRIPT_HOSTS in generator.js —
// the validator refuses at forge time what this header would block at play time.
//
// Lives in its own module so the smoke test serves candidate games under the
// exact headers production uses: the opaque origin is what makes localStorage
// throw, and a test that misses that ships the bug.
export const GAME_HEADERS = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-pointer-lock; default-src 'none'; " +
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' " +
    "https://cdn.babylonjs.com https://cdnjs.cloudflare.com; " +
    "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; " +
    "connect-src 'none'",
};
