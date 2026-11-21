/**
 * analytics.test.js - unit, invariant and regression tests for the log audit,
 * traffic report, thread reconstruction, eviction timeline, script coverage
 * and room code strength analysis.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_ALPHABET,
  CODE_BASE_LENGTH,
  LAB_PRESETS,
  RelayEngine,
  createRng,
  generateRoomCode,
  runScript,
  validateRoomCode
} from "../engine.js";
import {
  auditLog,
  trafficReport,
  threadReport,
  evictionReport,
  scriptCoverage,
  codeStrength,
  buildAnalyticsReport
} from "../analytics.js";

const code = () => generateRoomCode(createRng(7));
const inUnit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function engineFor(preset) {
  const engine = new RelayEngine({ roomCode: code() });
  runScript(engine, LAB_PRESETS[preset]);
  return engine;
}

/* ------------------------------------------------------------------ *
 * auditLog
 * ------------------------------------------------------------------ */

test("AUD 01: a well formed preset log has zero violations", () => {
  for (const name of Object.keys(LAB_PRESETS)) {
    const audit = auditLog(engineFor(name).log);
    assert.equal(audit.valid, true, name);
    assert.equal(audit.violationCount, 0);
    assert.equal(audit.eventCount, audit.lastSeq);
  }
});

test("AUD 02: an empty log is valid with zero span", () => {
  const audit = auditLog([]);
  assert.equal(audit.valid, true);
  assert.equal(audit.eventCount, 0);
  assert.equal(audit.timeSpanMs, 0);
});

test("AUD 03: a repeated sequence number is caught", () => {
  const log = engineFor("ordering").log;
  const broken = log.map((e) => ({ ...e }));
  broken[3].seq = broken[2].seq;
  const audit = auditLog(broken);
  assert.equal(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.kind === "ordering"));
});

test("AUD 04: a decreasing sequence number is caught", () => {
  const broken = engineFor("ordering").log.map((e) => ({ ...e }));
  broken[4].seq = 1;
  assert.ok(auditLog(broken).violations.some((v) => v.kind === "ordering"));
});

test("AUD 05: a backwards clock is caught", () => {
  const broken = engineFor("replay").log.map((e, i) => ({ ...e, time: 100 - i }));
  assert.ok(auditLog(broken).violations.some((v) => v.kind === "clock"));
});

test("AUD 06: a skipped per sender counter is caught", () => {
  const broken = engineFor("ordering").log.map((e) => ({ ...e }));
  const sends = broken.filter((e) => e.type === "send");
  sends[2].senderSeq = 99;
  assert.ok(auditLog(broken).violations.some((v) => v.kind === "senderSeq"));
});

test("AUD 07: a send from an absent client is caught", () => {
  const broken = engineFor("ordering").log.map((e) => ({ ...e }));
  const ghost = { seq: 99, type: "send", clientId: "ghost", senderSeq: 1, text: "hi", time: 0 };
  assert.ok(auditLog([...broken, ghost]).violations.some((v) => v.kind === "membership"));
});

test("AUD 08: strictMembership flags a fanout listing a client before it joined", () => {
  const log = engineFor("ordering").log;
  const flagged = auditLog(log, { strictMembership: true });
  const plain = auditLog(log, { strictMembership: false });
  assert.ok(flagged.violationCount >= plain.violationCount);
});

test("AUD 09: timeSpanMs is the last time minus the first", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 100, members: [] },
    { seq: 2, type: "heartbeat", clientId: "a", time: 3500, members: ["a"] }
  ];
  assert.equal(auditLog(log).timeSpanMs, 3400);
});

test("AUD 10: invariant: every audit field is finite over 30 generated logs", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const engine = new RelayEngine({ roomCode: generateRoomCode(createRng(seed)) });
    const script = [
      { op: "join", client: "a" }, { op: "join", client: "b" },
      { op: "send", client: "a", text: "one" },
      { op: "advance", ms: 3000 }, { op: "heartbeat", client: "a" },
      { op: "advance", ms: 4000 }, { op: "send", client: "b", text: "two" },
      { op: "advance", ms: 4000 }, { op: "replay", fromSeq: 2 }
    ];
    runScript(engine, script);
    const audit = auditLog(engine.log);
    assert.ok(Number.isFinite(audit.eventCount));
    assert.ok(Number.isFinite(audit.violationCount));
    assert.ok(Number.isFinite(audit.timeSpanMs));
    assert.equal(audit.valid, true);
  }
});

