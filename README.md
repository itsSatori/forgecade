# Forgecade

> The party game where the games don't exist yet. Open source, self-hosted, AI-forged.

**Status: early but playable.** The full party loop works end-to-end; game generation quality is being tuned.

## What is Forgecade?

Forgecade is a Jackbox-style party game for a group of friends, each on their own computer —
except nobody knows what you'll be playing tonight, because the games haven't been made yet.

One round looks like this:

1. Someone creates a group and shares the 4-letter room code, everyone joins in the browser.
2. The round starts: everyone has **30 seconds** to type a funny game idea.
3. All ideas are revealed to the group.
4. A **dice roll** picks which idea gets forged first.
5. The AI generates that idea as a **multiplayer game** — and announces when it's ready.
6. You play it together. While you play, the next idea is already being forged in the
   background: the AI tells you when the next game is available. No fixed round times.

Commercial "AI builds your game" platforms exist. Forgecade is different on purpose:

- **A party game, not a dev tool** — the fun is the group loop, not the editor.
- **Open source & self-hosted** — runs on any box your friends can reach; bring your own LLM API key.
- **Multiplayer-first** — every generated game is played together, live.

## How it works

```
 every player's browser                        the server (one Node process)
┌───────────────────────────────┐
│ Party frame                    │  WebSocket  ┌───────────────────────────┐
│  lobby · 30s idea timer ·      │◄───────────►│ Room system                │
│  reveal · dice · forge status  │             │  codes, phases, msg relay  │
│ ┌───────────────────────────┐  │             ├───────────────────────────┤
│ │ Generated game             │  │             │ Generator queue            │
│ │ (sandboxed iframe,         │  │             │  Claude forges the games   │
│ │  talks via postMessage)    │  │             │  in the background         │
│ └───────────────────────────┘  │             └───────────────────────────┘
└───────────────────────────────┘
```

Two design decisions carry the whole thing:

- **The party loop is hand-written, only the games are AI-generated.** Lobby, timers,
  reveal, dice, and the room system are deterministic code — a game night can never
  fail on a hallucinated lobby.
- **The AI never writes netcode.** Generated games run in a sandboxed iframe and talk to
  a tiny fixed SDK (`Forgecade.init/send/onMessage/end`) via postMessage; the party frame
  owns the WebSocket and the server just relays room-scoped messages. Games are
  host-authoritative: one player's machine runs the logic, the others send inputs.
  The sandbox also means generated code can never touch your session or the API.

## Quick start

Requires Node.js 20+.

```sh
npm install

# demo mode — full party flow with a built-in mini game, no API key needed
npm run dev

# the real thing — games forged by Claude
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Open `http://localhost:4242`, create a group, share the code.
To play with remote friends, run it on a box they can reach and set
`FORGECADE_HOST=0.0.0.0` (ideally behind a reverse proxy with TLS).

Any Anthropic-compatible endpoint works too (`ANTHROPIC_BASE_URL`), and so does
the local [Codex CLI](https://developers.openai.com/codex/cli), which spends a
ChatGPT subscription allowance rather than API credits — see `.env.example`.

### Quality gate

A one-shot model writes a whole multiplayer game blind, so some of them are
duds — and the duds are rarely obvious: they parse cleanly, animate happily,
and simply never let you play. `src/smoketest.js` catches them by *playing*
each candidate in headless Chrome (real SDK, real sandbox headers, several
players in several frames relaying messages) and checking the one thing that
cannot be faked: whether the round ever reaches `Forgecade.end`.

```sh
npm run smoke -- games/<slug>/index.html 4   # judge one game with 4 players
```

Set `FORGECADE_CANDIDATES=3` and the forge builds three games at once, plays
all of them, and ships the one that holds up. The candidates overlap, so the
party waits barely longer than for a single one.

## Roadmap

- [x] Room system: codes, lobby, phases, reconnect
- [x] Party loop: 30s idea round → reveal → dice roll → forge → play
- [x] Pipeline: next game forges while the current one is played
- [x] Forgecade SDK: fixed multiplayer bridge for generated games
- [x] Demo mode (`npm run dev`) — no API key needed
- [x] Warm-up runner: a pixel mini game in every waiting moment — same seeded
      obstacle course for the whole room, bounce off each other's heads
- [x] Smoke test: every forged game is played in a headless browser before the
      party sees it — a round that never reaches `Forgecade.end` never ships
- [x] Best-of-N: forge several candidates at once, ship the one that plays
- [ ] Tune the generator prompt on real games (playtesting!)
- [ ] Scoreboard across rounds
- [ ] Game archive: replay the best forged games from past nights
- [ ] Godot HTML5 pipeline for game types that outgrow the browser canvas

## Contributing

Early days — issues and discussions are the best way to get involved.

## License

[MIT](LICENSE)
