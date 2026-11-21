// Hardening regressions: defects found in the adversarial revamp, exercised
// against the real engine, the analytics module and the live page through the
// DOM shim.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CHECKSUM_WEIGHTS,
  HEARTBEAT_TTL_MS,
  RelayEngine,
  createRng,
  generateRoomCode,
  runScript,
  validateRoomCode
} from "../engine.js";
import {
  auditLog,
  buildAnalyticsReport,
  codeStrength,
  evictionReport,
  scriptCoverage,
  threadReport,
  trafficReport
} from "../analytics.js";
import { parsePage, makeDom, runAppModule, repoRoot } from "./helpers/dom.js";

const ROOM = generateRoomCode(createRng(99));
const PAGE = parsePage("index.html");
const HTML = PAGE.source;
const CSS = fs.readFileSync(path.join(repoRoot, "styles.css"), "utf8");
const APP_JS = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");

function freshEngine() {
  return new RelayEngine({ roomCode: ROOM });
}

async function boot() {
  const env = makeDom(PAGE);
  await runAppModule(env);
  return env;
}

/* ------------------------- engine tamper safety -------------------------- */

test("every log event and its members list are frozen at append time", () => {
  const engine = freshEngine();
  engine.join("orchid", { label: "Orchid", device: "Phone" });
  engine.send("orchid", "hello", {});
  engine.heartbeat("orchid");
  engine.leave("orchid");
  for (const event of engine.log) {
    assert.equal(Object.isFrozen(event), true, `seq ${event.seq} is not frozen`);
    if (event.members !== undefined) {
      assert.equal(Object.isFrozen(event.members), true, `members of seq ${event.seq} are not frozen`);
    }
  }
});

test("replay hands out copies that cannot edit the recorded members list", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.join("maple");
  engine.send("orchid", "note", {});
  const replayed = engine.replay(0);
  assert.equal(replayed.length, 3);
  assert.throws(() => replayed[2].members.push("intruder"), TypeError);
  assert.throws(() => { replayed[2].members[0] = "intruder"; }, TypeError);
  // The copy object itself is safe to annotate without touching the log.
  replayed[2].annotation = "mine";
  assert.equal(engine.log[2].annotation, undefined);
});

test("runScript trace entries expose the same frozen members arrays", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [
    { op: "join", client: "orchid" },
    { op: "send", client: "orchid", text: "hi" }
  ]);
  assert.equal(Object.isFrozen(trace[1].members), true);
  assert.throws(() => trace[1].members.pop(), TypeError);
});

test("tick clamps negative, text and non finite deltas to zero", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const start = engine.time;
  engine.tick(-5000);
  assert.equal(engine.time, start);
  engine.tick("later");
  assert.equal(engine.time, start);
  engine.tick(NaN);
  engine.tick(Infinity);
  assert.equal(engine.time, start);
  engine.tick(1500);
  assert.equal(engine.time, start + 1500);
});

test("an advance step asking for a negative span never rewinds the clock", () => {
  const engine = freshEngine();
  runScript(engine, [
    { op: "join", client: "orchid" },
    { op: "advance", ms: 4000 },
    { op: "advance", ms: -2000 }
  ]);
  assert.equal(engine.time, 4000);
  const times = engine.log.map((e) => e.time);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] >= times[i - 1], "log timestamps must stay nondecreasing");
  }
});

test("generateRoomCode survives hostile generators", () => {
  for (const rng of [() => 1, () => 0.9999999, () => -0.4, () => NaN, () => "x", () => Infinity]) {
    const code = generateRoomCode(rng);
    assert.equal(code.length, 6, `code ${code} is not six characters`);
    assert.equal(validateRoomCode(code).valid, true, `code ${code} is not valid`);
  }
});

/* --------------------------- audit accuracy ------------------------------ */

test("a legitimate rejoin resets the sender counter and audits clean", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.send("orchid", "first");
  engine.leave("orchid");
  engine.join("orchid");
  engine.send("orchid", "back again");
  const audit = auditLog(engine.log);
  assert.equal(audit.valid, true, JSON.stringify(audit.violations));
});

