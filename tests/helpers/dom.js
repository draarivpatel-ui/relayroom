/* helpers/dom.js - a zero dependency DOM shim for the live analytics tests.
   app.js is an ES module with static imports, so the shim executes it through
   vm.SourceTextModule with the real engine and analytics modules linked in. */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach((x) => this.set.add(x)); }
  remove(...n) { n.forEach((x) => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const next = force === undefined ? !this.set.has(n) : Boolean(force);
    if (next) this.set.add(n); else this.set.delete(n);
    return next;
  }
  toString() { return [...this.set].join(' '); }
}

export class El {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.type = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.disabled = false;
    this.hidden = false;
    this.colSpan = 1;
    this.scrollTop = 0;
    this.scrollHeight = 400;
    this.clientHeight = 200;
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.children = [];
    this.parentNode = null;
    this.style = { setProperty() {} };
    this.classList = new ClassList();
  }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes) {
    for (const n of nodes) {
      if (n instanceof El) { n.parentNode = this; this.children.push(n); }
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith('data-')) {
      this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    }
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, extra = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return event;
  }
  querySelector(sel) {
    if (sel === 'dd' || sel === 'dt') {
      return this.children.find((c) => c.tagName === sel.toUpperCase()) ?? null;
    }
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      if (matches(node, sel)) out.push(node);
      for (const c of node.children) walk(c);
    };
    for (const c of this.children) walk(c);
    return out;
  }
  _find(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const found = c._find ? c._find(pred) : null;
      if (found) return found;
    }
    return null;
  }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  get text() { return this.textContent + this.children.map((c) => c.text).join(''); }
}

function matches(node, selector) {
  for (const part of selector.split(',')) {
    const sel = part.trim();
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) {
        if (Object.prototype.hasOwnProperty.call(node.attrs, body)) return true;
      } else {
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, '');
        if (node.getAttribute(key) === value) return true;
      }
    } else if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) return true;
    else if (sel.startsWith('#') && node.id === sel.slice(1)) return true;
    else if (node.tagName === sel.toUpperCase()) return true;
  }
  return false;
}

export function parsePage(rel) {
  const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const attributes = new Map();
  for (const m of source.matchAll(/<(input|select|button|output|table|tbody|section|p|div|dl)\b([^>]*)>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    if (attrs.id) attributes.set(attrs.id, { tag: m[1], attrs });
  }
  const selectDefaults = new Map();
  for (const m of source.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...m[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
    const selected = options.find((o) => /selected/.test(o[2]));
    if (options.length) selectDefaults.set(m[1], (selected || options[0])[1]);
  }
  return { source, ids, attributes, selectDefaults };
}

export function makeDom(page) {
  const els = new Map();
  for (const id of page.ids) {
    const spec = page.attributes.get(id);
    const el = new El(spec?.tag ?? 'div', id);
    if (spec) {
      for (const [k, v] of Object.entries(spec.attrs)) {
        el.setAttribute(k, v);
        if (k === 'value') el.value = v;
        if (k === 'class') el.className = v;
        if (k === 'hidden') el.hidden = true;
      }
    }
    if (page.selectDefaults.has(id)) el.value = page.selectDefaults.get(id);
    if (id.startsWith('check-')) {
      el.append(new El('dt'), new El('dd'));
    }
    if (id === 'sweep-results') {
      for (const stat of ['generated', 'valid', 'unique', 'mutations', 'time']) {
        const wrap = new El('div');
        const dd = new El('dd');
        dd.dataset.stat = stat;
        dd.textContent = '0';
        wrap.append(dd);
        el.append(wrap);
      }
    }
    els.set(id, el);
  }
  const documentListeners = {};
  const document = {
    getElementById: (id) => els.get(id) ?? null,
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    querySelector: (sel) => {
      const stat = /^#sweep-results \[data-stat="([^"]+)"\]$/.exec(sel);
      if (stat) return els.get('sweep-results')._find((el) => el.dataset?.stat === stat[1]);
      return [...els.values()].find((el) => matches(el, sel)) ?? null;
    },
    querySelectorAll: (sel) => [...els.values()].filter((el) => matches(el, sel)),
    addEventListener: (type, fn) => (documentListeners[type] ??= []).push(fn),
    fire: (type, extra = {}) => {
      const event = { target: new El('body'), preventDefault() {}, ...extra };
      for (const fn of documentListeners[type] ?? []) fn(event);
      return event;
    },
    readyState: 'complete'
  };
  const intervals = [];
  const nowBox = { t: 0 };
  const globals = {
    document,
    window: { matchMedia: () => ({ matches: false }), print() {} },
    performance: { now: () => nowBox.t },
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    Math, JSON, Date, Number, String, Object, Array, Set, Map, Boolean,
    isFinite, parseInt, parseFloat, RegExp, Error, Infinity, NaN, undefined
  };
  return { document, els, intervals, globals, nowBox, getEl: (id) => els.get(id) ?? null };
}

export async function runAppModule(env) {
  const appPath = path.join(repoRoot, 'app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const moduleUrl = pathToFileURL(appPath).href;
  const context = vm.createContext(env.globals);
  const syntheticFor = async (specifier, referencing) => {
    const resolved = new URL(specifier, referencing);
    const namespace = await import(resolved.href);
    const keys = Object.keys(namespace);
    return new vm.SyntheticModule(keys, function () {
      for (const key of keys) this.setExport(key, namespace[key]);
    }, { context, identifier: resolved.href });
  };
  const mod = new vm.SourceTextModule(source, {
    context,
    identifier: moduleUrl,
    initializeImportMeta(meta) { meta.url = moduleUrl; }
  });
  await mod.link((spec, ref) => syntheticFor(spec, ref.identifier ?? moduleUrl));
  await mod.evaluate();
  return mod;
}
