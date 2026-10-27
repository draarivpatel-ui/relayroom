# RelayRoom

A synchronous multi device communication relay environment, simulated end to end in one static page.
Devices join a shared room with a six character code and exchange structured messages over a
deterministic event log: strict ordering, heartbeats, stale client eviction and replay, all visible
in a single browser tab.

Built by Aariv Patel. MIT License.

## What It Does

**Room Core.** A deterministic message bus engine (`engine.js`). Join and leave events, strictly
increasing sequence numbers, per sender sequence counters, heartbeat events, a sweep that evicts
clients silent for more than ten seconds, and replay windows for rejoining clients. The engine has
no timers and no network: time only moves when `tick()` advances it, so the same script always
produces the same log.

**Virtual Client Grid.** Four simulated devices (Orchid the phone, Maple the laptop, Juniper the
tablet, Cobalt the watch) share the room on screen. They send notes, acknowledge and reply to each
other, and heartbeat every three seconds. Stall a device and the sweep evicts it after ten seconds
of silence; rejoin it and it starts a fresh sender sequence.

**Code Validator.** Room codes are six characters from a 31 character alphabet with the lookalikes
removed (no I, L, O, 0 or 1). The sixth character is a checksum digit computed from a weighted sum
of the first five, so every single character typo is caught. The page validates codes live as you
type and runs a 1,000 code sweep in the browser.

**Message Lab.** Compose a scripted sequence against its own room, run it one step at a time, and
read the decision trace: what was accepted at which sequence, what was rejected and why, who the
sweep evicted, and what a replay returned. Three presets (Ordering, Eviction, Replay) load ready
made scripts that the test suite also runs.

## Honest Status

- Everything runs locally in one page. There is no server, no backend and no network calls. The
  masthead labels the build Local Simulation.
- The transport is simulated by an in page scheduler. If this project is later deployed with a
  backend, a WebSocket transport is the drop in replacement for that scheduler: it would call the
  same engine methods and append to the same log. No live server exists today.
- Nothing leaves the tab: no analytics, no storage, no cookies.

## Run It

Open `index.html` in any modern browser. It is a static single page app with zero dependencies,
deployable on GitHub Pages as is.

## Run The Tests

```bash
node --test
```

77 tests pass in under 90 ms, with no network and no installs (built on Node 26, needs Node 18 or
newer). They cover:

- the 1,000 room code validation sweep, a 5,000 code collision sample checked against the birthday
  bound, and 6,000 single character mutations all rejected
- ordering: strictly increasing global sequence numbers and per sender counters under three way
  interleaving
- heartbeats, stale eviction at the ten second ttl, and rejoin behavior
- replay windows, copy safety, and determinism: identical scripted runs produce identical logs
- the three Message Lab preset scripts, the exact scripts the UI ships
- DOM structure, metadata, CSS hygiene, and interactive DOM execution (`tests/dom-smoke.test.js`)

## Design Notes

- Palette: deep pine ink, with amber for signal, cyan for data, green for joins, red for leaves and
  periwinkle for the fourth lane. Color encodes event semantics.
- Type: serif display headings over the system body face, monospace for codes, sequence numbers and
  timestamps. System font stacks only.
- The fan out strip beside every event shows which of the four lanes held it.
- Accessibility: semantic landmarks, labelled controls, visible focus, keyboard operable controls,
  a polite status line for simulation state, stream rows deliberately not announced, and reduced
  motion respected.

## Project Layout

| File | Purpose |
| --- | --- |
| `index.html` | The whole app: grid, stream, lab and validator |
| `styles.css` | Palette, type and layout |
| `app.js` | Page local scheduler, four virtual clients, lab and validator wiring |
| `engine.js` | The Room Core: codes, RelayEngine, script runner, presets |
| `tests/` | node:test suite: room codes, engine, lab, and DOM smoke tests |

## License

MIT. See `LICENSE`.
