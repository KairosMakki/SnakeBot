'use strict';

/**
 * End-to-end regression tests: play complete simulated games with the real planner and the
 * real Google Snake rules, and fail on any wall / self / out-of-bounds death.
 *
 * These are the tests that would have caught every historical "runs into itself" bug.
 * Seeds are fixed, so any failure is reproducible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { playGame } = require('./helpers/harness');

const DEATHS = new Set(['self', 'wall', 'out']);

function runBatch(label, games, options) {
  const results = [];
  for (let i = 0; i < games; i++) {
    const seed = options.seedBase + i;
    results.push({ seed, ...playGame({ ...options, seed }) });
  }

  const deaths = results.filter((r) => DEATHS.has(r.reason));
  const detail = deaths.map((r) => `seed ${r.seed}: ${r.reason} at ${r.score} apples`).join('\n');
  assert.equal(deaths.length, 0, `${label}: unexpected deaths\n${detail}`);

  const total = results.reduce((s, r) => s + r.score, 0);
  return {
    results,
    avg: total / games,
    best: Math.max(...results.map((r) => r.score)),
    noMove: results.filter((r) => r.reason === 'no-move').length,
  };
}

test('classic mode: 10 games, zero wall/self/out deaths', () => {
  const batch = runBatch('classic', 10, { seedBase: 2000, maxSteps: 3000 });
  assert.ok(batch.avg >= 90, `average score should stay high, got ${batch.avg.toFixed(1)}`);
  assert.ok(batch.best >= 100, `best score should stay high, got ${batch.best}`);
  assert.ok(batch.noMove <= 1, `at most one late checkmate in 10 games, got ${batch.noMove}`);

  console.log(`  classic: avg ${batch.avg.toFixed(1)}, best ${batch.best}, checkmates ${batch.noMove}/10`);
});

test('obstacle mode: 6 games with scattered walls, zero deaths', () => {
  const batch = runBatch('obstacles', 6, { seedBase: 3000, wallCount: 6, maxSteps: 3000 });
  assert.ok(batch.avg >= 60, `average score should stay reasonable, got ${batch.avg.toFixed(1)}`);
  console.log(`  obstacles: avg ${batch.avg.toFixed(1)}, best ${batch.best}, checkmates ${batch.noMove}/6`);
});

test('edge-apple mode: 6 games, zero deaths, many wall-row apples', () => {
  const batch = runBatch('edge apples', 6, {
    seedBase: 4000,
    appleMode: 'edge',
    maxSteps: 1500,
  });
  for (const r of batch.results) {
    assert.ok(r.score >= 15, `seed ${r.seed}: expected >= 15 edge apples, got ${r.score}`);
  }
  console.log(`  edge apples: avg ${batch.avg.toFixed(1)}, best ${batch.best}`);
});

test('long game: survives deep into the late game without dying', () => {
  const r = playGame({ seed: 9999, maxSteps: 6000 });
  assert.equal(DEATHS.has(r.reason), false, `died by ${r.reason} at ${r.score} apples`);
  assert.ok(r.score >= 120, `expected a long run, got ${r.score} apples`);
  console.log(`  long game: ${r.score} apples, ${r.len} cells, ended with "${r.reason}"`);
});

test('simulation harness: apple is never spawned on the snake or a wall', () => {
  // Sanity check on the harness itself - a bad harness could hide real bugs.
  const r = playGame({ seed: 777, wallCount: 6, maxSteps: 400 });
  if (r.apple >= 0) {
    assert.equal(r.body.includes(r.apple), false, 'apple not on the snake');
    assert.equal(!!r.walls[r.apple], false, 'apple not on a wall');
  }
});
