// RelayRoom engine.
//
// A deterministic message bus with join and leave events, strict event
// ordering, heartbeat based stale client eviction, and replay.
//
// The engine has no timers and no network. Time enters only through tick(),
// which makes every run reproducible: same seed and same calls, same log.
// A server transport (for example WebSockets) would call these same methods
// and append to the same log; nothing here depends on running in a browser.

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_BASE_LENGTH = 5;
export const CODE_LENGTH = 6;
export const HEARTBEAT_TTL_MS = 10000;

// Position weights for the checksum digit. All are nonzero mod 31 and all
// are distinct, so any single character substitution or adjacent swap in
// the base changes the weighted sum.
export const CHECKSUM_WEIGHTS = [3, 5, 7, 11, 13];

export const MESSAGE_KINDS = ["note", "ack", "reply"];

// Sanity bounds for values a client can write into the log. These keep the
// room protocol sane if the engine is ever driven by a real transport.
export const MAX_CLIENT_ID_LENGTH = 64;
export const MAX_LABEL_LENGTH = 64;
export const MAX_TEXT_LENGTH = 4000;

// Events and every value reachable from them are frozen deep: a replay copy,
// a lab trace entry, or a client view must never offer a mutable handle into
// recorded history. Freezing happens at append time, so objects a caller
// passed in are frozen along with the event that stores them.
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  Object.freeze(value);
  return value;
}

// Mulberry32 seeded generator. Same seed, same stream of numbers.
export function createRng(seed = 1) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function charValue(character) {
  return CODE_ALPHABET.indexOf(character);
}

// The sixth character of a room code. Computed from the weighted sum of the
// first five characters, mod the alphabet size.
export function checksumDigit(base) {
  if (typeof base !== "string" || base.length < CODE_BASE_LENGTH) return null;
  let sum = 0;
  for (let i = 0; i < CODE_BASE_LENGTH; i += 1) {
    const value = charValue(base[i]);
    if (value < 0) return null;
    sum = (sum + value * CHECKSUM_WEIGHTS[i]) % CODE_ALPHABET.length;
  }
  return CODE_ALPHABET[sum];
}

export function generateRoomCode(rng) {
  if (typeof rng !== "function") throw new TypeError("generateRoomCode needs a generator function");
  let base = "";
  for (let i = 0; i < CODE_BASE_LENGTH; i += 1) {
    const roll = rng();
    // A generator that returns an out of range or non numeric roll is clamped
    // into the alphabet rather than smuggling undefined into the code.
    const index = Number.isFinite(roll)
      ? Math.min(Math.max(Math.floor(roll * CODE_ALPHABET.length), 0), CODE_ALPHABET.length - 1)
      : 0;
    base += CODE_ALPHABET[index];
  }
  return base + checksumDigit(base);
}

// Typing helpers: case is folded, spaces and hyphens are separators.
export function normalizeRoomCode(input) {
  if (typeof input !== "string") {
    return { ok: false, code: "", reason: "A room code must be a string." };
  }
  const stripped = input.trim().replace(/[\s-]+/g, "");
  // Case folding can expand non ASCII input (a ligature becomes two
  // characters), so fold only plain alphanumerics and let anything else reach
  // the format and charset checks untouched.
  const code = /^[A-Za-z0-9]+$/.test(stripped) ? stripped.toUpperCase() : stripped;
  return { ok: true, code };
}

export function validateRoomCode(input) {
  const normalized = normalizeRoomCode(input);
  const checks = { format: false, charset: false, checksum: false };
  if (!normalized.ok) {
    return { valid: false, code: "", checks, reason: normalized.reason };
  }
  const code = normalized.code;
  if (code.length !== CODE_LENGTH) {
    return {
      valid: false,
      code,
      checks,
      reason: `A room code is ${CODE_LENGTH} characters, got ${code.length}.`
    };
  }
  checks.format = true;
  for (const character of code) {
    if (charValue(character) < 0) {
      return { valid: false, code, checks, reason: `Character ${character} is not in the room alphabet.` };
    }
  }
  checks.charset = true;
  const expected = checksumDigit(code.slice(0, CODE_BASE_LENGTH));
  checks.checksum = expected === code[CODE_BASE_LENGTH];
  if (!checks.checksum) {
    return {
      valid: false,
      code,
      checks,
      reason: `Checksum digit should be ${expected}, found ${code[CODE_BASE_LENGTH]}.`
    };
  }
  return { valid: true, code, checks, reason: "Format, charset and checksum all pass." };
}

// The four virtual devices the lab and the grid share by identity.
export const LAB_CLIENTS = [
  { id: "orchid", label: "Orchid", device: "Phone" },
  { id: "maple", label: "Maple", device: "Laptop" },
  { id: "juniper", label: "Juniper", device: "Tablet" },
  { id: "cobalt", label: "Cobalt", device: "Watch" }
];

