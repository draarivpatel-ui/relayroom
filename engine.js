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
    base += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return base + checksumDigit(base);
}

// Typing helpers: case is folded, spaces and hyphens are separators.
export function normalizeRoomCode(input) {
  if (typeof input !== "string") {
    return { ok: false, code: "", reason: "A room code must be a string." };
  }
  const code = input.trim().toUpperCase().replace(/[\s-]+/g, "");
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
  }

  #members() {
    return [...this.clients.keys()];
  }

  #append(type, fields) {
    const event = { seq: this.nextSeq, type, time: this.time, ...fields };
    this.nextSeq += 1;
    this.log.push(event);
    return event;
  }

  join(clientId, { label, device } = {}) {
    const check = validateRoomCode(this.roomCode);
    if (!check.valid) return { ok: false, reason: "The room code is not valid, so nobody can join." };
    if (typeof clientId !== "string" || clientId.length === 0) {
      return { ok: false, reason: "A client id is required." };
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
    const event = this.#append("leave", { clientId, reason, members });
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
    if (!MESSAGE_KINDS.includes(kind)) {
      return { ok: false, reason: `Unknown message kind ${String(kind)}.` };
    }
    client.senderSeq += 1;
    const members = this.#members();
    const event = this.#append("send", { clientId, senderSeq: client.senderSeq, text, kind, replyTo, members });
    return { ok: true, event };
  }

  // Eviction sweep: every client silent for more than the ttl is removed
  // with a leave event carrying reason "stale". Returns the evicted ids.
  sweep(now = this.time) {
    const evicted = [];
    for (const client of [...this.clients.values()]) {
      const silentFor = now - client.lastSeen;
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
  tick(deltaMs = 0) {
    this.time += deltaMs;
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
