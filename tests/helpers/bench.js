'use strict';

/**
 * Small planner benchmark.
 *
 * Runs complete games and reports score + how long a single `plan()` call takes.  Useful when
 * tuning penalties: the browser loop calls plan() on every game tick, so the per-call cost has
 * to stay far below one tick (Google Snake ticks are roughly 90-150 ms at normal speed).
 *
 * Usage:
 *   node tests/helpers/bench.js [games] [maxSteps]
 */

const { playGame, Core, COLS, ROWS, START, START_HEADING } = require('./harness');

const games = Number(process.argv[2] || 8);
const maxSteps = Number(process.argv[3] || 3000);

const t0 = process.hrtime.bigint();
let total = 0;
let best = 0;
let checkmates = 0;
let deaths = 0;

for (let g = 0; g < games; g++) {
  const r = playGame({ seed: 10_000 + g, maxSteps });
  total += r.score;
  if (r.score > best) best = r.score;
  if (r.reason === 'no-move') checkmates++;
  if (r.reason === 'self' || r.reason === 'wall' || r.reason === 'out') deaths++;
}

const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

// Micro-benchmark plan() on a mid-game-sized snake.
const body = START.slice();
const apple = 200;
let planCalls = 0;
const p0 = process.hrtime.bigint();
for (let i = 0; i < 2000; i++) {
  Core.plan(body, apple, COLS, ROWS, null, START_HEADING);
  planCalls++;
}
const perCallUs = Number(process.hrtime.bigint() - p0) / 1e3 / planCalls;

console.log(`games            ${games}`);
console.log(`average apples   ${(total / games).toFixed(1)}`);
console.log(`best             ${best}`);
console.log(`deaths           ${deaths}`);
console.log(`late checkmates  ${checkmates}`);
console.log(`total time       ${elapsedMs.toFixed(0)} ms`);
console.log(`plan() cost      ${perCallUs.toFixed(1)} us/call (short snake)`);