export class RelayEngine {
  constructor({ roomCode = "", heartbeatTtlMs = HEARTBEAT_TTL_MS, time = 0 } = {}) {
    this.roomCode = typeof roomCode === "string" ? roomCode : "";
    this.heartbeatTtlMs = heartbeatTtlMs;
    this.time = time;
    this.log = [];
    this.clients = new Map();
    this.nextSeq = 1;
    this.sendSeqs = new Set();
  }

  #members() {
    return [...this.clients.keys()];
  }

  // The members snapshot on an event is the room roster at append time, and
  // its exact contents differ per type: join lists the roster before the
  // joiner enters (the joiner is absent), leave lists the roster before the
  // leaver exits (the leaver is still present), send lists everyone in the
  // room, and heartbeat lists just the sender.
  #append(type, fields) {
    const event = { seq: this.nextSeq, type, time: this.time, ...fields };
    this.nextSeq += 1;
    this.log.push(deepFreeze(event));
    return event;
  }

  join(clientId, { label, device } = {}) {
    const check = validateRoomCode(this.roomCode);
    if (!check.valid) return { ok: false, reason: "The room code is not valid, so nobody can join." };
    if (typeof clientId !== "string" || clientId.trim().length === 0) {
      return { ok: false, reason: "A client id is required." };
    }
    if (clientId.length > MAX_CLIENT_ID_LENGTH) {
      return { ok: false, reason: `A client id is at most ${MAX_CLIENT_ID_LENGTH} characters.` };
    }
    for (const [name, value] of [["label", label], ["device", device]]) {
      if (value !== undefined && (typeof value !== "string" || value.length > MAX_LABEL_LENGTH)) {
        return { ok: false, reason: `A ${name} is a string of at most ${MAX_LABEL_LENGTH} characters.` };
      }
    }
    if (this.clients.has(clientId)) {
      return { ok: false, reason: `${clientId} is already in the room.` };
    }
    const members = this.#members();
    const client = {
      id: clientId,
      label: label || clientId,
      device: device || "Device",
      joinedAt: this.time,
      lastSeen: this.time,
      senderSeq: 0
    };
    this.clients.set(clientId, client);
    const event = this.#append("join", { clientId, label: client.label, device: client.device, members });
    return { ok: true, event };
  }

  leave(clientId, reason = "voluntary") {
    if (!this.clients.has(clientId)) {
      return { ok: false, reason: `${clientId} is not in the room.` };
    }
    const members = this.#members();
    this.clients.delete(clientId);
    const why = typeof reason === "string" && reason.trim().length > 0 ? reason : "voluntary";
    const event = this.#append("leave", { clientId, reason: why, members });
    return { ok: true, event };
  }

  heartbeat(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return { ok: false, reason: `${clientId} is not in the room.` };
    client.lastSeen = this.time;
    const event = this.#append("heartbeat", { clientId, members: [clientId] });
    return { ok: true, event };
  }

  send(clientId, text, { kind = "note", replyTo = null } = {}) {
    const client = this.clients.get(clientId);
    if (!client) return { ok: false, reason: `${clientId} is not in the room.` };
    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, reason: "Message text is required." };
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return { ok: false, reason: `Message text is at most ${MAX_TEXT_LENGTH} characters.` };
    }
    if (!MESSAGE_KINDS.includes(kind)) {
      return { ok: false, reason: `Unknown message kind ${String(kind)}.` };
    }
    if (replyTo !== null && replyTo !== undefined && !this.sendSeqs.has(replyTo)) {
      return { ok: false, reason: `replyTo must be the sequence of an earlier send, got ${String(replyTo)}.` };
    }
    client.senderSeq += 1;
    // Any accepted traffic is a sign of life, so a send refreshes liveness the
    // same way a heartbeat does.
    client.lastSeen = this.time;
    const members = this.#members();
    const event = this.#append("send", { clientId, senderSeq: client.senderSeq, text, kind, replyTo, members });
    this.sendSeqs.add(event.seq);
    return { ok: true, event };
  }

  // Eviction sweep: every client silent for more than the ttl is removed
  // with a leave event carrying reason "stale". Returns the evicted ids. A
  // caller supplied instant is never allowed to run ahead of the clock:
  // events are stamped with engine time, so silence is measured against
  // engine time too.
  sweep(now = this.time) {
    const at = Number.isFinite(Number(now)) ? Math.min(Number(now), this.time) : this.time;
    const evicted = [];
    for (const client of [...this.clients.values()]) {
      const silentFor = at - client.lastSeen;
      if (silentFor > this.heartbeatTtlMs) {
        const members = this.#members();
        this.clients.delete(client.id);
        this.#append("leave", { clientId: client.id, reason: "stale", silentForMs: silentFor, members });
        evicted.push(client.id);
      }
    }
    return evicted;
  }

  // Advance the virtual clock, then sweep. This is the only way time moves.
  // Negative or non numeric deltas are clamped to zero so the log's timestamps
  // stay nondecreasing no matter what a script asks for.
  tick(deltaMs = 0) {
    const delta = Number(deltaMs);
    this.time += Number.isFinite(delta) && delta > 0 ? delta : 0;
    return this.sweep(this.time);
  }

  // Everything after fromSeq, in order, as copies. A rejoining client calls
  // this with the last sequence number it already holds.
  replay(fromSeq = 0) {
    return this.log.filter((event) => event.seq > fromSeq).map((event) => ({ ...event }));
  }

  clientView() {
    return [...this.clients.values()].map((client) => ({ ...client }));
  }

  stats() {
    const counts = { join: 0, leave: 0, send: 0, heartbeat: 0 };
    for (const event of this.log) {
      if (counts[event.type] !== undefined) counts[event.type] += 1;
    }
    return {
      roomCode: this.roomCode,
      time: this.time,
      events: this.log.length,
      clients: this.clients.size,
      counts
    };
  }
}

