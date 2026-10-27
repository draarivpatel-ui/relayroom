// RelayRoom app wiring.
//
// The engine (engine.js) is deterministic and clock driven. This file drives
// it from a page local scheduler: a virtual clock advanced in small chunks,
// four virtual devices with seeded behavior, the Message Lab, and the Code
// Validator. Everything runs in this tab with no network.

import {
  CODE_ALPHABET,
  HEARTBEAT_TTL_MS,
  LAB_CLIENTS,
  LAB_PRESETS,
  RelayEngine,
  charValue,
  checksumDigit,
  createRng,
  generateRoomCode,
  runScript,
  validateRoomCode
} from "./engine.js";

const $ = (id) => document.getElementById(id);

const LANE_IDS = LAB_CLIENTS.map((client) => client.id);
const NAMES = Object.fromEntries(LAB_CLIENTS.map((client) => [client.id, client.label]));
const TYPE_LABELS = { send: "Send", join: "Join", leave: "Leave", heartbeat: "Ping" };
const MAX_STREAM_ROWS = 220;

const DEVICES = [
  {
    id: "orchid",
    label: "Orchid",
    device: "Phone",
    blurb: "Short field notes and quick pings.",
    pool: [
      "Signal looks clean from here.",
      "Logging a route check now.",
      "Anyone else seeing the delay?",
      "Field note: the north path is quiet.",
      "Copy that, keeping watch."
    ]
  },
  {
    id: "maple",
    label: "Maple",
    device: "Laptop",
    blurb: "Status lines and frequent replies.",
    pool: [
      "Composing the summary in a moment.",
      "Buffer is clear on my side.",
      "Rebuilt the queue, order held.",
      "That reply landed before my ping.",
      "Saving the trace for the report."
    ]
  },
  {
    id: "juniper",
    label: "Juniper",
    device: "Tablet",
    blurb: "Plans first, acknowledgements second.",
    pool: [
      "Plan sketch is up next.",
      "Acknowledged, waiting on Maple.",
      "Two hops, no drops so far.",
      "Marking the checklist item done.",
      "Order looks strict from here."
    ]
  },
  {
    id: "cobalt",
    label: "Cobalt",
    device: "Watch",
    blurb: "Tiny pings on a slow heartbeat.",
    pool: [
      "Tick. All quiet.",
      "Heartbeat steady.",
      "Battery fine, signal fine.",
      "Short hop, fast ack.",
      "Pinging to stay fresh."
    ]
  }
];

const REPLY_TEMPLATES = [
  "On seq {n}: same reading here.",
  "About seq {n}: checking now.",
  "Replying to seq {n}: agreed.",
  "On seq {n}: copy that."
];

const DEVICE_ICONS = {
  Phone:
    '<svg class="device-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><rect x="6" y="2.5" width="8" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 15.2h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  Laptop:
    '<svg class="device-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><rect x="4" y="4" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 16h15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  Tablet:
    '<svg class="device-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><rect x="4.5" y="2.5" width="11" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.5 15h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  Watch:
    '<svg class="device-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><rect x="5.5" y="5.5" width="9" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 5.5 8 2.5h4l.5 3M7.5 14.5 8 17.5h4l.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
};

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

