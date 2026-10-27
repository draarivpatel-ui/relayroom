import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const ENGINE_JS = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = '';
    this.textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.type = '';
    this.min = '';
    this.step = '';
    this.placeholder = '';
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.scrollTop = 0;
    this.scrollHeight = 400;
    this.clientHeight = 200;
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.children = [];
    this.style = { setProperty() {} };
    this.classList = {
      _set: new Set(),
      add: (...names) => names.forEach((n) => this.classList._set.add(n)),
      remove: (...names) => names.forEach((n) => this.classList._set.delete(n)),
      contains: (n) => this.classList._set.has(n)
    };
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(val) {
    this._innerHTML = String(val);
  }
  get firstChild() {
    return this.children[0] || null;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const span = new FakeEl('span');
        span.textContent = n;
        this.children.push(span);
      } else if (n) {
        n._parent = this;
        this.children.push(n);
      }
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this._parent) {
      const idx = this._parent.children.indexOf(this);
      if (idx >= 0) this._parent.children.splice(idx, 1);
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[camel];
    }
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, extra = {}) {
    for (const fn of this.listeners[type] || []) {
      fn(Object.assign({ target: this, preventDefault() {} }, extra));
    }
  }
  querySelector(sel) {
    if (sel === 'dd') {
      return this.children.find((c) => c.tagName === 'DD') || new FakeEl('dd');
    }
    const fieldMatch = /^\[data-field="([^"]+)"\]$/.exec(sel);
    if (fieldMatch) {
      return this._find((el) => el.dataset && el.dataset.field === fieldMatch[1]);
    }
    const statMatch = /^#sweep-results \[data-stat="([^"]+)"\]$/.exec(sel);
    if (statMatch) {
      return this._find((el) => el.dataset && el.dataset.stat === statMatch[1]);
    }
    return null;
  }
  _find(pred) {
    for (const child of this.children) {
      if (pred(child)) return child;
      if (child._find) {
        const found = child._find(pred);
        if (found) return found;
      }
    }
    return null;
  }
}

function setupFakeDom() {
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) {
      const el = new FakeEl('div', id);
      if (id.startsWith('check-')) {
        const dt = new FakeEl('dt');
        const dd = new FakeEl('dd');
        el.append(dt, dd);
      }
      if (id === 'sweep-results') {
        for (const stat of ['generated', 'valid', 'unique', 'mutations', 'time']) {
          const wrap = new FakeEl('div');
          const dd = new FakeEl('dd');
          dd.dataset.stat = stat;
          dd.textContent = '0';
          wrap.append(dd);
          el.append(wrap);
        }
      }
      if (id === 'speed') {
        el.value = '1';
      }
      els.set(id, el);
    }
    return els.get(id);
  };

  for (const m of HTML.matchAll(/\bid="([^"]+)"/g)) {
    getEl(m[1]);
  }

  let intervalCallback = null;
  globalThis.document = {
    getElementById: (id) => getEl(id),
    createElement: (tag) => new FakeEl(tag),
    querySelector: (sel) => {
      const statMatch = /^#sweep-results \[data-stat="([^"]+)"\]$/.exec(sel);
      if (statMatch) {
        return getEl('sweep-results')._find((el) => el.dataset && el.dataset.stat === statMatch[1]);
      }
      return null;
    },
    addEventListener() {}
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => {
    intervalCallback = fn;
    return 1;
  };
  return { els, getEl, getInterval: () => intervalCallback, restore: () => { globalThis.setInterval = realSetInterval; } };
}

test('DOM shell: doctype, html lang, charset, viewport, and title', () => {
  assert.match(HTML, /^<!doctype html>/i);
  assert.match(HTML, /<html lang="en">/);
  assert.match(HTML, /<meta charset="utf-8"/i);
  assert.match(HTML, /<meta name="viewport"/);
  assert.match(HTML, /<title>RelayRoom: Four Devices, One Room<\/title>/);
});

test('DOM shell: OpenGraph and Twitter card metadata are complete', () => {
  assert.match(HTML, /property="og:title"/);
  assert.match(HTML, /property="og:description"/);
  assert.match(HTML, /property="og:type" content="website"/);
  assert.match(HTML, /name="twitter:card" content="summary"/);
});

test('DOM shell: skip link and noscript fallback banner exist', () => {
  assert.match(HTML, /<a class="skip-link" href="#main">/);
  assert.match(HTML, /<noscript>/);
});

test('DOM shell: header masthead, room code tiles, and transport controls exist', () => {
  assert.ok(HTML.includes('id="code-tiles"'));
  assert.ok(HTML.includes('id="btn-new-code"'));
  assert.ok(HTML.includes('id="btn-run"'));
  assert.ok(HTML.includes('id="speed"'));
  assert.ok(HTML.includes('id="btn-reset"'));
  assert.ok(HTML.includes('id="sim-status"'));
});

test('DOM shell: virtual client grid and relay stream controls exist', () => {
  assert.ok(HTML.includes('id="device-grid"'));
  assert.ok(HTML.includes('id="filter-messages"'));
  assert.ok(HTML.includes('id="filter-system"'));
  assert.ok(HTML.includes('id="filter-heartbeats"'));
  assert.ok(HTML.includes('id="btn-follow"'));
  assert.ok(HTML.includes('id="stream-scroll"'));
  assert.ok(HTML.includes('id="stream-list"'));
});