test("a forged second join while present is flagged as a membership violation", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: [] },
    { seq: 2, type: "join", clientId: "a", time: 1, members: ["a"] }
  ];
  const audit = auditLog(log);
  assert.equal(audit.valid, false);
  assert.equal(audit.violations.filter((v) => v.kind === "membership").length, 1);
});

test("a heartbeat from a client that never joined is flagged", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: [] },
    { seq: 2, type: "heartbeat", clientId: "ghost", time: 1, members: ["ghost"] }
  ];
  const audit = auditLog(log);
  assert.equal(audit.violations.some((v) => v.kind === "membership" && /ghost/.test(v.detail)), true);
});

test("a corrupt sequence value cannot shield the ordering violation after it", () => {
  const log = [
    { seq: 5, type: "join", clientId: "a", time: 0, members: [] },
    { seq: "oops", type: "heartbeat", clientId: "a", time: 1, members: ["a"] },
    { seq: 3, type: "heartbeat", clientId: "a", time: 2, members: ["a"] }
  ];
  const audit = auditLog(log);
  const ordering = audit.violations.filter((v) => v.kind === "ordering");
  assert.equal(ordering.length, 2, "the corrupt value is flagged and sequence 3 still is too");
});

test("a send missing its sender counter is flagged", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: [] },
    { seq: 2, type: "send", clientId: "a", time: 1, text: "hi", members: ["a"] }
  ];
  const audit = auditLog(log);
  assert.equal(audit.violations.some((v) => v.kind === "senderSeq"), true);
});

test("membership fanout is only flagged when strictMembership asks for it", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: ["a", "ghost"] }
  ];
  assert.equal(auditLog(log).valid, true);
  assert.equal(auditLog(log, { strictMembership: true }).valid, false);
});

test("codeStrength reports the live checksum weights, not a copied constant", () => {
  const report = codeStrength(50);
  assert.equal(report.checksumWeightsSum, CHECKSUM_WEIGHTS.reduce((s, v) => s + v, 0));
});

/* ----------------------- analytics edge coverage -------------------------- */

test("trafficReport keeps join only clients with zero sends", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.join("maple");
  engine.send("orchid", "only orchid talks");
  const report = trafficReport(engine.log);
  const maple = report.clients.find((r) => r.clientId === "maple");
  assert.ok(maple);
  assert.equal(maple.sends, 0);
  assert.equal(report.activeClients, 2);
});

test("evictionReport counts two sweeps of the same client across a rejoin", () => {
  const engine = freshEngine();
  engine.join("cobalt");
  engine.tick(HEARTBEAT_TTL_MS + 1);
  engine.join("cobalt");
  engine.tick(HEARTBEAT_TTL_MS + 1);
  const report = evictionReport(engine.log);
  assert.equal(report.evictionCount, 2);
  assert.equal(report.byClient.cobalt, 2);
});

test("threadReport walks a reply to a reply at depth two", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.join("maple");
  const root = engine.send("orchid", "root note");
  const mid = engine.send("maple", "reply one", { kind: "reply", replyTo: root.event.seq });
  engine.send("orchid", "reply two", { kind: "reply", replyTo: mid.event.seq });
  const report = threadReport(engine.log);
  assert.equal(report.sendCount, 3);
  assert.equal(report.rootCount, 1);
  assert.equal(report.maxDepth, 2);
  assert.equal(report.largestThread.size, 3);
});

test("scriptCoverage counts non object steps as invalid without using them", () => {
  const coverage = scriptCoverage([{ op: "join" }, null, "junk", 42, { op: "send", client: "a" }]);
  assert.equal(coverage.invalidOpCount, 3);
  assert.deepEqual(coverage.usedOps, ["join", "send"]);
});

test("a report over an empty log stays finite and marks no script", () => {
  const report = buildAnalyticsReport([]);
  assert.equal(report.eventCount, 0);
  assert.equal(report.valid, true);
  assert.equal(report.density, 0);
  assert.equal(report.script, null);
  assert.equal(JSON.stringify(report).includes("null"), true);
});

/* ------------------------------ page contract ----------------------------- */

test("the page carries a restrictive content security policy", () => {
  const m = HTML.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(m, "CSP meta tag is missing");
  assert.match(m[1], /default-src 'self'/);
  assert.match(m[1], /script-src 'self'/);
  assert.match(m[1], /connect-src 'none'/);
  assert.match(m[1], /object-src 'none'/);
  assert.match(m[1], /form-action 'none'/);
});