function fmtClock(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function pick(pool, rng) {
  return pool[Math.floor(rng() * pool.length)];
}

/* Room code tiles */

function renderCodeTiles(code) {
  const tiles = $("code-tiles");
  tiles.replaceChildren();
  [...code].forEach((character, index) => {
    const tile = document.createElement("span");
    tile.className = index === 5 ? "code-tile is-checksum" : "code-tile";
    tile.textContent = character;
    tiles.append(tile);
  });
  tiles.setAttribute("aria-label", `Room code ${[...code].join(" ")}, the last character is the checksum digit`);
}

/* Event rows, shared by the main stream and the lab stream */

function buildEventRow(event) {
  const li = document.createElement("li");
  li.className = "event";
  li.dataset.type = event.type;
  if (event.clientId && LANE_IDS.includes(event.clientId)) li.dataset.lane = event.clientId;
  if (event.type === "leave" && event.reason === "stale") li.dataset.stale = "true";

  const seq = document.createElement("span");
  seq.className = "event-seq";
  seq.textContent = String(event.seq).padStart(4, "0");

  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = fmtClock(event.time);

  const lane = document.createElement("span");
  lane.className = "event-lane";
  lane.textContent = event.clientId ? NAMES[event.clientId] ?? event.clientId : "Room";

  const type = document.createElement("span");
  type.className = "event-type";
  type.textContent = TYPE_LABELS[event.type] ?? event.type;

  const content = document.createElement("div");
  content.className = "event-content";
  if (event.clientId) content.dataset.laneName = NAMES[event.clientId] ?? event.clientId;

  const appendMeta = (text) => {
    const meta = document.createElement("span");
    meta.className = "event-meta";
    meta.textContent = text;
    content.append(meta);
  };

  if (event.type === "send") {
    const text = document.createElement("span");
    text.textContent = event.text;
    content.append(text);
    const recipients = event.members.filter((id) => id !== event.clientId).length;
    const bits = [event.kind];
    if (event.replyTo) bits.push(`reply to ${event.replyTo}`);
    bits.push(`${recipients} of ${event.members.length} lanes`);
    appendMeta(bits.join(", "));
  } else if (event.type === "join") {
    content.append(`${event.label} joined as ${event.device}.`);
    appendMeta(`${event.members.length} lanes present before.`);
  } else if (event.type === "leave") {
    if (event.reason === "stale") {
      content.append(`${event.label ?? NAMES[event.clientId]} went silent for ${fmtMs(event.silentForMs)}.`);
    } else {
      content.append(`${event.label ?? NAMES[event.clientId]} left the room.`);
    }
    appendMeta(`reason: ${event.reason}`);
  } else {
    content.append("Ping.");
  }

  const fanout = document.createElement("div");
  fanout.className = "fanout";
  fanout.setAttribute("aria-hidden", "true");
  let lit = [];
  let self = null;
  if (event.type === "send") {
    lit = event.members.filter((id) => id !== event.clientId);
    self = event.clientId;
  } else if (event.type === "join") {
    lit = event.members;
    self = event.clientId;
  } else if (event.type === "leave") {
    lit = event.members.filter((id) => id !== event.clientId);
    self = event.clientId;
  } else if (event.type === "heartbeat") {
    self = event.clientId;
  }
  for (const id of LANE_IDS) {
    const cell = document.createElement("span");
    cell.className = "cell";
    if (id === self) cell.classList.add("is-self");
    else if (lit.includes(id)) cell.classList.add("is-lit");
    cell.style.setProperty("--cell-lane", `var(--lane-${id})`);
    fanout.append(cell);
  }

  li.append(seq, time, lane, type, content, fanout);
  return li;
}

/* Main simulation */

const sim = {
  roomCode: "",
  engine: null,
  devices: [],
  rng: null,
  running: true,
  speed: 1,
  lastReal: performance.now(),
  renderedCount: 0,
  follow: true,
  filters: { send: true, system: true, heartbeat: false },
  evictionNote: "",
  evictionAt: -999999
};

const streamList = $("stream-list");
const streamScroll = $("stream-scroll");

function newRoomCode() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  return generateRoomCode(createRng(seed));
}

function resetSim() {
  sim.rng = createRng((Math.random() * 0xffffffff) >>> 0);
  sim.engine = new RelayEngine({ roomCode: sim.roomCode });
  sim.devices = DEVICES.map((device, order) => ({
    ...device,
    order,
    present: true,
    stalled: false,
    sent: 0,
    received: 0,
    lastMessage: "",
    lastBeatAt: 0,
    nextBeat: 2400 + order * 300,
    nextSend: 2600 + sim.rng() * 5200,
    pending: []
  }));
  sim.renderedCount = 0;
  sim.evictionNote = "";
  sim.evictionAt = -999999;
  streamList.replaceChildren();
  for (const device of sim.devices) {
    sim.engine.join(device.id, { label: device.label, device: device.device });
  }
  drainStream();
  updateDeviceCards();
  updateStatus();
}

