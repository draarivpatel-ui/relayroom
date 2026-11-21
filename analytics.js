// RelayRoom analytics.
//
// Pure functions over an event log and a script. Nothing here moves time,
// touches the DOM, or reaches the network. The dashboard uses these to turn an
// append only log into an auditable report: sequence integrity, per client
// traffic, reply threads, eviction timelines and script coverage.

import {
  CHECKSUM_WEIGHTS,
  CODE_ALPHABET,
  CODE_BASE_LENGTH,
  CODE_LENGTH,
  MESSAGE_KINDS,
  charValue,
  checksumDigit,
  createRng,
  generateRoomCode,
  validateRoomCode
} from "./engine.js";

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Verify the structural invariants of a relay log: strictly increasing
 * sequence numbers, nondecreasing timestamps, per sender counters that start
 * at one and never skip, and membership lists that never contain a client who
 * had not joined. Returns every violation with its sequence number, so a
 * broken transport can be diagnosed rather than just flagged.
 */
export function auditLog(log, options = {}) {
  const events = Array.isArray(log) ? log : [];
  const violations = [];
  const senderSeq = new Map();
  const joined = new Set();
  let lastSeq = 0;
  let sawSeq = false;
  let lastTime = -Infinity;
  const finiteTimes = [];

  for (const event of events) {
    if (event === null || typeof event !== "object") {
      violations.push({ seq: null, kind: "malformed", detail: "log entry is not an object" });
      continue;
    }
    const seq = Number.isInteger(event.seq) ? event.seq : null;
    if (seq === null || seq <= lastSeq) {
      violations.push({ seq, kind: "ordering", detail: `sequence ${event.seq} follows ${lastSeq}` });
    } else if (sawSeq && seq > lastSeq + 1) {
      // The engine numbers events step by step, so a jump forward means
      // entries were dropped between this event and the previous one.
      violations.push({ seq, kind: "ordering", detail: `sequence ${seq} leaves a gap after ${lastSeq}` });
    }
    // A corrupt sequence value still records its violation but must not replace
    // the last good baseline, or the next event would escape the ordering check.
    if (seq !== null) {
      lastSeq = seq;
      sawSeq = true;
    }
    if (event.time !== undefined) {
      if (!Number.isFinite(event.time)) {
        violations.push({ seq, kind: "clock", detail: `non numeric time ${String(event.time)}` });
      } else {
        if (event.time < lastTime) {
          violations.push({ seq, kind: "clock", detail: `time ${event.time} precedes ${lastTime}` });
        }
        lastTime = event.time;
        finiteTimes.push(event.time);
      }
    }

    // The fanout roster is checked against membership BEFORE this event's own
    // join or leave delta is applied: a join lists the roster before the
    // joiner entered and a leave lists the roster that still contained the
    // leaver, so both belong to the pre event state.
    if (options.strictMembership === true && Array.isArray(event.members)) {
      for (const member of event.members) {
        if (!joined.has(member)) {
          violations.push({ seq, kind: "fanout", detail: `${member} listed while outside the room` });
        }
      }
    }

    if (event.type === "join") {
      if (joined.has(event.clientId)) {
        violations.push({ seq, kind: "membership", detail: `${event.clientId} joined while already present` });
      }
      joined.add(event.clientId);
      // Every join opens a fresh session with a fresh sender counter, matching
      // the engine, which resets senderSeq to zero on each join.
      senderSeq.set(event.clientId, 0);
    }
    if (event.type === "leave") {
      if (!joined.has(event.clientId)) {
        violations.push({ seq, kind: "membership", detail: `${event.clientId} left while absent` });
      }
      joined.delete(event.clientId);
    }

    if (event.type === "send") {
      const prev = senderSeq.get(event.clientId) ?? 0;
      if (event.senderSeq !== prev + 1) {
        violations.push({ seq, kind: "senderSeq", detail: `${event.clientId} jumped from ${prev} to ${event.senderSeq}` });
      }
      senderSeq.set(event.clientId, event.senderSeq);
      if (!joined.has(event.clientId)) {
        violations.push({ seq, kind: "membership", detail: `${event.clientId} sent while absent` });
      }
    }
    if (event.type === "heartbeat" && !joined.has(event.clientId)) {
      violations.push({ seq, kind: "membership", detail: `${event.clientId} pinged while absent` });
    }
  }

  return {
    eventCount: events.length,
    violationCount: violations.length,
    violations,
    valid: violations.length === 0,
    lastSeq,
    timeSpanMs: finiteTimes.length > 1
      ? Math.max(0, finiteTimes[finiteTimes.length - 1] - finiteTimes[0]) : 0
  };
}

/**
 * Traffic statistics per client, plus the type histogram and the heartbeat
 * gap distribution. A silent gap is the time between consecutive heartbeats
 * from one client; the maximum gap is what the eviction sweep bounds.
 */
