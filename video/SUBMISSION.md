# RelayRoom | CSC Winter Sparkathon 2026

## Project name

RelayRoom

## Elevator pitch

Four virtual devices, one shared room, and every message in strict global order: a deterministic multi device communication relay and scriptable message lab simulated end to end in one static browser page.

## Track

General / Systems and Distributed Communication

## Story / Description

### Inspiration

Real time room systems look simple from the outside until messages interleave, a client drops silently without sending a close frame, or a reconnecting device asks for the exact window of events it missed. Most demos hide those mechanics behind a black box server. RelayRoom turns the entire room core inside out so every sequence number, heartbeat, stale eviction sweep, and replay window is visible and testable right in one browser tab.

### What it does

- **Virtual Client Grid and Live Relay Stream**: Four simulated devices (Orchid the phone, Maple the laptop, Juniper the tablet, and Cobalt the watch) join a shared room with a six character room code and exchange notes, acknowledgements, and replies on a three second heartbeat. Every event receives a strictly increasing global sequence number alongside a per sender counter, and a four cell fan out strip beside each row shows which lanes received it. You can stall any device card on the grid to watch the sweep evict it after ten seconds of silence, then rejoin it on a fresh sender sequence.
- **Message Lab**: Compose custom multi step scripts or load three ready made presets (`Ordering`, `Eviction`, and `Replay`), step through them one operation at a time or all at once, and read the human readable decision trace explaining why each operation was accepted, rejected, swept, or replayed.
- **Room Code Validator and 1,000 Code Sweep**: Room codes use a 31 character unambiguous alphabet (removing `I`, `L`, `O`, `0`, and `1`) where the sixth character is a weighted mod 31 checksum digit of the first five. The validator checks format, charset, and checksum live as you type, and an in browser benchmark generates 1,000 seeded codes, verifies 100 percent uniqueness, and rejects all 6,000 single character mutations in milliseconds.

### How we built it

RelayRoom is built with zero dependencies in vanilla HTML, CSS, and JavaScript ES modules (`engine.js` and `app.js`). The `RelayEngine` class has no timers and no network calls: time advances solely through `tick(deltaMs)`, making every scripted run 100 percent deterministic. A page local scheduler drives the live simulation in the browser, while the exact same `engine.js` runs under `node:test` in Node.js. When paired with a backend, a WebSocket transport is a drop in replacement for the in page scheduler.

### Testing and verification

Running `node --test` executes 77 unit and DOM smoke tests in under 100 milliseconds with zero external dependencies, verifying the 1,000 code validation sweep, birthday bound collision checks across 5,000 codes, 6,000 single character mutations, strict global and per sender ordering under interleaving, heartbeat TTL eviction at 10 seconds, replay window immutability, and full interactive DOM wiring.

## Built with

- JavaScript (ES2022 Modules)
- HTML5
- CSS3 (Custom Properties, CSS Grid, Tabular Numerals)
- Node.js (`node:test` zero dependency test runner)

## Try it out

- Live Demo: https://aariv.me/relayroom/
- Source Code: https://github.com/draarivpatel-ui/relayroom