function advanceChunk(chunk) {
  const engine = sim.engine;
  const t0 = engine.time;
  const t1 = t0 + chunk;
  const due = [];
  for (const device of sim.devices) {
    if (!device.present) continue;
    if (!device.stalled && device.nextBeat <= t1) {
      due.push({ t: device.nextBeat, device, kind: "beat" });
    }
    if (device.nextSend <= t1) {
      due.push({ t: device.nextSend, device, kind: "send" });
    }
    device.pending.forEach((item) => {
      if (item.t <= t1) due.push({ t: item.t, device, kind: "pending", item });
    });
  }
  due.sort((a, b) => a.t - b.t || a.device.order - b.device.order);
  for (const item of due) {
    engine.time = item.t;
    if (item.kind === "beat") {
      sim.engine.heartbeat(item.device.id);
      item.device.lastBeatAt = item.t;
      item.device.nextBeat = item.t + 3000;
    } else if (item.kind === "send") {
      const text = pick(item.device.pool, sim.rng);
      sim.engine.send(item.device.id, text, { kind: "note" });
      item.device.nextSend = item.t + 4000 + sim.rng() * 6000;
    } else {
      const index = item.device.pending.indexOf(item.item);
      if (index >= 0) item.device.pending.splice(index, 1);
      sim.engine.send(item.device.id, item.item.text, { kind: item.item.kind, replyTo: item.item.replyTo });
    }
  }
  engine.time = t1;
  const evicted = engine.sweep(t1);
  for (const id of evicted) {
    const device = sim.devices.find((d) => d.id === id);
    if (device) {
      device.present = false;
      device.pending = [];
      sim.evictionNote = `${device.label} went stale and was evicted.`;
      sim.evictionAt = t1;
    }
  }
}

function drainStream() {
  const newEvents = sim.engine.log.slice(sim.renderedCount);
  sim.renderedCount = sim.engine.log.length;
  if (newEvents.length === 0) return;
  for (const event of newEvents) {
    const row = buildEventRow(event);
    row.hidden = !streamFiltersAllow(event.type);
    streamList.append(row);
    if (event.type === "send") scheduleReactions(event);
  }
  while (streamList.children.length > MAX_STREAM_ROWS) {
    streamList.firstChild.remove();
  }
  if (sim.follow) streamScroll.scrollTop = streamScroll.scrollHeight;
}

function scheduleReactions(event) {
  const sender = sim.devices.find((device) => device.id === event.clientId);
  if (sender) {
    sender.sent += 1;
    sender.lastMessage = event.text;
  }
  // Devices react to notes. Reactions to reactions would cascade, so
  // acknowledgements and replies never trigger further reactions.
  if (event.kind !== "note") return;
  for (const other of sim.devices) {
    if (other.id === event.clientId || !other.present) continue;
    if (!event.members.includes(other.id)) continue;
    other.received += 1;
    if (other.pending.length >= 4) continue;
    const roll = sim.rng();
    if (roll < 0.4) {
      other.pending.push({
        t: event.time + 500 + sim.rng() * 1200,
        kind: "ack",
        text: `Ack, seq ${event.seq}.`,
        replyTo: event.seq
      });
    } else if (roll < 0.62) {
      const template = pick(REPLY_TEMPLATES, sim.rng);
      other.pending.push({
        t: event.time + 900 + sim.rng() * 1800,
        kind: "reply",
        text: template.replace("{n}", String(event.seq)),
        replyTo: event.seq
      });
    }
  }
}

function streamFiltersAllow(type) {
  if (type === "send") return sim.filters.send;
  if (type === "heartbeat") return sim.filters.heartbeat;
  return sim.filters.system;
}

function applyStreamFilters() {
  for (const row of streamList.children) {
    row.hidden = !streamFiltersAllow(row.dataset.type);
  }
}

function updateDeviceCards() {
  const laggingAfter = HEARTBEAT_TTL_MS * 0.6;
  for (const device of sim.devices) {
    const card = device.card;
    const age = sim.engine.time - device.lastBeatAt;
    let state = "active";
    if (!device.present) state = "offline";
    else if (device.stalled) state = "stalled";
    else if (age > laggingAfter) state = "lagging";
    card.dataset.state = state;
    card.querySelector('[data-field="status"]').textContent =
      state === "offline" ? "Offline" : state === "stalled" ? "Stalled" : state === "lagging" ? "Lagging" : "Active";
    card.querySelector('[data-field="age"]').textContent = device.present ? fmtMs(age) : "gone";
    card.querySelector('[data-field="sent"]').textContent = String(device.sent);
    card.querySelector('[data-field="got"]').textContent = String(device.received);
    card.querySelector('[data-field="last"]').textContent = device.lastMessage || "No messages yet.";
    const button = card.querySelector('[data-field="action"]');
    if (!device.present) {
      button.textContent = "Rejoin";
      button.setAttribute("aria-label", `Rejoin the room as ${device.label}`);
    } else if (device.stalled) {
      button.textContent = "Resume";
      button.setAttribute("aria-label", `Resume heartbeats for ${device.label}`);
    } else {
      button.textContent = "Stall";
      button.setAttribute("aria-label", `Stall heartbeats for ${device.label}`);
    }
  }
}