export function trafficReport(log, options = {}) {
  const events = Array.isArray(log) ? log : [];
  const clients = new Map();
  const counts = { join: 0, leave: 0, send: 0, heartbeat: 0 };
  const lastBeat = new Map();
  const gaps = [];
  const kinds = new Map();

  const entryFor = (id) => {
    if (!clients.has(id)) {
      clients.set(id, { clientId: id, joins: 0, leaves: 0, sends: 0, heartbeats: 0, bytes: 0, lastSeen: null });
    }
    return clients.get(id);
  };

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (counts[event.type] !== undefined) counts[event.type] += 1;
    if (event.clientId === null || event.clientId === undefined) continue;
    const entry = entryFor(event.clientId);
    if (event.type === "join") entry.joins += 1;
    if (event.type === "leave") entry.leaves += 1;
    if (event.type === "send") {
      entry.sends += 1;
      entry.bytes += typeof event.text === "string" ? event.text.length : 0;
      if (MESSAGE_KINDS.includes(event.kind)) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    }
    if (event.type === "heartbeat") {
      entry.heartbeats += 1;
      if (lastBeat.has(event.clientId)) {
        const gap = event.time - lastBeat.get(event.clientId);
        if (gap >= 0) gaps.push(gap);
      }
      lastBeat.set(event.clientId, event.time);
    }
    if (typeof event.time === "number") entry.lastSeen = event.time;
  }

  const rows = [...clients.values()].sort((a, b) => b.sends - a.sends || (a.clientId < b.clientId ? -1 : 1));
  const ttlMs = options.heartbeatTtlMs ?? 10000;
  return {
    clients: rows,
    counts,
    kinds: Object.fromEntries([...kinds.entries()].sort()),
    heartbeatGaps: {
      count: gaps.length,
      meanMs: gaps.length ? round(gaps.reduce((s, g) => s + g, 0) / gaps.length, 2) : 0,
      maxMs: gaps.length ? Math.max(...gaps) : 0,
      minMs: gaps.length ? Math.min(...gaps) : 0,
      overTtlCount: gaps.filter((g) => g > ttlMs).length
    },
    totalBytes: rows.reduce((s, r) => s + r.bytes, 0),
    activeClients: rows.filter((r) => r.joins > r.leaves).length
  };
}

/**
 * Reconstruct reply threads from `replyTo` sequence numbers. A thread is a
 * root send plus every send that transitively points back into it. The result
 * reports depth, breadth and whether any reply points at a missing or
 * non send event.
 */
export function threadReport(log) {
  const events = Array.isArray(log) ? log : [];
  const objectEvents = events.filter((e) => e !== null && typeof e === "object");
  const bySeq = new Map(objectEvents.map((e) => [e.seq, e]));
  const sends = objectEvents.filter((e) => e.type === "send");
  const children = new Map();
  const orphans = [];
  for (const send of sends) {
    if (send.replyTo === null || send.replyTo === undefined) continue;
    const parent = bySeq.get(send.replyTo);
    if (!parent || parent.type !== "send") {
      orphans.push({ seq: send.seq, replyTo: send.replyTo });
      continue;
    }
    if (!children.has(parent.seq)) children.set(parent.seq, []);
    children.get(parent.seq).push(send.seq);
  }
  // A true root has no replyTo at all. A send whose replyTo is missing or
  // points at a non send event is an orphan, not a root, so the two groups
  // never overlap and replyCount stays nonnegative.
  const roots = sends.filter((s) => s.replyTo === null || s.replyTo === undefined);
  // The walk is iterative: a forged chain thousands of replies deep must not
  // overflow the call stack.
  const threads = [];
  let replyCount = 0;
  let maxDepth = 0;
  for (const root of roots) {
    const seen = new Set();
    const stack = [[root.seq, 0]];
    let size = 0;
    let depth = 0;
    while (stack.length > 0) {
      const [seq, d] = stack.pop();
      if (seen.has(seq)) continue;
      seen.add(seq);
      size += 1;
      if (d > 0) replyCount += 1;
      if (d > depth) depth = d;
      for (const kid of children.get(seq) ?? []) stack.push([kid, d + 1]);
    }
    threads.push({ rootSeq: root.seq, clientId: root.clientId, size, depth });
    if (depth > maxDepth) maxDepth = depth;
  }
  threads.sort((a, b) => b.size - a.size || a.rootSeq - b.rootSeq);
  // A reply whose parent exists but that no root reaches (a chain hanging off
  // an orphan, a detached cycle, a self reply) is reported separately rather
  // than silently counted as threaded.
  const unreachableReplyCount = sends.length - roots.length - orphans.length - replyCount;
  return {
    sendCount: sends.length,
    rootCount: roots.length,
    replyCount,
    unreachableReplyCount,
    orphanCount: orphans.length,
    orphans,
    threads,
    largestThread: threads[0] ?? null,
    maxDepth
  };
}

/**
 * Summarize eviction events: who was swept, how long they had been silent,
 * and the elapsed room time of each sweep. This is a report over the log, not
 * a new eviction rule.
 */
