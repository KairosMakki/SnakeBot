'use strict';

/**
 * Userscript metadata + API surface tests.
 *
 * These keep the installable file valid for Tampermonkey/Violentmonkey and make sure the
 * version in the userscript header stays in sync with package.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'google_snake_bot_user.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function parseMetadata(source) {
  const start = source.indexOf('// ==UserScript==');
  const end = source.indexOf('// ==/UserScript==');
  assert.ok(start >= 0 && end > start, 'userscript metadata block exists');

  const block = source.slice(start, end);
  const meta = { match: [], require: [], grant: [] };
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\/\/\s+@(\S+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === 'match') meta.match.push(value);
    else if (key === 'require') meta.require.push(value);
    else if (key === 'grant') meta.grant.push(value);
    else meta[key] = value;
  }
  return meta;
}

const META = parseMetadata(SOURCE);

test('metadata: has every field a userscript manager needs', () => {
  for (const key of ['name', 'namespace', 'version', 'description', 'run-at']) {
    assert.ok(META[key], `@${key} is present`);
  }
  assert.ok(META.match.length > 0, '@match is present');
  assert.ok(META.grant.includes('none'), '@grant none (the script needs no special APIs)');
  assert.deepEqual(META.require, [], 'no remote @require (works offline / pasted into console)');
});

test('metadata: runs on Google domains', () => {
  assert.ok(META.match.some((m) => m.includes('www.google.com')), 'matches www.google.com');
  assert.ok(META.match.some((m) => m.includes('www.google.tld')), 'matches regional Google domains');
});

test('metadata: version matches package.json', () => {
  const norm = (v) => v.split('.').map(Number).concat([0, 0, 0]).slice(0, 3).join('.');
  assert.equal(norm(META.version), norm(PKG.version));
});

test('metadata: version is a plain semver string', () => {
  assert.match(META.version, /^\d+\.\d+(\.\d+)?$/);
});

test('metadata: description mentions the safety features', () => {
  const d = META.description.toLowerCase();
  assert.ok(d.includes('tail'), 'tail prediction is documented in the header');
  assert.ok(d.includes('dijkstra'), 'the planner is documented in the header');
});

test('module: exports the pure Core surface used by the tests', () => {
  const Core = require(FILE);
  for (const key of ['DIRS', 'nbr', 'detectBoard', 'readGrid', 'headEntering', 'orderCells', 'Tracker', 'plan']) {
    assert.ok(Core[key] != null, `Core.${key} is exported`);
  }
  assert.equal(typeof Core.plan, 'function');
  assert.equal(typeof Core.Tracker, 'function');
  assert.equal(Core.DIRS.length, 4);
});

test('module: browser code is skipped under CommonJS', () => {
  // `window` is not defined in Node; if the browser half ran, requiring the file would throw.
  assert.equal(typeof globalThis.window, 'undefined');
  const Core = require(FILE);
  assert.equal(typeof Core.plan, 'function');
});

test('source: no stray debugger statements or TODOs left behind', () => {
  assert.equal(/^\s*debugger\s*;?\s*$/m.test(SOURCE), false, 'no debugger statements');
  assert.equal(/console\.(log|warn|error)\(\s*['"`]TODO/.test(SOURCE), false);
});