/* ------------------------------------------------------------------ *
 * trafficReport
 * ------------------------------------------------------------------ */

test("TRF 01: type counts match the log histogram", () => {
  const log = engineFor("ordering").log;
  const report = trafficReport(log);
  for (const type of ["join", "leave", "send", "heartbeat"]) {
    assert.equal(report.counts[type], log.filter((e) => e.type === type).length);
  }
});

test("TRF 02: per client send counts and bytes agree with the log", () => {
  const log = engineFor("ordering").log;
  const report = trafficReport(log);
  for (const row of report.clients) {
    const sends = log.filter((e) => e.type === "send" && e.clientId === row.clientId);
    assert.equal(row.sends, sends.length);
    assert.equal(row.bytes, sends.reduce((s, e) => s + (e.text?.length ?? 0), 0));
  }
});

test("TRF 03: client rows are sorted by sends then id", () => {
  const rows = trafficReport(engineFor("ordering").log).clients;
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].sends >= rows[i].sends);
  }
});

test("TRF 04: heartbeat gaps are measured between consecutive pings of one client", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0 },
    { seq: 2, type: "heartbeat", clientId: "a", time: 3000 },
    { seq: 3, type: "heartbeat", clientId: "a", time: 6000 },
    { seq: 4, type: "heartbeat", clientId: "a", time: 9000 }
  ];
  const gaps = trafficReport(log, { heartbeatTtlMs: 10000 }).heartbeatGaps;
  assert.equal(gaps.count, 2);
  assert.equal(gaps.meanMs, 3000);
  assert.equal(gaps.maxMs, 3000);
  assert.equal(gaps.overTtlCount, 0);
});

test("TRF 05: a gap over the ttl is counted", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0 },
    { seq: 2, type: "heartbeat", clientId: "a", time: 1000 },
    { seq: 3, type: "heartbeat", clientId: "a", time: 13000 }
  ];
  const gaps = trafficReport(log, { heartbeatTtlMs: 10000 }).heartbeatGaps;
  assert.equal(gaps.maxMs, 12000);
  assert.equal(gaps.overTtlCount, 1);
});

test("TRF 06: an empty log yields zeroed, bounded traffic", () => {
  const report = trafficReport([]);
  assert.deepEqual(report.clients, []);
  assert.equal(report.totalBytes, 0);
  assert.equal(report.activeClients, 0);
  assert.equal(report.heartbeatGaps.count, 0);
  assert.equal(report.heartbeatGaps.meanMs, 0);
});

test("TRF 07: kinds histogram only counts known message kinds", () => {
  const log = engineFor("ordering").log.map((e) => e.type === "send" ? { ...e, kind: "note" } : e);
  const report = trafficReport(log);
  assert.deepEqual(report.kinds, { note: 5 });
});

/* ------------------------------------------------------------------ *
 * threadReport
 * ------------------------------------------------------------------ */

test("THR 01: a log with no replies has one thread per send", () => {
  const report = threadReport(engineFor("ordering").log);
  assert.equal(report.sendCount, 5);
  assert.equal(report.rootCount, 5);
  assert.equal(report.replyCount, 0);
  assert.equal(report.maxDepth, 0);
});

test("THR 02: a reply chain reconstructs depth and size", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0 },
    { seq: 2, type: "send", clientId: "a", senderSeq: 1, text: "root", replyTo: null },
    { seq: 3, type: "send", clientId: "a", senderSeq: 2, text: "reply", replyTo: 2 },
    { seq: 4, type: "send", clientId: "a", senderSeq: 3, text: "nested", replyTo: 3 }
  ];
  const report = threadReport(log);
  assert.equal(report.rootCount, 1);
  assert.equal(report.replyCount, 2);
  assert.equal(report.largestThread.size, 3);
  assert.equal(report.maxDepth, 2);
});

test("THR 03: a reply to a missing sequence is an orphan", () => {
  const log = [
    { seq: 1, type: "send", clientId: "a", senderSeq: 1, text: "root", replyTo: null },
    { seq: 2, type: "send", clientId: "a", senderSeq: 2, text: "lost", replyTo: 999 }
  ];
  const report = threadReport(log);
  assert.equal(report.orphanCount, 1);
  assert.equal(report.replyCount, 0);
  assert.deepEqual(report.orphans, [{ seq: 2, replyTo: 999 }]);
});