function updateStatus() {
  const present = sim.devices.filter((device) => device.present).length;
  const sends = sim.engine.stats().counts.send;
  const parts = [
    sim.running ? "Running" : "Paused",
    `${present} of 4 devices active`,
    `${sends} messages relayed`
  ];
  if (sim.evictionNote && sim.engine.time - sim.evictionAt < 12000) parts.push(sim.evictionNote);
  $("sim-status").textContent = `${parts.join(". ")}.`;
}

function buildDeviceCards() {
  const grid = $("device-grid");
  grid.replaceChildren();
  for (const device of DEVICES) {
    const card = document.createElement("article");
    card.className = "device-card";
    card.dataset.lane = device.id;
    card.dataset.state = "active";

    const head = document.createElement("div");
    head.className = "device-head";
    head.innerHTML = DEVICE_ICONS[device.device] ?? "";
    const nameWrap = document.createElement("div");
    const name = document.createElement("p");
    name.className = "device-name";
    name.textContent = device.label;
    const kind = document.createElement("p");
    kind.className = "device-kind";
    kind.textContent = device.device;
    nameWrap.append(name, kind);
    const status = document.createElement("span");
    status.className = "device-status";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const statusText = document.createElement("span");
    statusText.setAttribute("data-field", "status");
    statusText.textContent = "Active";
    status.append(dot, statusText);
    head.append(nameWrap, status);

    const blurb = document.createElement("p");
    blurb.className = "device-blurb";
    blurb.textContent = device.blurb;

    const metrics = document.createElement("div");
    metrics.className = "device-metrics";
    const metric = (label, field) => {
      const span = document.createElement("span");
      span.append(label, " ");
      const strong = document.createElement("strong");
      strong.setAttribute("data-field", field);
      strong.textContent = "0";
      span.append(strong);
      return span;
    };
    metrics.append(metric("Ping", "age"), metric("Sent", "sent"), metric("Got", "got"));

    const last = document.createElement("p");
    last.className = "device-last";
    last.setAttribute("data-field", "last");
    last.textContent = "No messages yet.";

    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn btn-small device-action";
    action.setAttribute("data-field", "action");
    action.textContent = "Stall";
    action.addEventListener("click", () => {
      // Resolve the runtime copy: resetSim rebuilds sim.devices from the
      // template list, so the closure must not mutate the template itself.
      const runtime = sim.devices.find((candidate) => candidate.id === device.id);
      if (!runtime) return;
      if (!runtime.present) {
        const result = sim.engine.join(runtime.id, { label: runtime.label, device: runtime.device });
        if (result.ok) {
          runtime.present = true;
          runtime.stalled = false;
          runtime.lastBeatAt = sim.engine.time;
          runtime.nextBeat = sim.engine.time + 800;
          runtime.nextSend = sim.engine.time + 1500 + sim.rng() * 3000;
        }
      } else if (!runtime.stalled) {
        runtime.stalled = true;
      } else {
        runtime.stalled = false;
        runtime.nextBeat = sim.engine.time + 800;
      }
      updateDeviceCards();
    });

    card.append(head, blurb, metrics, last, action);
    grid.append(card);
    device.card = card;
  }
}

function stepFrame() {
  const now = performance.now();
  const dtReal = Math.min(now - sim.lastReal, 250);
  sim.lastReal = now;
  if (sim.running) {
    let remaining = dtReal * sim.speed;
    let guard = 0;
    while (remaining > 0.01 && guard < 40) {
      const chunk = Math.min(remaining, 100);
      advanceChunk(chunk);
      remaining -= chunk;
      guard += 1;
    }
    drainStream();
    updateStatus();
  }
  updateDeviceCards();
}

/* Message Lab */

const lab = {
  roomCode: "",
  engine: null,
  steps: [],
  cursor: 0,
  renderedLog: 0
};

const OP_CHOICES = [
  { value: "send", label: "Send" },
  { value: "join", label: "Join" },
  { value: "leave", label: "Leave" },
  { value: "heartbeat", label: "Heartbeat" },
  { value: "advance", label: "Advance Clock" },
  { value: "replay", label: "Replay" }
];