test("smooth scrolling and the masthead tagline are both gone", () => {
  assert.equal(/scroll-behavior\s*:\s*smooth/.test(CSS), false);
  assert.equal(HTML.includes("brand-line"), false);
  assert.equal(/\.brand-line/.test(CSS), false);
});

test("the only innerHTML use in app.js is the constant device icon table", () => {
  const uses = [...APP_JS.matchAll(/innerHTML\s*=\s*([^;]+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 1);
  assert.match(uses[0], /DEVICE_ICONS\[device\.device\]/);
  const icons = APP_JS.match(/const DEVICE_ICONS = \{[\s\S]*?\};/);
  assert.ok(icons);
  assert.equal(/\bon\w+\s*=|<\s*script|javascript:/i.test(icons[0]), false, "an icon string carries executable markup");
});

test("the leave row falls back to the client id for unnamed devices", () => {
  assert.match(APP_JS, /NAMES\.get\(event\.clientId\) \?\? event\.clientId/);
});

/* --------------------------- live DOM behavior ---------------------------- */

test("single stepping the lab numbers trace entries by script position", async () => {
  const env = await boot();
  const stepButton = env.getEl("btn-step-one");
  stepButton.fire("click");
  stepButton.fire("click");
  const entries = env.getEl("lab-trace").children;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].querySelector(".step-no").textContent, "1");
  assert.equal(entries[1].querySelector(".step-no").textContent, "2", "the second step must not be renumbered to one");
});

test("a stalled device goes quiet and the sweep evicts it", async () => {
  const env = await boot();
  const card = env.getEl("device-grid").children[0];
  card.querySelector('[data-field="action"]').fire("click");
  assert.equal(card.querySelector('[data-field="status"]').textContent, "Stalled");

  const stream = env.getEl("stream-list");
  const before = stream.children.length;
  // Two hundred and fifty real milliseconds per tick, one times speed, so
  // fifty ticks simulate more than twelve virtual seconds.
  for (let i = 0; i < 50; i += 1) {
    env.nowBox.t += 250;
    env.intervals[0].fn();
  }
  const added = stream.children.slice(before);
  const laneSends = added.filter((row) => row.dataset.type === "send" && row.dataset.lane === "orchid");
  assert.equal(laneSends.length, 0, "a stalled lane must not keep sending notes");
  const evictions = added.filter((row) => row.dataset.type === "leave" && row.dataset.lane === "orchid" && row.dataset.stale === "true");
  assert.equal(evictions.length, 1, "the sweep should evict the stalled lane once");
  assert.equal(card.querySelector('[data-field="status"]').textContent, "Offline");
});

test("the status line counts devices from the live list, not a constant", async () => {
  const env = await boot();
  assert.match(env.getEl("sim-status").textContent, /4 of 4 devices active/);
});

/* ------------------ pass two adversarial regressions --------------------- */

test("runScript records a rejection for null steps instead of crashing mid run", () => {
  const engine = freshEngine();
  const { trace } = runScript(engine, [
    { op: "join", client: "orchid" },
    null,
    { op: "join", client: "maple" },
    undefined
  ]);
  assert.equal(trace.length, 4);
  assert.equal(trace[0].ok, true);
  assert.equal(trace[1].ok, false);
  assert.match(trace[1].reason, /Malformed step/);
  assert.equal(trace[2].ok, true, "the run continues past a null step");
  assert.equal(trace[3].ok, false);
  assert.equal(engine.clients.size, 2);
});

test("object valued join and leave fields never reach the log", () => {
  const engine = freshEngine();
  // Validation rejects non primitive join fields at the boundary, so no
  // caller held object can become a live handle into the frozen log.
  assert.equal(engine.join("orchid", { label: { name: "nested" } }).ok, false);
  assert.equal(engine.join("orchid", { device: { model: 1 } }).ok, false);
  engine.join("orchid");
  engine.leave("orchid", { why: "object" });
  assert.equal(engine.log[1].reason, "voluntary", "a non string reason is sanitized");
});

