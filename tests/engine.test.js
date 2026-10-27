// Engine tests: join and leave events, ordering guarantees, heartbeats and
// stale client eviction, replay, and determinism under the virtual clock.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RelayEngine,
  createRng,
  generateRoomCode,
  runScript,
  validateRoomCode
} from "../engine.js";

const ROOM = generateRoomCode(createRng(7));

function freshEngine({ roomCode = ROOM } = {}) {
  return new RelayEngine({ roomCode });
}

test("a fresh engine has an empty log and no clients", () => {
  const engine = freshEngine();
  assert.equal(engine.log.length, 0);
  assert.equal(engine.clients.size, 0);
  assert.equal(engine.nextSeq, 1);
  assert.equal(engine.time, 0);
});

test("join appends a join event as sequence one", () => {
  const engine = freshEngine();
  const result = engine.join("orchid", { label: "Orchid", device: "Phone" });
  assert.equal(result.ok, true);
  assert.equal(engine.log.length, 1);
  assert.equal(engine.log[0].seq, 1);
  assert.equal(engine.log[0].type, "join");
  assert.equal(engine.log[0].clientId, "orchid");
});

test("join records the client label and device", () => {
  const engine = freshEngine();
  engine.join("orchid", { label: "Orchid", device: "Phone" });
  const client = engine.clients.get("orchid");
  assert.equal(client.label, "Orchid");
  assert.equal(client.device, "Phone");
  assert.equal(client.senderSeq, 0);
});

test("a duplicate join is rejected", () => {
  const engine = freshEngine();
  assert.equal(engine.join("orchid").ok, true);
  const again = engine.join("orchid");
  assert.equal(again.ok, false);
  assert.match(again.reason, /already in the room/);
  assert.equal(engine.log.length, 1, "a rejected join must not append an event");
});

test("join is rejected when the room code is invalid", () => {
  assert.equal(validateRoomCode("BBBBBB").valid, false, "BBBBBB must fail its checksum for this test");
  const engine = new RelayEngine({ roomCode: "BBBBBB" });
  const result = engine.join("orchid");
  assert.equal(result.ok, false);
  assert.match(result.reason, /room code is not valid/);
});

test("join accepts a generated valid room code", () => {
  const engine = freshEngine();
  assert.equal(validateRoomCode(ROOM).valid, true);
  assert.equal(engine.join("maple").ok, true);
});

test("send events get strictly increasing sequence numbers", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const seqs = [];
  for (let i = 0; i < 50; i += 1) {
    const result = engine.send("orchid", `Note ${i}`);
    assert.equal(result.ok, true);
    seqs.push(result.event.seq);
  }
  for (let i = 1; i < seqs.length; i += 1) {
    assert.equal(seqs[i], seqs[i - 1] + 1);
  }
});

test("each sender keeps its own sequence counter", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.join("maple");
  const orchid = engine.send("orchid", "one");
  const maple = engine.send("maple", "one");
  const orchidTwo = engine.send("orchid", "two");
  const mapleTwo = engine.send("maple", "two");
  assert.equal(orchid.event.senderSeq, 1);
  assert.equal(maple.event.senderSeq, 1);
  assert.equal(orchidTwo.event.senderSeq, 2);
  assert.equal(mapleTwo.event.senderSeq, 2);
});

test("interleaved senders preserve strict global order", () => {
  const engine = freshEngine();
  for (const id of ["orchid", "maple", "juniper"]) engine.join(id);
  const expected = [];
  for (let round = 0; round < 10; round += 1) {
    for (const id of ["orchid", "maple", "juniper"]) {
      const text = `${id} round ${round}`;
      expected.push(text);
      engine.send(id, text);
    }
  }
  const sends = engine.log.filter((event) => event.type === "send");
  assert.equal(sends.length, expected.length);
  for (let i = 0; i < sends.length; i += 1) {
    assert.equal(sends[i].text, expected[i], "global order must match send order");
    if (i > 0) assert.equal(sends[i].seq, sends[i - 1].seq + 1);
  }
});

test("message text, kind and reply target are preserved", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const result = engine.send("orchid", "About seq 3", { kind: "reply", replyTo: 3 });
  assert.equal(result.event.text, "About seq 3");
  assert.equal(result.event.kind, "reply");
  assert.equal(result.event.replyTo, 3);
});

test("send from an unknown client is rejected", () => {
  const engine = freshEngine();
  const result = engine.send("ghost", "hello");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in the room/);
});

test("send after eviction is rejected", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.tick(10001);
  const result = engine.send("orchid", "anyone there?");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in the room/);
});

test("leave appends a leave event and removes the client", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const result = engine.leave("orchid");
  assert.equal(result.ok, true);
  assert.equal(engine.clients.size, 0);
  assert.equal(engine.log[1].type, "leave");
  assert.equal(engine.log[1].clientId, "orchid");
  assert.equal(engine.log[1].reason, "voluntary");
});

test("leave of an unknown client is rejected", () => {
  const engine = freshEngine();
  assert.equal(engine.leave("ghost").ok, false);
});

test("a leave can carry a stated reason", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.leave("orchid", "moving rooms");
  assert.equal(engine.log[1].reason, "moving rooms");
});

test("heartbeat refreshes the last seen time", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.tick(4000);
  const result = engine.heartbeat("orchid");
  assert.equal(result.ok, true);
  assert.equal(engine.clients.get("orchid").lastSeen, 4000);
  assert.equal(engine.log[1].type, "heartbeat");
});