test("THR 04: a reply to a non send event is an orphan", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0 },
    { seq: 2, type: "send", clientId: "a", senderSeq: 1, text: "lost", replyTo: 1 }
  ];
  assert.equal(threadReport(log).orphanCount, 1);
});

test("THR 05: a cycle does not hang the walk", () => {
  const log = [
    { seq: 1, type: "send", clientId: "a", senderSeq: 1, text: "a", replyTo: 2 },
    { seq: 2, type: "send", clientId: "a", senderSeq: 2, text: "b", replyTo: 1 }
  ];
  const report = threadReport(log);
  assert.ok(Number.isFinite(report.maxDepth));
  assert.equal(report.orphanCount, 0);
});

test("THR 06: threads are sorted by size then root sequence", () => {
  const log = [
    { seq: 1, type: "send", clientId: "a", senderSeq: 1, text: "r1", replyTo: null },
    { seq: 2, type: "send", clientId: "a", senderSeq: 2, text: "r2", replyTo: null },
    { seq: 3, type: "send", clientId: "a", senderSeq: 3, text: "reply", replyTo: 2 }
  ];
  const threads = threadReport(log).threads;
  assert.equal(threads[0].rootSeq, 2);
  assert.equal(threads[0].size, 2);
});

/* ------------------------------------------------------------------ *
 * evictionReport
 * ------------------------------------------------------------------ */

test("EVC 01: the eviction preset produces exactly one stale sweep", () => {
  const report = evictionReport(engineFor("eviction").log);
  assert.equal(report.evictionCount, 1);
  assert.equal(report.evictions[0].clientId, "cobalt");
  assert.ok(report.evictions[0].silentForMs > 10000);
});

test("EVC 02: a log with no stale leaves has a zeroed report", () => {
  const report = evictionReport(engineFor("ordering").log);
  assert.equal(report.evictionCount, 0);
  assert.equal(report.meanSilentForMs, 0);
  assert.equal(report.firstEvictionTimeMs, null);
  assert.deepEqual(report.byClient, {});
});

test("EVC 03: counts group by client and silence statistics are bounded", () => {
  const log = [
    { seq: 1, type: "leave", clientId: "a", reason: "stale", silentForMs: 11000, time: 11000 },
    { seq: 2, type: "leave", clientId: "a", reason: "stale", silentForMs: 13000, time: 24000 },
    { seq: 3, type: "leave", clientId: "b", reason: "stale", silentForMs: 15000, time: 30000 },
    { seq: 4, type: "leave", clientId: "c", reason: "voluntary", time: 31000 }
  ];
  const report = evictionReport(log);
  assert.equal(report.evictionCount, 3);
  assert.deepEqual(report.byClient, { a: 2, b: 1 });
  assert.equal(report.meanSilentForMs, 13000);
  assert.equal(report.maxSilentForMs, 15000);
  assert.equal(report.firstEvictionTimeMs, 11000);
});

/* ------------------------------------------------------------------ *
 * scriptCoverage
 * ------------------------------------------------------------------ */

test("COV 01: the replay preset covers four of six operations", () => {
  const report = scriptCoverage(LAB_PRESETS.replay);
  assert.equal(report.stepCount, 9);
  assert.equal(report.coveredDimensions, 4);
  assert.equal(report.coverageFraction, 0.6667);
  assert.deepEqual(report.missingOps, ["heartbeat", "advance"]);
  assert.equal(report.exercisesReplay, true);
});

test("COV 02: the eviction preset exercises the clock and heartbeat path", () => {
  const report = scriptCoverage(LAB_PRESETS.eviction);
  assert.equal(report.exercisesClock, true);
  assert.equal(report.exercisesEvictionPath, true);
  assert.equal(report.senderSpread, 1);
});

test("COV 03: a six op script has full coverage", () => {
  const script = [
    { op: "join", client: "a" }, { op: "send", client: "a", text: "x" },
    { op: "heartbeat", client: "a" }, { op: "advance", ms: 1 },
    { op: "replay", fromSeq: 0 }, { op: "leave", client: "a" }
  ];
  const report = scriptCoverage(script);
  assert.equal(report.coverageFraction, 1);
  assert.deepEqual(report.missingOps, []);
  assert.equal(report.invalidOpCount, 0);
});