test("a send counts as a sign of life for the stale sweep", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.tick(5000);
  engine.send("orchid", "still here");
  assert.deepEqual(engine.tick(6001), [], "an active sender is not evicted");
  assert.equal(engine.clients.get("orchid").lastSeen, 5000);
});

test("sweep never evaluates silence ahead of the engine clock", () => {
  const engine = freshEngine();
  engine.join("orchid");
  engine.tick(100);
  assert.deepEqual(engine.sweep(999999), [], "a future instant cannot evict early");
  assert.equal(engine.clients.size, 1);
  assert.deepEqual(engine.sweep("garbage"), []);
  engine.tick(20000);
  assert.equal(engine.clients.size, 0, "the tick driven sweep still evicts");
  assert.equal(engine.log.find((e) => e.type === "leave").reason, "stale");
});

test("replyTo must reference the sequence of an earlier send", () => {
  const engine = freshEngine();
  engine.join("orchid");
  const root = engine.send("orchid", "root");
  assert.equal(root.ok, true);
  assert.equal(engine.send("orchid", "bad ref", { replyTo: -999 }).ok, false);
  assert.equal(engine.send("orchid", "text ref", { replyTo: "not-a-seq" }).ok, false);
  assert.equal(engine.send("orchid", "join ref", { replyTo: 1 }).ok, false, "a join seq is not a send");
  const reply = engine.send("orchid", "ok ref", { replyTo: root.event.seq });
  assert.equal(reply.ok, true);
  assert.equal(engine.send("orchid", "self ref", { replyTo: reply.event.seq + 1 }).ok, false, "future seqs are rejected");
});

test("join and send enforce room protocol field bounds", () => {
  const engine = freshEngine();
  assert.equal(engine.join(" ".repeat(80)).ok, false, "whitespace only ids are rejected");
  assert.equal(engine.join("x".repeat(100)).ok, false, "overlong ids are rejected");
  assert.equal(engine.join("orchid", { label: { name: "nested" } }).ok, false, "non string labels are rejected");
  assert.equal(engine.join("orchid", { device: "D".repeat(100) }).ok, false, "overlong devices are rejected");
  engine.join("orchid");
  assert.equal(engine.send("orchid", "x".repeat(5000)).ok, false, "oversized text is rejected");
  assert.equal(engine.send("orchid", "   ").ok, false);
});

test("a ligature is not silently expanded into extra code characters", () => {
  const report = validateRoomCode("ﬀSVJQ");
  assert.equal(report.valid, false, "five glyphs must never validate as six characters");
  assert.equal(validateRoomCode(ROOM.toLowerCase()).valid, true, "plain lowercase still folds");
});

test("strictMembership no longer flags the leaver still listed in a leave roster", () => {
  const engine = freshEngine();
  engine.join("a");
  engine.join("b");
  engine.leave("a");
  const audit = auditLog(engine.log, { strictMembership: true });
  assert.equal(audit.valid, true, JSON.stringify(audit.violations));
});

test("auditLog flags a leave by a client that never joined", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: [] },
    { seq: 2, type: "leave", clientId: "ghost", time: 1, members: ["a"] }
  ];
  const audit = auditLog(log);
  assert.equal(audit.valid, false);
  assert.ok(audit.violations.some((v) => v.kind === "membership" && /ghost/.test(v.detail)));
});

test("auditLog flags non numeric times and forward sequence gaps", () => {
  const log = [
    { seq: 1, type: "join", clientId: "a", time: 0, members: [] },
    { seq: 2, type: "heartbeat", clientId: "a", time: "later", members: ["a"] },
    { seq: 5, type: "heartbeat", clientId: "a", time: 3, members: ["a"] }
  ];
  const audit = auditLog(log);
  assert.ok(audit.violations.some((v) => v.kind === "clock"), "string time is a violation");
  assert.ok(audit.violations.some((v) => v.kind === "ordering" && /gap/.test(v.detail)), "the 2 to 5 jump is a gap");
});