const OP_DEFAULTS = {
  send: { client: "maple", text: "A scripted note." },
  join: { client: "juniper" },
  leave: { client: "juniper" },
  heartbeat: { client: "orchid" },
  advance: { ms: 4000 },
  replay: { fromSeq: 0 }
};

function labReset(message) {
  lab.engine = new RelayEngine({ roomCode: lab.roomCode });
  lab.cursor = 0;
  lab.renderedLog = 0;
  $("lab-trace").replaceChildren();
  $("lab-stream").replaceChildren();
  $("lab-status").textContent = message ?? "The lab room is fresh.";
}

function loadPreset(name) {
  lab.steps = LAB_PRESETS[name].map((step) => ({ ...step }));
  labReset();
  renderLabSteps();
  $("lab-status").textContent = `Loaded the ${name} preset, ${lab.steps.length} steps. Run One Step or Run All Steps.`;
}

function renderLabSteps() {
  const list = $("lab-steps");
  list.replaceChildren();
  lab.steps.forEach((step, index) => {
    const li = document.createElement("li");
    li.className = "lab-step";

    const no = document.createElement("span");
    no.className = "step-no";
    no.textContent = String(index + 1);

    const opSelect = document.createElement("select");
    opSelect.className = "select";
    opSelect.setAttribute("aria-label", `Step ${index + 1} action`);
    for (const choice of OP_CHOICES) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      if (step.op === choice.value) option.selected = true;
      opSelect.append(option);
    }
    opSelect.addEventListener("change", () => {
      const next = { op: opSelect.value, ...OP_DEFAULTS[opSelect.value] };
      lab.steps[index] = next;
      renderLabSteps();
    });

    const clientSelect = document.createElement("select");
    clientSelect.className = "select";
    clientSelect.setAttribute("aria-label", `Step ${index + 1} device`);
    for (const client of LAB_CLIENTS) {
      const option = document.createElement("option");
      option.value = client.id;
      option.textContent = `${client.label} ${client.device}`;
      if ((step.client ?? "orchid") === client.id) option.selected = true;
      clientSelect.append(option);
    }
    clientSelect.addEventListener("change", () => {
      lab.steps[index].client = clientSelect.value;
    });
    if (step.op === "advance" || step.op === "replay") clientSelect.hidden = true;

    const input = document.createElement("input");
    input.className = "input";
    if (step.op === "send") {
      input.type = "text";
      input.value = step.text ?? "";
      input.placeholder = "Message text";
      input.setAttribute("aria-label", `Step ${index + 1} message text`);
      input.addEventListener("input", () => {
        lab.steps[index].text = input.value;
      });
    } else if (step.op === "advance") {
      input.type = "number";
      input.min = "0";
      input.step = "0.5";
      input.value = String((step.ms ?? 0) / 1000);
      input.setAttribute("aria-label", `Step ${index + 1} clock advance in seconds`);
      input.addEventListener("input", () => {
        const seconds = Number(input.value);
        lab.steps[index].ms = Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0;
      });
    } else if (step.op === "replay") {
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.value = String(step.fromSeq ?? 0);
      input.setAttribute("aria-label", `Step ${index + 1} replay start sequence`);
      input.addEventListener("input", () => {
        const from = Number(input.value);
        lab.steps[index].fromSeq = Number.isFinite(from) && from >= 0 ? Math.floor(from) : 0;
      });
    } else {
      input.hidden = true;
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "step-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove step ${index + 1}`);
    remove.addEventListener("click", () => {
      lab.steps.splice(index, 1);
      renderLabSteps();
    });

    li.append(no, opSelect, clientSelect, input, remove);
    list.append(li);
  });
}

function clientLabel(id) {
  return NAMES[id] ?? id;
}