// Message Lab core. Runs a script of steps against an engine and records a
// decision trace: what was accepted, what was rejected and why, who was
// evicted and what a replay returned.
//
// Step shapes:
//   { op: "join", client, label?, device? }
//   { op: "leave", client, reason? }
//   { op: "send", client, text, kind?, replyTo? }
//   { op: "heartbeat", client }
//   { op: "advance", ms }          move the virtual clock, then sweep
//   { op: "replay", fromSeq }      pull the backlog after fromSeq
export function runScript(engine, script) {
  if (!Array.isArray(script)) throw new TypeError("runScript needs an array of steps");
  const trace = [];
  let lastReplay = [];
  script.forEach((step, index) => {
    const number = index + 1;
    if (step === null || step === undefined) {
      // A missing step must not crash mid run: earlier steps already mutated
      // the engine, so the rejection belongs in the trace.
      trace.push({ step: number, op: null, ok: false, reason: "Malformed step: each step must be an object with an op." });
      return;
    }
    let result;
    switch (step.op) {
      case "join":
        result = engine.join(step.client, { label: step.label, device: step.device });
        break;
      case "leave":
        result = engine.leave(step.client, step.reason);
        break;
      case "send":
        result = engine.send(step.client, step.text ?? "", { kind: step.kind, replyTo: step.replyTo ?? null });
        break;
      case "heartbeat":
        result = engine.heartbeat(step.client);
        break;
      case "advance": {
        const ms = step.ms ?? 0;
        const evicted = engine.tick(ms);
        result = { ok: true, ms, evicted };
        break;
      }
      case "replay": {
        lastReplay = engine.replay(step.fromSeq ?? 0);
        const first = lastReplay.length > 0 ? lastReplay[0].seq : null;
        const last = lastReplay.length > 0 ? lastReplay[lastReplay.length - 1].seq : null;
        result = { ok: true, count: lastReplay.length, first, last };
        break;
      }
      default:
        result = { ok: false, reason: `Unknown op ${String(step.op)}.` };
    }
    trace.push({ step: number, op: step.op, ok: result.ok !== false, ...result });
    if (result.event) {
      // Flatten the accepted event into the trace entry so the lab can quote
      // sequence numbers, senders and recipient lanes directly.
      Object.assign(trace[trace.length - 1], result.event);
    }
  });
  return { trace, replay: lastReplay };
}

// Preset scripts the Message Lab ships with. The test suite runs these exact
// scripts, so the UI demonstrates what the tests verify.
export const LAB_PRESETS = {
  ordering: [
    { op: "join", client: "orchid" },
    { op: "join", client: "maple" },
    { op: "join", client: "juniper" },
    { op: "send", client: "orchid", text: "First from Orchid." },
    { op: "send", client: "maple", text: "First from Maple." },
    { op: "send", client: "orchid", text: "Second from Orchid." },
    { op: "send", client: "juniper", text: "First from Juniper." },
    { op: "send", client: "maple", text: "Second from Maple." }
  ],
  eviction: [
    { op: "join", client: "orchid" },
    { op: "join", client: "cobalt" },
    { op: "advance", ms: 4000 },
    { op: "heartbeat", client: "orchid" },
    { op: "advance", ms: 4000 },
    { op: "heartbeat", client: "orchid" },
    { op: "advance", ms: 3000 },
    { op: "send", client: "cobalt", text: "Anyone there?" }
  ],
  replay: [
    { op: "join", client: "orchid" },
    { op: "join", client: "maple" },
    { op: "send", client: "orchid", text: "Maple, the queue is open." },
    { op: "send", client: "maple", text: "Copy, joining the queue." },
    { op: "leave", client: "maple" },
    { op: "send", client: "orchid", text: "Two items processed since you left." },
    { op: "send", client: "orchid", text: "Third item logged." },
    { op: "join", client: "maple" },
    { op: "replay", fromSeq: 4 }
  ]
};
