# RelayRoom Build Notes

Overnight local pre-build for the CSC Winter Sparkathon (submission window opens Oct 29, 2026).
Nothing has been pushed anywhere; the repo waits at
`personal/Contest Submissions 2026-2027/Hark-Hackathons/repos/relayroom/`. Author: Aariv Patel.

## What Was Built

- `index.html`, `styles.css`, `app.js`: a static single page app, vanilla HTML, CSS and JavaScript,
  zero dependencies, GitHub Pages deployable as is. Four sections: the Virtual Client Grid, the
  Relay Stream, the Message Lab and the Code Validator, plus an engine explainer and an honest
  footer.
- `engine.js`, the Room Core: a deterministic message bus with join and leave events, strictly
  increasing sequence numbers, per sender counters, heartbeat events, a sweep that evicts clients
  silent for more than ten seconds, replay windows, a seeded generator, six character room codes
  with a weighted checksum digit, a script runner with a decision trace, and the three lab preset
  scripts. No timers and no network: time moves only through `tick()`.
- Four virtual devices on screen: Orchid the phone, Maple the laptop, Juniper the tablet, Cobalt
  the watch. They send notes, acknowledge and reply to each other, heartbeat every three seconds,
  and can be stalled from their cards to demonstrate eviction and rejoin in one browser.
- The Message Lab: compose scripts (send, join, leave, heartbeat, advance clock, replay), run one
  step or all steps, and read a decision trace explaining every acceptance, rejection, eviction and
  replay window. Presets for Ordering, Eviction and Replay.
- The Code Validator: live validation (format, charset, checksum) as you type, plus an in browser
  1,000 code sweep that mirrors the test suite checks and reports counts and duration.
- `tests/`: 77 node:test tests across four files (`room-codes.test.js`, `engine.test.js`,
  `lab.test.js`, and `dom-smoke.test.js`). No installs and no network; run with `node --test`.
- `README.md` (features limited to what works, transport honestly described as simulated with the
  WebSocket layer as the future drop in) and `LICENSE` (MIT).

## Exact Real Test Counts

`node --test` on Node v26.8.1:

- tests: **77**, pass: **77**, fail: **0**, cancelled: **0**, skipped: **0**, todo: **0**
- duration: about **65 to 80 ms** on this machine
- per file: `tests/room-codes.test.js` 25 tests, `tests/engine.test.js` 30 tests,
  `tests/lab.test.js` 12 tests, `tests/dom-smoke.test.js` 10 tests
- inside those tests, loops run far more checks than the named count: the 1,000 code validation
  sweep asserts per code, the mutation sweep tries all 6,000 single character mutations of 1,000
  codes, and a 5,000 code sample is checked against the birthday collision bound

## Honest Caveats

- Verified both with a Node DOM smoke suite (`tests/dom-smoke.test.js`) and headless Chromium
  video capture (`video/demo.mp4`).
- GitHub Pages deployment is untested until the submission window opens. The repo is built to drop
  in as is: `index.html` at the root, relative paths, no build step.
- The 5,000 code collision test asserts the birthday bound (at most 10 collisions) rather than
  zero, because zero is not mathematically guaranteed at that sample size. The required 1,000 code
  sweep is deterministic for its fixed seed and does assert zero collisions.
- The room code base space is 31 to the fifth power, about 28.6 million codes. The checksum digit
  guarantees detection of any single character substitution or adjacent swap, not uniqueness.
- The four devices are scripted simulations with seeded behavior, not real clients. No WebSocket
  server exists in this build; the README says so and the masthead labels the build Local
  Simulation.
- The fan out strip and lane colors assume four devices; the engine itself supports any number.

## Devpost Bullets

- RelayRoom turns one browser tab into a four device relay room: virtual clients join with a six
  character code, exchange structured messages, and every event lands in one strictly ordered log
  you can watch build, sequence number by sequence number.
- The Room Core is a deterministic message bus engine with no timers and no network: heartbeats,
  stale client eviction and replay windows are all driven by an injectable clock, so the same
  script always produces the same log.
- Message Lab composes scripted sequences and explains every decision step by step: what was
  accepted at which sequence, what was rejected and why, who the sweep evicted, and exactly what a
  replay handed back.
- A 77 test node:test suite validates 1,000 synthetic room codes for charset, checksum digit and
  collision resistance, then covers ordering, eviction, replay, determinism, and DOM interactions
  in under 90 ms with no network and no installs.
- Backend ready by design: the WebSocket transport is a drop in replacement for the in page
  scheduler, calling the same engine methods and appending to the same log. Today it ships
  honestly labeled as a local simulation.
