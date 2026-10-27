// Message Lab tests. These run the exact preset scripts the UI ships with,
// plus the step by step trace behaviors the lab interface renders.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LAB_CLIENTS,
  LAB_PRESETS,
  RelayEngine,
  createRng,
  generateRoomCode,
  runScript
} from "../engine.js";

function freshEngine() {
  return new RelayEngine({ roomCode: generateRoomCode(createRng(21)) });
}

test("the lab has exactly four named clients", () => {
  assert.equal(LAB_CLIENTS.length, 4);
  assert.deepEqual(
    LAB_CLIENTS.map((client) => client.id),
    ["orchid", "maple", "juniper", "cobalt"]
  );
});

test("runScript executes every step in order", () => {
  const engine = freshEngine();
  const script = [
    { op: "join", client: "orchid" },
    { op: "send", client: "orchid", text: "one" },
    { op: "heartbeat", client: "orchid" },
    { op: "send", client: "orchid", text: "two" }
  ];
  const { trace } = runScript(engine, script);
  assert.equal(trace.length, 4);
  assert.deepEqual(
    trace.map((entry) => entry.step),
    [1, 2, 3, 4]
  );
  assert.equal(engine.log.length, 4);
});

test("accepted steps record their sequence numbers", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [
    { op: "join", client: "maple" },
    { op: "send", client: "maple", text: "hello" }
  ]);
  assert.equal(trace[0].ok, true);
  assert.equal(trace[0].event.seq, 1);
  assert.equal(trace[1].ok, true);
  assert.equal(trace[1].event.seq, 2);
  assert.equal(trace[1].senderSeq, 1);
});

test("rejected steps carry a reason and stay false", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [
    { op: "send", client: "ghost", text: "into the void" }
  ]);
  assert.equal(trace[0].ok, false);
  assert.match(trace[0].reason, /not in the room/);
});

test("an advance step moves the clock and sweeps out stale clients", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [
    { op: "join", client: "cobalt" },
    { op: "advance", ms: 11000 }
  ]);
  assert.equal(trace[1].ok, true);
  assert.deepEqual(trace[1].evicted, ["cobalt"]);
  assert.equal(engine.time, 11000);
  const leave = engine.log.find((event) => event.type === "leave");
  assert.equal(leave.reason, "stale");
});

test("a replay step returns the exact backlog window", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [
    { op: "join", client: "orchid" },
    { op: "send", client: "orchid", text: "one" },
    { op: "send", client: "orchid", text: "two" },
    { op: "send", client: "orchid", text: "three" },
    { op: "replay", fromSeq: 2 }
  ]);
  assert.equal(trace[4].ok, true);
  assert.equal(trace[4].count, 2);
  assert.equal(trace[4].first, 3);
  assert.equal(trace[4].last, 4);
});

test("identical scripts produce identical traces", () => {
  const script = [
    { op: "join", client: "juniper" },
    { op: "send", client: "juniper", text: "note" },
    { op: "advance", ms: 4000 },
    { op: "heartbeat", client: "juniper" }
  ];
  const a = runScript(freshEngine(), script);
  const b = runScript(freshEngine(), script);
  assert.deepEqual(a.trace, b.trace);
});

test("an empty script leaves the engine untouched", () => {
  const engine = freshEngine();
  const { trace, replay } = runScript(engine, []);
  assert.equal(trace.length, 0);
  assert.deepEqual(replay, []);
  assert.equal(engine.log.length, 0);
});

test("unknown ops are reported, not thrown", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [{ op: "teleport", client: "orchid" }]);
  assert.equal(trace[0].ok, false);
  assert.match(trace[0].reason, /Unknown op/);
  assert.equal(engine.log.length, 0);
});

test("the ordering preset keeps strict global and per sender order", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, LAB_PRESETS.ordering);
  assert.equal(trace.length, 8);
  assert.ok(trace.every((entry) => entry.ok), "every preset step should be accepted");
  const sends = engine.log.filter((event) => event.type === "send");
  assert.equal(sends.length, 5);
  for (let i = 1; i < sends.length; i += 1) {
    assert.equal(sends[i].seq, sends[i - 1].seq + 1);
  }
  const orchid = sends.filter((event) => event.clientId === "orchid");
  const maple = sends.filter((event) => event.clientId === "maple");
  assert.deepEqual(
    orchid.map((event) => event.senderSeq),
    [1, 2]
  );
  assert.deepEqual(
    maple.map((event) => event.senderSeq),
    [1, 2]
  );
});

test("the eviction preset evicts exactly the silent client", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, LAB_PRESETS.eviction);
  const advances = trace.filter((entry) => entry.op === "advance");
  assert.deepEqual(advances[advances.length - 1].evicted, ["cobalt"]);
  const leave = engine.log.find((event) => event.type === "leave");
  assert.equal(leave.reason, "stale");
  assert.equal(leave.clientId, "cobalt");
  const finalSend = trace[trace.length - 1];
  assert.equal(finalSend.ok, false);
  assert.match(finalSend.reason, /not in the room/);
  assert.ok(engine.clients.has("orchid"), "orchid kept heartbeating and stays");
});

test("the replay preset hands the rejoiner the missed window", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, LAB_PRESETS.replay);
  const replayEntry = trace.find((entry) => entry.op === "replay");
  assert.equal(replayEntry.ok, true);
  assert.equal(replayEntry.count, 4);
  assert.equal(replayEntry.first, 5);
  assert.equal(replayEntry.last, 8);
  const types = engine.replay(4).map((event) => event.type);
  assert.deepEqual(types, ["leave", "send", "send", "join"]);
});