function explainTrace(entry) {
  if (!entry.ok) return `Rejected. ${entry.reason ?? "The step did not go through."}`;
  const who = clientLabel(entry.clientId);
  switch (entry.op) {
    case "join":
      return `Accepted at sequence ${entry.seq}. ${entry.label ?? who} enters the room.`;
    case "leave":
      return `Recorded at sequence ${entry.seq}. ${who} leaves (${entry.reason}).`;
    case "send": {
      const recipients = entry.members ? entry.members.filter((id) => id !== entry.clientId).length : 0;
      return `Accepted at sequence ${entry.seq}, sender sequence ${entry.senderSeq}, ${recipients} lanes receive it.`;
    }
    case "heartbeat":
      return `Ping recorded at sequence ${entry.seq}. ${who} stays fresh.`;
    case "advance": {
      if (entry.evicted && entry.evicted.length > 0) {
        const names = entry.evicted.map(clientLabel).join(", ");
        return `Clock moved ${fmtMs(entry.ms)}. The sweep evicted ${names} for silence.`;
      }
      return `Clock moved ${fmtMs(entry.ms)}. Nobody went stale.`;
    }
    case "replay":
      if (entry.count > 0) {
        return `Returned ${entry.count} events, sequences ${entry.first} to ${entry.last}.`;
      }
      return "Nothing to replay after that sequence.";
    default:
      return entry.reason ?? "Unknown step.";
  }
}

function appendLabTrace(entries) {
  const traceList = $("lab-trace");
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "trace-entry";
    li.dataset.ok = String(entry.ok);
    li.dataset.op = String(entry.op);
    const no = document.createElement("span");
    no.className = "step-no";
    no.textContent = String(entry.step);
    const body = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = explainTrace(entry);
    const op = document.createElement("span");
    op.className = "trace-op";
    op.textContent = `op: ${entry.op}`;
    body.append(text, op);
    li.append(no, body);
    traceList.append(li);
  }
}

function appendLabEvents() {
  const stream = $("lab-stream");
  const newEvents = lab.engine.log.slice(lab.renderedLog);
  lab.renderedLog = lab.engine.log.length;
  for (const event of newEvents) stream.append(buildEventRow(event));
  while (stream.children.length > MAX_STREAM_ROWS) stream.firstChild.remove();
  stream.scrollTop = stream.scrollHeight;
}

function runLabSteps(steps, label) {
  const result = runScript(lab.engine, steps);
  appendLabTrace(result.trace);
  appendLabEvents();
  const accepted = result.trace.filter((entry) => entry.ok).length;
  const rejected = result.trace.length - accepted;
  if (label === "all") {
    $("lab-status").textContent = `Ran ${result.trace.length} steps: ${accepted} accepted, ${rejected} rejected.`;
  } else if (result.trace.length > 0) {
    $("lab-status").textContent = `Step ${result.trace[0].step}: ${result.trace[0].ok ? "accepted" : "rejected"}.`;
  }
}

function labInit() {
  lab.roomCode = newRoomCode();
  $("lab-code").textContent = `Room ${lab.roomCode}`;
  loadPreset("ordering");
}

/* Code Validator */

const validatorInput = $("validator-input");
const verdict = $("verdict");

function setCheck(id, state, text) {
  const check = $(id);
  check.dataset.state = state;
  check.querySelector("dd").textContent = text;
}

function updateValidator() {
  const raw = validatorInput.value;
  if (raw.trim() === "") {
    verdict.textContent = "Type a six character code.";
    verdict.removeAttribute("data-valid");
    setCheck("check-format", "idle", "Six characters.");
    setCheck("check-charset", "idle", "From the 31 character alphabet.");
    setCheck("check-checksum", "idle", "The sixth character matches the weighted sum.");
    return;
  }
  const result = validateRoomCode(raw);
  const checks = result.checks;
  if (checks.format) setCheck("check-format", "pass", "Six characters.");
  else setCheck("check-format", "fail", result.code ? `${result.code.length} characters after cleanup.` : "Six characters.");

  if (checks.format && checks.charset) setCheck("check-charset", "pass", "Every character is in the alphabet.");
  else if (checks.format) {
    const bad = [...result.code].find((character) => charValue(character) < 0);
    setCheck("check-charset", "fail", `${bad} is not in the alphabet.`);
  } else setCheck("check-charset", "idle", "Waiting on format.");

  if (checks.format && checks.charset) {
    const expected = checksumDigit(result.code.slice(0, 5));
    setCheck("check-checksum", checks.checksum ? "pass" : "fail", `Expected ${expected}, found ${result.code[5]}.`);
  } else setCheck("check-checksum", "idle", "Waiting on format and charset.");

  verdict.textContent = result.reason;
  verdict.dataset.valid = String(result.valid);
}

function setStat(key, value) {
  const field = document.querySelector(`#sweep-results [data-stat="${key}"]`);
  if (field) field.textContent = value;
}