test('DOM shell: Message Lab presets, step list, and decision trace exist', () => {
  assert.ok(HTML.includes('id="btn-preset-ordering"'));
  assert.ok(HTML.includes('id="btn-preset-eviction"'));
  assert.ok(HTML.includes('id="btn-preset-replay"'));
  assert.ok(HTML.includes('id="lab-steps"'));
  assert.ok(HTML.includes('id="btn-add-step"'));
  assert.ok(HTML.includes('id="btn-step-one"'));
  assert.ok(HTML.includes('id="btn-run-all"'));
  assert.ok(HTML.includes('id="btn-lab-reset"'));
  assert.ok(HTML.includes('id="lab-trace"'));
  assert.ok(HTML.includes('id="lab-stream"'));
});

test('DOM shell: Code Validator and 1,000 Code Sweep controls exist', () => {
  assert.ok(HTML.includes('id="validator-input"'));
  assert.ok(HTML.includes('id="verdict"'));
  assert.ok(HTML.includes('id="check-format"'));
  assert.ok(HTML.includes('id="check-charset"'));
  assert.ok(HTML.includes('id="check-checksum"'));
  assert.ok(HTML.includes('id="btn-sweep"'));
  assert.ok(HTML.includes('id="sweep-results"'));
});

test('DOM shell: How The Engine Works section and honest transport disclosure exist', () => {
  assert.ok(HTML.includes('id="engine-title"'));
  assert.match(HTML, /Local Simulation/);
  assert.match(HTML, /this build has no server/);
});

test('CSS and copy hygiene: focus-visible, tabular-nums, reduced-motion, and no banned dashes', () => {
  assert.match(CSS, /:focus-visible/);
  assert.match(CSS, /tabular-nums/);
  assert.match(CSS, /prefers-reduced-motion:\s*reduce/);
  assert.equal(/[\u2013\u2014]/.test(HTML), false);
  assert.equal(/[\u2013\u2014]/.test(CSS), false);
  assert.equal(/[\u2013\u2014]/.test(ENGINE_JS), false);
  assert.equal(/[\u2013\u2014]/.test(APP_JS), false);
});

test('Interactive DOM runtime: app.js mounts, renders devices, runs presets, validates codes, and executes sweep', async () => {
  const env = setupFakeDom();
  try {
    await import('../app.js');
    const { getEl } = env;

    // 1. Room code tiles and 4 virtual devices rendered
    assert.equal(getEl('code-tiles').children.length, 6);
    assert.equal(getEl('device-grid').children.length, 4);
    assert.equal(getEl('stream-list').children.length, 4);

    // 2. Transport controls: pause/run, speed change, new code, reset
    getEl('btn-run').fire('click');
    assert.equal(getEl('btn-run').textContent, 'Run');
    assert.match(getEl('sim-status').textContent, /^Paused\./);
    getEl('btn-run').fire('click');
    assert.equal(getEl('btn-run').textContent, 'Pause');

    getEl('speed').value = '4';
    getEl('speed').fire('change');
    getEl('btn-new-code').fire('click');
    assert.equal(getEl('code-tiles').children.length, 6);

    // 3. Device stall / resume interaction
    const orchidCard = getEl('device-grid').children[0];
    const stallBtn = orchidCard.querySelector('[data-field="action"]');
    assert.equal(stallBtn.textContent, 'Stall');
    stallBtn.fire('click');
    assert.equal(stallBtn.textContent, 'Resume');
    assert.equal(orchidCard.dataset.state, 'stalled');
    stallBtn.fire('click');
    assert.equal(stallBtn.textContent, 'Stall');

    // 4. Stream filter chips
    getEl('filter-heartbeats').fire('click');
    assert.equal(getEl('filter-heartbeats').getAttribute('aria-pressed'), 'true');
    getEl('btn-follow').fire('click');
    assert.equal(getEl('btn-follow').getAttribute('aria-pressed'), 'false');

    // 5. Message Lab presets, single step, run all, add step, lab reset
    assert.equal(getEl('lab-steps').children.length, 8);
    getEl('btn-step-one').fire('click');
    assert.equal(getEl('lab-trace').children.length, 1);
    getEl('btn-run-all').fire('click');
    assert.equal(getEl('lab-trace').children.length, 8);

    getEl('btn-preset-eviction').fire('click');
    assert.equal(getEl('lab-steps').children.length, 8);
    getEl('btn-run-all').fire('click');
    assert.equal(getEl('lab-trace').children.length, 8);

    getEl('btn-preset-replay').fire('click');
    assert.equal(getEl('lab-steps').children.length, 9);
    getEl('btn-run-all').fire('click');
    assert.equal(getEl('lab-trace').children.length, 9);

    getEl('btn-add-step').fire('click');
    assert.equal(getEl('lab-steps').children.length, 10);
    getEl('btn-lab-reset').fire('click');
    assert.equal(getEl('lab-trace').children.length, 0);

    // 6. Code Validator live input and 1,000 Code Sweep
    const sampleCode = getEl('code-tiles').children.map((c) => c.textContent).join('');
    getEl('validator-input').value = sampleCode;
    getEl('validator-input').fire('input');
    assert.equal(getEl('verdict').dataset.valid, 'true');
    assert.equal(getEl('check-checksum').dataset.state, 'pass');

    getEl('validator-input').value = 'BAD000';
    getEl('validator-input').fire('input');
    assert.equal(getEl('verdict').dataset.valid, 'false');

    getEl('btn-sweep').fire('click');
    const sweepEl = getEl('sweep-results');
    assert.equal(sweepEl._find((e) => e.dataset.stat === 'generated').textContent, '1,000');
    assert.equal(sweepEl._find((e) => e.dataset.stat === 'valid').textContent, '1000');
    assert.equal(sweepEl._find((e) => e.dataset.stat === 'unique').textContent, '1000');
    assert.equal(sweepEl._find((e) => e.dataset.stat === 'mutations').textContent, '6000');
  } finally {
    env.restore();
  }
});