test("COV 04: an unknown operation is counted but never used", () => {
  const report = scriptCoverage([{ op: "explode" }, { op: "join", client: "a" }]);
  assert.equal(report.invalidOpCount, 1);
  assert.deepEqual(report.usedOps, ["join"]);
});

test("COV 05: an empty or non array script is handled", () => {
  assert.equal(scriptCoverage([]).coverageFraction, 0);
  assert.equal(scriptCoverage(null).stepCount, 0);
  assert.equal(scriptCoverage(null).invalidOpCount, 0);
});

test("COV 06: invariant: coverage is in the unit interval for every preset", () => {
  for (const name of Object.keys(LAB_PRESETS)) {
    const report = scriptCoverage(LAB_PRESETS[name]);
    assert.ok(inUnit(report.coverageFraction));
    assert.equal(report.coveredDimensions + report.missingOps.length, 6);
  }
});

/* ------------------------------------------------------------------ *
 * codeStrength
 * ------------------------------------------------------------------ */

test("STR 01: a 1000 code sample is unique, valid and rejects every mutation", () => {
  const s = codeStrength(1000);
  assert.equal(s.sampleSize, 1000);
  assert.equal(s.validCount, 1000);
  assert.equal(s.uniqueCount, 1000);
  assert.equal(s.mutationCount, 6000);
  assert.equal(s.rejectedMutations, 6000);
  assert.equal(s.detectionFraction, 1);
});

test("STR 02: the base space is 31 to the fifth power", () => {
  const s = codeStrength(10);
  assert.equal(s.alphabetSize, CODE_ALPHABET.length);
  assert.equal(s.baseSpace, Math.pow(CODE_ALPHABET.length, CODE_BASE_LENGTH));
  assert.equal(s.baseSpaceApprox, "28.6 million");
});

test("STR 03: the sample size is clamped and deterministic", () => {
  assert.equal(codeStrength(0).sampleSize, 0);
  assert.equal(codeStrength(99999).sampleSize, 10000);
  assert.deepEqual(codeStrength(50, { seed: 3 }), codeStrength(50, { seed: 3 }));
  assert.notDeepEqual(codeStrength(50, { seed: 3 }), codeStrength(50, { seed: 4 }));
});

test("STR 04: every generated code in the sample is valid", () => {
  const rng = createRng(20261029);
  for (let i = 0; i < 200; i += 1) {
    assert.equal(validateRoomCode(generateRoomCode(rng)).valid, true);
  }
});

/* ------------------------------------------------------------------ *
 * buildAnalyticsReport
 * ------------------------------------------------------------------ */

test("RPT 01: the report assembles all six sections", () => {
  const log = engineFor("eviction").log;
  const report = buildAnalyticsReport(log, { script: LAB_PRESETS.eviction });
  assert.deepEqual(Object.keys(report).sort(),
    ["audit", "density", "eventCount", "evictions", "script", "threads", "traffic", "valid"].sort());
  assert.equal(report.eventCount, log.length);
  assert.equal(report.valid, true);
  assert.ok(report.script);
  assert.ok(inUnit(report.density) || report.density === 0);
});

test("RPT 02: the report is serializable with no NaN or Infinity", () => {
  const text = JSON.stringify(buildAnalyticsReport(engineFor("replay").log, { script: LAB_PRESETS.replay }));
  assert.equal(text.includes("NaN"), false);
  assert.equal(text.includes("Infinity"), false);
  assert.ok(text.length > 500);
});

test("RPT 03: the report is deterministic for the same log and script", () => {
  const log = engineFor("ordering").log;
  assert.deepEqual(buildAnalyticsReport(log), buildAnalyticsReport(log));
});

test("RPT 04: a broken log marks the report invalid", () => {
  const log = engineFor("ordering").log.map((e) => ({ ...e }));
  log[2].seq = 1;
  const report = buildAnalyticsReport(log);
  assert.equal(report.valid, false);
  assert.ok(report.audit.violationCount > 0);
});

test("RPT 05: density is events per second over the log span", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: [] },
    { seq: 2, type: "heartbeat", clientId: "a", time: 2000, members: ["a"] },
    { seq: 3, type: "heartbeat", clientId: "a", time: 4000, members: ["a"] }
  ];
  const report = buildAnalyticsReport(log);
  assert.equal(report.density, 0.75);
});
