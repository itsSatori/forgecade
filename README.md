# Forgecade

> Self-hosted AI game generator — describe a game idea, play it with your friends minutes later.

**Status: early development / pre-alpha.** Nothing playable yet — this repo currently documents the concept and architecture. Star/watch if you want to follow along.

## What is Forgecade?

Forgecade turns game ideas into playable multiplayer browser games using LLMs — on your own server.

The weekend flow it's built for:

1. You and your friends each pitch a funny or interesting game idea.
2. The generator cranks out a playable version in ~5–20 minutes.
3. While you're playing one game, the next one is being generated.
4. Every game lands on a shared shelf — replay, remix, or throw it away.

Commercial "AI builds your game" platforms already exist. Forgecade is different on purpose:

- **Open source** — no black box, no paywall.
- **Self-hosted** — runs on your own VPS; bring your own LLM API key (provider-agnostic).
- **Multiplayer-first** — built for playing with friends, not generating single-player demos.

## How it works (planned architecture)

```
 idea (text prompt)
        │
        ▼
 ┌─────────────────┐     ┌──────────────────────────┐
 │  Orchestrator    │────▶│  LLM (bring your own key) │
 └─────────────────┘     └──────────────────────────┘
        │  generated game logic
        ▼
 ┌─────────────────────────────────────────┐
 │  Multiplayer runtime (fixed, hand-written)│
 │  lobby · rooms · state sync · WebSockets │
 └─────────────────────────────────────────┘
        │  sandboxed build (container per game)
        ▼
 ┌─────────────────┐
 │  Game shelf      │  ← you and your friends play here
 └─────────────────┘
```

Key design decision: **the AI does not write netcode.** Lobby, rooms, and state synchronization are a fixed, hand-written framework — the LLM only generates game logic against that API. This keeps generation fast and multiplayer reliable.

### Engines

- **Babylon.js** (first target) — web-native, no build step, WebSocket multiplayer out of the box.
- **Godot** (later) — HTML5 export pipeline, for game types where a real engine pays off.

The generator picks the engine that fits the idea.

## Roadmap

- [ ] MVP: prompt → Babylon.js single-player game, served from the VPS
- [ ] Fixed multiplayer runtime (lobby, rooms, state sync)
- [ ] Prompt → multiplayer game against the runtime API
- [ ] Game shelf UI (play, replay, delete)
- [ ] Sandboxed build pipeline (one container per game)
- [ ] Godot HTML5 pipeline
- [ ] Engine auto-selection

## Requirements (planned)

- A VPS or any Linux box with Docker
- An API key for an LLM provider of your choice

## Contributing

The project is at the idea/architecture stage — issues and discussions are the best way to get involved right now.

## License

[MIT](LICENSE)