export function evictionReport(log) {
  const events = Array.isArray(log) ? log : [];
  const evictions = events
    .filter((e) => e !== null && typeof e === "object" && e.type === "leave" && e.reason === "stale")
    .map((e) => ({
      seq: e.seq,
      clientId: e.clientId,
      silentForMs: e.silentForMs ?? null,
      timeMs: typeof e.time === "number" ? e.time : null
    }));
  const byClient = new Map();
  for (const eviction of evictions) {
    byClient.set(eviction.clientId, (byClient.get(eviction.clientId) ?? 0) + 1);
  }
  // Only a positive finite silence feeds the summary statistics; a forged
  // negative or non numeric value stays visible in the list but cannot drag
  // the mean below zero.
  const silences = evictions
    .map((e) => e.silentForMs)
    .filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  return {
    evictionCount: evictions.length,
    evictions,
    byClient: Object.fromEntries([...byClient.entries()].sort()),
    meanSilentForMs: silences.length ? round(silences.reduce((s, v) => s + v, 0) / silences.length, 2) : 0,
    maxSilentForMs: silences.length ? Math.max(...silences) : 0,
    firstEvictionTimeMs: evictions.length ? evictions[0].timeMs : null
  };
}

/**
 * Coverage of a script: which operations it uses, whether it exercises a
 * rejection, an eviction and a replay, and how evenly it spreads sends across
 * clients. A script that only ever sends notes has low coverage even if it is
 * long.
 */
export function scriptCoverage(script, options = {}) {
  const steps = Array.isArray(script) ? script : [];
  const ops = ["join", "leave", "send", "heartbeat", "advance", "replay"];
  const used = new Set();
  const senders = new Map();
  let invalidOps = 0;
  for (const step of steps) {
    if (ops.includes(step?.op)) used.add(step.op);
    else invalidOps += 1;
    if (step?.op === "send") senders.set(step.client, (senders.get(step.client) ?? 0) + 1);
  }
  const has = (op) => used.has(op);
  const dimensions = [
    has("join"), has("leave"), has("send"), has("heartbeat"), has("advance"), has("replay")
  ];
  const covered = dimensions.filter(Boolean).length;
  const invalidOpCount = invalidOps;
  return {
    stepCount: steps.length,
    usedOps: [...used].sort(),
    missingOps: ops.filter((op) => !used.has(op)),
    coverageFraction: round(covered / ops.length, 4),
    coveredDimensions: covered,
    totalDimensions: ops.length,
    invalidOpCount,
    senders: Object.fromEntries([...senders.entries()].sort()),
    senderSpread: senders.size,
    exercisesReplay: has("replay"),
    exercisesClock: has("advance"),
    exercisesEvictionPath: has("advance") && has("heartbeat")
  };
}

/**
 * Room code strength: the base space, the checksum's single character
 * detection guarantee, and an empirical mutation sweep over a seeded sample.
 * The sample is generated here with the same seeded generator as the page, so
 * the numbers are reproducible.
 */
export function codeStrength(sampleSize = 1000, options = {}) {
  const n = Number.isFinite(sampleSize) ? Math.max(0, Math.min(10000, Math.floor(sampleSize))) : 1000;
  const rng = createRng(options.seed ?? 20261029);
  const seen = new Set();
  let valid = 0;
  let rejectedMutations = 0;
  let mutationCount = 0;
  let digest = 2166136261;
  for (let i = 0; i < n; i += 1) {
    const code = generateRoomCode(rng);
    seen.add(code);
    for (let j = 0; j < code.length; j += 1) {
      digest ^= code.charCodeAt(j);
      digest = Math.imul(digest, 16777619);
    }
    if (validateRoomCode(code).valid) valid += 1;
    for (let position = 0; position < CODE_LENGTH; position += 1) {
      const mutated = code.slice(0, position) +
        CODE_ALPHABET[(charValue(code[position]) + 1) % CODE_ALPHABET.length] +
        code.slice(position + 1);
      mutationCount += 1;
      if (!validateRoomCode(mutated).valid) rejectedMutations += 1;
    }
  }
  const baseSpace = Math.pow(CODE_ALPHABET.length, CODE_BASE_LENGTH);
  return {
    sampleSize: n,
    alphabetSize: CODE_ALPHABET.length,
    baseSpace,
    baseSpaceApprox: `${(baseSpace / 1e6).toFixed(1)} million`,
    uniqueCount: seen.size,
    validCount: valid,
    mutationCount,
    rejectedMutations,
    detectionFraction: mutationCount ? round(rejectedMutations / mutationCount, 4) : 0,
    checksumWeightsSum: CHECKSUM_WEIGHTS.reduce((s, v) => s + v, 0),
    sampleDigest: (digest >>> 0).toString(16).padStart(8, "0")
  };
}

/**
 * The full report the analytics panel renders. Every field is derived from
 * the supplied log and script, with no stored state.
 */
export function buildAnalyticsReport(log, options = {}) {
  const audit = auditLog(log, options.audit);
  const traffic = trafficReport(log, options.traffic);
  const threads = threadReport(log);
  const evictions = evictionReport(log);
  const script = options.script ? scriptCoverage(options.script) : null;
  return {
    eventCount: audit.eventCount,
    valid: audit.valid,
    audit,
    traffic,
    threads,
    evictions,
    script,
    density: audit.timeSpanMs > 0 ? round(audit.eventCount / (audit.timeSpanMs / 1000), 4) : 0
  };
}
