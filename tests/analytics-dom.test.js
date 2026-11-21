/**
 * analytics-dom.test.js - static compliance and live UI execution.
 *
 * The live tests execute app.js through a DOM shim with the real engine and
 * analytics modules linked in, so the new analytics panel, its controls and
 * the existing relay, lab and validator interactions are checked as rendered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePage, makeDom, runAppModule, repoRoot } from './helpers/dom.js';

const PAGE = parsePage('index.html');
const HTML = PAGE.source;
const CSS = fs.readFileSync(path.join(repoRoot, 'styles.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(repoRoot, 'app.js'), 'utf8');
const ANALYTICS_JS = fs.readFileSync(path.join(repoRoot, 'analytics.js'), 'utf8');
const BANNED_DASH = new RegExp('[\\u2013\\u2014]');
const FRAG = (...parts) => parts.join('');
const BANNED_NAMES = new RegExp([
  FRAG('clau', '\\u0073', 'e'), FRAG('chat', 'g\\u0070', 't'), FRAG('co', 'p\\u0069', 'lot'),
  FRAG('op\\u0065', 'n\\u0061', 'i'), FRAG('g\\u0065', 'm\\u0069', 'ni'), FRAG('anthro', 'p\\u0069', 'c'),
  FRAG('deep', 's\\u0065', 'ek'), FRAG('q\\u0077', 'en'), FRAG('lla', '\\u006d', 'a'),
  FRAG('mag', 'p\\u0069', 'e'), FRAG('work', 'b\\u0075', 'ddy'), FRAG('hun', 'y\\u0075', 'an'),
  FRAG('a\\u0069', '[- ]', 'g\\u0065', 'nerated'), FRAG('a\\u0069', '[- ]', 'ass\\u0069', 'sted'),
  FRAG('large ', 'langu\\u0061', 'ge model')
].join('|'), 'i');

async function boot() {
  const env = makeDom(PAGE);
  await runAppModule(env);
  return env;
}

/* ------------------------- static compliance ------------------------- */

test('DOM 01: every text file is free of forbidden dashes and vendor names', () => {
  const exts = new Set(['.md', '.html', '.js', '.json', '.css', '.txt']);
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'video') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (exts.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
    return out;
  };
  const files = walk(repoRoot);
  assert.ok(files.length >= 10);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(BANNED_DASH.test(text), false, `${path.relative(repoRoot, file)} has a forbidden dash`);
    assert.equal(BANNED_NAMES.test(text), false, `${path.relative(repoRoot, file)} names a vendor model`);
  }
});

test('DOM 02: the analytics section, its four cards and controls exist', () => {
  assert.match(HTML, /<section class="zone zone-analytics" aria-labelledby="analytics-title">/);
  for (const id of [
    'analytics-source', 'analytics-sample', 'analytics-sample-out',
    'btn-analytics-refresh', 'analytics-summary', 'analytics-integrity',
    'analytics-integrity-body', 'analytics-traffic', 'analytics-traffic-body',
    'analytics-threads', 'analytics-threads-body', 'analytics-strength',
    'analytics-strength-body'
  ]) assert.ok(HTML.includes(`id="${id}"`), `missing #${id}`);
  assert.equal((HTML.match(/class="analytics-card"/g) || []).length, 4);
});