test("every analytics function tolerates malformed log entries", () => {
  const junk = [null, undefined, 42, "x", true];
  const audit = auditLog(junk);
  assert.equal(audit.violationCount, 5);
  assert.ok(audit.violations.every((v) => v.kind === "malformed"));
  assert.equal(trafficReport(junk).clients.length, 0);
  assert.equal(threadReport(junk).sendCount, 0);
  assert.equal(evictionReport(junk).evictionCount, 0);
  const mixed = [{ seq: 1, type: "join", clientId: "a", time: 0, members: [] }, null];
  assert.equal(buildAnalyticsReport(mixed).valid, false, "the null is audited as malformed");
});

test("threadReport survives a reply chain ten thousand deep", () => {
  const log = [{ seq: 1, type: "send", clientId: "a", text: "root", replyTo: null }];
  for (let i = 2; i <= 10000; i += 1) {
    log.push({ seq: i, type: "send", clientId: "a", text: `r${i}`, replyTo: i - 1 });
  }
  const report = threadReport(log);
  assert.equal(report.maxDepth, 9999);
  assert.equal(report.largestThread.size, 10000);
  assert.equal(report.replyCount, 9999);
  assert.equal(report.unreachableReplyCount, 0);
});

test("unreachable replies are reported separately, not counted as threaded", () => {
  const orphanChain = [
    { seq: 1, type: "send", clientId: "a", text: "lost", replyTo: 999 },
    { seq: 2, type: "send", clientId: "a", text: "child of lost", replyTo: 1 }
  ];
  const report = threadReport(orphanChain);
  assert.equal(report.replyCount, 0, "nothing is attached to a real root");
  assert.equal(report.orphanCount, 1);
  assert.equal(report.unreachableReplyCount, 1, "the child of an orphan is unreachable");
  assert.equal(report.largestThread, null);

  const selfReply = [{ seq: 1, type: "send", clientId: "a", text: "me", replyTo: 1 }];
  const selfReport = threadReport(selfReply);
  assert.equal(selfReport.replyCount, 0);
  assert.equal(selfReport.unreachableReplyCount, 1);
});

test("codeStrength returns a finite sample size for hostile inputs", () => {
  for (const input of [NaN, -5, "many", null, Infinity]) {
    const report = codeStrength(input);
    assert.ok(Number.isFinite(report.sampleSize), `${String(input)} produced a non finite sample`);
    assert.ok(report.sampleSize >= 0 && report.sampleSize <= 10000);
  }
});

test("evictionReport keeps forged silences out of the summary statistics", () => {
  const log = [
    { seq: 1, type: "leave", clientId: "a", reason: "stale", silentForMs: -5000, time: 0 },
    { seq: 2, type: "leave", clientId: "b", reason: "stale", silentForMs: "huge", time: 1 },
    { seq: 3, type: "leave", clientId: "c", reason: "stale", silentForMs: 12000, time: 2 }
  ];
  const report = evictionReport(log);
  assert.equal(report.evictionCount, 3);
  assert.equal(report.meanSilentForMs, 12000, "only the real silence feeds the mean");
  assert.equal(report.maxSilentForMs, 12000);
});

test("removing an earlier step shifts the cursor instead of skipping a step", async () => {
  const env = await boot();
  const stepButton = env.getEl("btn-step-one");
  stepButton.fire("click");
  stepButton.fire("click");
  // Two steps ran (cursor 2). Removing step one shifts every later step down;
  // the cursor must follow so the next run executes the real third step.
  const rows = env.getEl("lab-steps").children;
  rows[0].querySelector(".step-remove").fire("click");
  stepButton.fire("click");
  const entries = env.getEl("lab-trace").children;
  assert.equal(entries.length, 3);
  assert.equal(entries[2].dataset.op, "join", "the third original step must run, not be skipped");
  assert.match(entries[2].children[1].children[0].textContent, /juniper/i);
  assert.equal(entries[2].querySelector(".step-no").textContent, "2", "the step is now at list position two");
});

test("client names resolve through a Map, never through Object.prototype", () => {
  const source = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");
  assert.match(source, /const NAMES = new Map\(/);
  assert.equal(/NAMES\[/.test(source), false, "no plain object lookup survives");
  const NAMES = new Map([["orchid", "Orchid"]]);
  assert.equal(NAMES.get("__proto__") ?? "__proto__", "__proto__", "a proto id falls back to itself");
  assert.equal(NAMES.get("constructor") ?? "constructor", "constructor");
});