function runSweep() {
  const button = $("btn-sweep");
  button.disabled = true;
  const started = performance.now();
  const rng = createRng(20261029);
  const seen = new Set();
  let valid = 0;
  for (let i = 0; i < 1000; i += 1) {
    const code = generateRoomCode(rng);
    if (validateRoomCode(code).valid) valid += 1;
    seen.add(code);
  }
  let rejected = 0;
  for (const code of seen) {
    for (let position = 0; position < 6; position += 1) {
      const mutated =
        code.slice(0, position) +
        CODE_ALPHABET[(charValue(code[position]) + 1) % CODE_ALPHABET.length] +
        code.slice(position + 1);
      if (!validateRoomCode(mutated).valid) rejected += 1;
    }
  }
  const elapsed = performance.now() - started;
  setStat("generated", "1,000");
  setStat("valid", String(valid));
  setStat("unique", String(seen.size));
  setStat("mutations", String(rejected));
  setStat("time", elapsed < 10 ? `${elapsed.toFixed(1)} ms` : `${Math.round(elapsed)} ms`);
  button.disabled = false;
}

/* Wiring */

function wire() {
  $("btn-run").addEventListener("click", () => {
    sim.running = !sim.running;
    $("btn-run").textContent = sim.running ? "Pause" : "Run";
    updateStatus();
  });

  $("btn-reset").addEventListener("click", () => resetSim());

  $("btn-new-code").addEventListener("click", () => {
    sim.roomCode = newRoomCode();
    renderCodeTiles(sim.roomCode);
    resetSim();
  });

  $("speed").addEventListener("change", (event) => {
    sim.speed = Number(event.target.value) || 1;
  });

  const filterButtons = [
    ["filter-messages", "send"],
    ["filter-system", "system"],
    ["filter-heartbeats", "heartbeat"]
  ];
  for (const [buttonId, bucket] of filterButtons) {
    $(buttonId).addEventListener("click", () => {
      sim.filters[bucket] = !sim.filters[bucket];
      $(buttonId).setAttribute("aria-pressed", String(sim.filters[bucket]));
      applyStreamFilters();
    });
  }

  $("btn-follow").addEventListener("click", () => {
    sim.follow = !sim.follow;
    $("btn-follow").setAttribute("aria-pressed", String(sim.follow));
    if (sim.follow) streamScroll.scrollTop = streamScroll.scrollHeight;
  });

  streamScroll.addEventListener("scroll", () => {
    const distance = streamScroll.scrollHeight - streamScroll.scrollTop - streamScroll.clientHeight;
    if (sim.follow && distance > 140) {
      sim.follow = false;
      $("btn-follow").setAttribute("aria-pressed", "false");
    }
  });

  $("btn-add-step").addEventListener("click", () => {
    lab.steps.push({ op: "send", ...OP_DEFAULTS.send });
    renderLabSteps();
  });

  $("btn-step-one").addEventListener("click", () => {
    if (lab.cursor >= lab.steps.length) {
      $("lab-status").textContent = "No steps left. Add a step or load a preset.";
      return;
    }
    runLabSteps([lab.steps[lab.cursor]], "one");
    lab.cursor += 1;
  });

  $("btn-run-all").addEventListener("click", () => {
    if (lab.cursor >= lab.steps.length) {
      $("lab-status").textContent = "Every step has run. Reset the lab to go again.";
      return;
    }
    runLabSteps(lab.steps.slice(lab.cursor), "all");
    lab.cursor = lab.steps.length;
  });

  $("btn-lab-reset").addEventListener("click", () => {
    labReset(`${lab.steps.length} steps loaded, nothing run yet.`);
  });

  $("btn-preset-ordering").addEventListener("click", () => loadPreset("ordering"));
  $("btn-preset-eviction").addEventListener("click", () => loadPreset("eviction"));
  $("btn-preset-replay").addEventListener("click", () => loadPreset("replay"));

  validatorInput.addEventListener("input", updateValidator);
  $("btn-sweep").addEventListener("click", runSweep);

  document.addEventListener("visibilitychange", () => {
    sim.lastReal = performance.now();
  });
}

/* Init */

sim.roomCode = newRoomCode();
renderCodeTiles(sim.roomCode);
buildDeviceCards();
resetSim();
labInit();
updateValidator();
wire();
setInterval(stepFrame, 100);