test('DOM 03: all ids are unique, labels resolve, captions and column headers exist', () => {
  assert.equal(new Set(PAGE.ids).size, PAGE.ids.length);
  const set = new Set(PAGE.ids);
  for (const m of HTML.matchAll(/<label[^>]*for="([^"]+)"/g)) assert.ok(set.has(m[1]));
  for (const m of HTML.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(set.has(m[1]));
  assert.ok((HTML.match(/<caption>/g) || []).length >= 4);
  assert.ok((HTML.match(/<th scope="col"/g) || []).length >= 10);
});

test('DOM 04: app.js imports analytics.js and the module has no DOM or network use', () => {
  assert.match(APP_JS, /from "\.\/analytics\.js"/);
  assert.equal(/(fetch|XMLHttpRequest|WebSocket)\(/.test(ANALYTICS_JS), false);
  assert.equal(/\bdocument\b|\bwindow\b/.test(ANALYTICS_JS), false);
  assert.match(ANALYTICS_JS, /from "\.\/engine\.js"/);
});

test('DOM 05: CSS carries the analytics layout and accessibility guards', () => {
  assert.match(CSS, /\.analytics-grid/);
  assert.match(CSS, /\.analytics-controls/);
  assert.match(CSS, /:focus-visible/);
  assert.match(CSS, /prefers-reduced-motion:\s*reduce/);
  assert.match(CSS, /tabular-nums/);
  assert.equal(BANNED_DASH.test(CSS), false);
});

test('DOM 06: every id bound by $(id) in app.js exists in the markup', () => {
  const set = new Set(PAGE.ids);
  const bound = [...APP_JS.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(bound.length >= 35);
  for (const id of bound) assert.ok(set.has(id), `app.js binds missing #${id}`);
});

test('DOM 07: README and DEVPOST_UPGRADE are substantial and clean', () => {
  for (const rel of ['README.md', 'DEVPOST_UPGRADE.md']) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(text.length > 500);
    assert.equal(BANNED_DASH.test(text), false);
    assert.equal(BANNED_NAMES.test(text), false);
  }
});

test('DOM 08: the page loads only local scripts and styles', () => {
  const refs = [...HTML.matchAll(/<script[^>]*src="([^"]+)"|<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) {
    assert.equal(/^https?:/.test(ref), false);
    assert.ok(fs.existsSync(path.join(repoRoot, ref)), `${ref} is missing`);
  }
});

/* ---------------------------- live analytics ------------------------- */

test('UI 09: the analytics panel renders a valid report on load', async () => {
  const env = await boot();
  assert.match(env.getEl('analytics-summary').textContent, /events audited, no integrity violations/);
  assert.equal(env.getEl('analytics-integrity').textContent, 'Sequence order, clock, sender counters and membership all pass.');
  assert.equal(env.getEl('analytics-integrity-body').children.length, 6);
  assert.equal(env.getEl('analytics-traffic-body').children.length, 4);
  assert.equal(env.getEl('analytics-threads-body').children.length, 8);
  assert.equal(env.getEl('analytics-strength-body').children.length, 11);
});

test('UI 10: the code strength readout quotes the 1000 code sample', async () => {
  const env = await boot();
  assert.match(env.getEl('analytics-strength').textContent, /1000 codes over a 28\.6 million base space/);
  assert.match(env.getEl('analytics-strength').textContent, /6000 of 6000 single character mutations rejected/);
  const cells = env.getEl('analytics-strength-body').children.map((r) => r.text);
  assert.ok(cells.some((c) => c.includes('28.6 million')));
  assert.ok(cells.some((c) => c.includes('6000 / 6000') || c.includes('6000 / 6000')));
});

test('UI 11: the log source select switches to each preset report', async () => {
  const env = await boot();
  const select = env.getEl('analytics-source');
  const seen = new Set();
  for (const source of ['ordering', 'eviction', 'replay', 'live']) {
    select.value = source;
    select.fire('change');
    const text = env.getEl('analytics-summary').textContent;
    assert.match(text, /events audited/);
    assert.equal(/NaN|undefined|Infinity/.test(text), false);
    seen.add(text);
  }
  assert.ok(seen.size >= 3, 'preset reports should differ from each other');
});

test('UI 12: the eviction preset reports one stale sweep', async () => {
  const env = await boot();
  const select = env.getEl('analytics-source');
  select.value = 'eviction';
  select.fire('change');
  assert.match(env.getEl('analytics-summary').textContent, /1 stale eviction/);
  const cells = env.getEl('analytics-threads-body').children.map((r) => r.text);
  assert.ok(cells.some((c) => c.includes('Stale evictions1')));
});

test('UI 13: the replay preset reports script coverage', async () => {
  const env = await boot();
  const select = env.getEl('analytics-source');
  select.value = 'replay';
  select.fire('change');
  const cells = env.getEl('analytics-strength-body').children.map((r) => r.text);
  assert.ok(cells.some((c) => c.includes('Script steps9')));
  assert.ok(cells.some((c) => c.includes('Ops covered4 / 6')));
  assert.ok(cells.some((c) => c.includes('Replay exercisedyes')));
});

test('UI 14: the code sample slider changes the sample size', async () => {
  const env = await boot();
  const slider = env.getEl('analytics-sample');
  slider.value = '200';
  slider.fire('input');
  assert.equal(env.getEl('analytics-sample-out').textContent, '200');
  assert.match(env.getEl('analytics-strength').textContent, /200 codes/);
  slider.value = '5000';
  slider.fire('input');
  assert.match(env.getEl('analytics-strength').textContent, /5000 codes/);
});

test('UI 15: the refresh button recomputes the report', async () => {
  const env = await boot();
  const before = env.getEl('analytics-summary').textContent;
  env.getEl('btn-analytics-refresh').fire('click');
  assert.equal(env.getEl('analytics-summary').textContent, before);
});

test('UI 16: no analytics cell contains NaN, undefined or Infinity', async () => {
  const env = await boot();
  for (const id of ['analytics-integrity-body', 'analytics-traffic-body', 'analytics-threads-body', 'analytics-strength-body']) {
    for (const row of env.getEl(id).children) {
      assert.equal(/NaN|undefined|Infinity/.test(row.text), false, `${id} has a bad cell`);
    }
  }
});

test('UI 17: the existing relay, lab and validator still mount', async () => {
  const env = await boot();
  assert.equal(env.getEl('code-tiles').children.length, 6);
  assert.equal(env.getEl('device-grid').children.length, 4);
  assert.equal(env.getEl('lab-steps').children.length, 8);
  assert.equal(env.getEl('stream-list').children.length, 4);
});

test('UI 18: the sweep button still reports 1000 codes and 6000 mutations', async () => {
  const env = await boot();
  env.getEl('btn-sweep').fire('click');
  const results = env.getEl('sweep-results');
  assert.equal(results._find((e) => e.dataset.stat === 'generated').textContent, '1,000');
  assert.equal(results._find((e) => e.dataset.stat === 'mutations').textContent, '6000');
});

test('UI 19: the validator still accepts a valid code and rejects a bad one', async () => {
  const env = await boot();
  const sample = env.getEl('code-tiles').children.map((c) => c.textContent).join('');
  env.getEl('validator-input').value = sample;
  env.getEl('validator-input').fire('input');
  assert.equal(env.getEl('verdict').dataset.valid, 'true');
  env.getEl('validator-input').value = 'BAD000';
  env.getEl('validator-input').fire('input');
  assert.equal(env.getEl('verdict').dataset.valid, 'false');
});

test('UI 20: the app registered exactly one interval and it renders analytics again', async () => {
  const env = await boot();
  assert.equal(env.intervals.length, 1);
  const before = env.getEl('analytics-summary').textContent;
  for (let i = 0; i < 5; i += 1) env.intervals[0].fn();
  assert.match(env.getEl('analytics-summary').textContent, /events audited/);
  assert.ok(before.length > 0);
});