test("heartbeat from an unknown client is rejected", () => {
  const engine = freshEngine();
  assert.equal(engine.heartbeat("ghost").ok, false);
});

test("a silent client is evicted by the sweep", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const evicted = engine.tick(10001);
  assert.deepEqual(evicted, ["orchid"]);
  assert.equal(engine.clients.size, 0);
});

test("a client inside the ttl is not evicted", () => {
  const engine = freshEngine();
  engine.join("orchid");
  assert.deepEqual(engine.tick(10000), [], "silence of exactly the ttl must not evict");
  engine.heartbeat("orchid");
  assert.deepEqual(engine.tick(9999), []);
  assert.equal(engine.clients.size, 1);
});

test("eviction writes a leave event with the stale reason and silence duration", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.tick(12000);
  const leave = engine.log.find((event) => event.type === "leave");
  assert.equal(leave.reason, "stale");
  assert.equal(leave.silentForMs, 12000);
  assert.equal(leave.clientId, "orchid");
});

test("an evicted client can rejoin and starts a fresh sender sequence", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.send("orchid", "before");
  engine.tick(10001);
  const rejoin = engine.join("orchid");
  assert.equal(rejoin.ok, true);
  assert.equal(engine.clients.get("orchid").senderSeq, 0);
  const after = engine.send("orchid", "after");
  assert.equal(after.event.senderSeq, 1);
  const joins = engine.log.filter((event) => event.type === "join");
  assert.equal(joins.length, 2);
});

test("replay from zero returns the whole log in order", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.send("orchid", "one");
  engine.heartbeat("orchid");
  engine.send("orchid", "two");
  const backlog = engine.replay(0);
  assert.deepEqual(
    backlog.map((event) => event.seq),
    [1, 2, 3, 4]
  );
});

test("replay from a mid sequence returns only newer events", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.send("orchid", "one");
  engine.send("orchid", "two");
  engine.send("orchid", "three");
  const backlog = engine.replay(2);
  assert.deepEqual(
    backlog.map((event) => event.seq),
    [3, 4]
  );
});

test("replay returns copies, not live references", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const backlog = engine.replay(0);
  backlog[0].text = "tampered";
  assert.notEqual(engine.log[0].text, "tampered");
});

test("replay hands a rejoining client exactly what it missed", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.join("maple");
  engine.send("orchid", "while you were here");
  engine.leave("maple");
  engine.send("orchid", "while you were gone one");
  engine.send("orchid", "while you were gone two");
  engine.join("maple");
  // Maple saw everything up to its own leave at sequence 4.
  const backlog = engine.replay(4);
  assert.deepEqual(
    backlog.map((event) => event.type),
    ["send", "send", "join"]
  );
  assert.deepEqual(
    backlog.map((event) => event.seq),
    [5, 6, 7]
  );
});

test("sequences always step by exactly one and time never goes backwards", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.tick(2500);
  engine.send("orchid", "one");
  engine.heartbeat("orchid");
  engine.tick(1000);
  engine.send("orchid", "two");
  engine.tick(10001);
  engine.join("maple");
  engine.send("maple", "fresh");
  let previous = null;
  for (const event of engine.log) {
    if (previous) {
      assert.equal(event.seq, previous.seq + 1);
      assert.ok(event.time >= previous.time);
    }
    previous = event;
  }
});

test("event times come from the virtual clock, not the wall clock", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.send("orchid", "at zero");
  for (const event of engine.log) {
    assert.equal(event.time, 0);
  }
  engine.tick(7500);
  engine.send("orchid", "after the jump");
  assert.equal(engine.log[2].time, 7500);
});

test("identical scripted runs produce identical logs and traces", () => {
  const script = [
    { op: "join", client: "orchid" },
    { op: "join", client: "maple" },
    { op: "send", client: "orchid", text: "one" },
    { op: "heartbeat", client: "maple" },
    { op: "advance", ms: 3000 },
    { op: "send", client: "maple", text: "two" }
  ];
  const engineA = freshEngine();
  const engineB = freshEngine();
  const a = runScript(engineA, script);
  const b = runScript(engineB, script);
  assert.deepEqual(a.trace, b.trace);
  assert.deepEqual(a.replay, b.replay);
  assert.deepEqual(engineA.log, engineB.log);
  // Six steps, five events: the advance appends nothing when nobody is stale.
  assert.equal(engineA.log.length, 5);
});

test("determinism holds when eviction interleaves with sends", () => {
  const script = [
    { op: "join", client: "orchid" },
    { op: "join", client: "cobalt" },
    { op: "send", client: "orchid", text: "one" },
    { op: "advance", ms: 11000 },
    { op: "send", client: "orchid", text: "two" },
    { op: "send", client: "cobalt", text: "gone" }
  ];
  const engineA = freshEngine();
  const engineB = freshEngine();
  const a = runScript(engineA, script);
  const b = runScript(engineB, script);
  assert.deepEqual(engineA.log, engineB.log);
  assert.deepEqual(a.trace, b.trace);
  const lastTrace = a.trace[a.trace.length - 1];
  assert.equal(lastTrace.ok, false, "the evicted client's send must be rejected");
});

test("stats reports the room, the clock and event counts", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.send("orchid", "one");
  engine.tick(4000);
  engine.heartbeat("orchid");
  const stats = engine.stats();
  assert.equal(stats.roomCode, ROOM);
  assert.equal(stats.time, 4000);
  assert.equal(stats.clients, 1);
  assert.equal(stats.events, 3);
  assert.deepEqual(stats.counts, { join: 1, leave: 0, send: 1, heartbeat: 1 });
});
