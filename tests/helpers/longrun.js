'use strict';

/**
 * Longer local experiment runner (not part of CI).
 *
 * Plays N seeded games with the real planner and prints the numbers that matter when tuning:
 * average score, best score, deaths (self/wall/out) and late-game checkmates.
 *
 * Usage:
 *   node tests/helpers/longrun.js [games] [maxSteps] [wallCount]
 *
 * Examples:
 *   node tests/helpers/longrun.js 120 5000 0     # 120 classic games
 *   node tests/helpers/longrun.js 60 10000 6     # 60 games with 6 obstacles
 */

const { playGame } = require('./harness');

const games = Number(process.argv[2] || 120);
const maxSteps = Number(process.argv[3] || 5000);
const wallCount = Number(process.argv[4] || 0);

const buckets = { self: 0, wall: 0, out: 0, noMove: 0, clear: 0, cap: 0 };
let total = 0;
let best = 0;
let bestSeed = null;
const started = Date.now();

for (let g = 0; g < games; g++) {
  const seed = 50_000 + g;
  const r = playGame({ seed, maxSteps, wallCount });
  total += r.score;
  if (r.score > best) {
    best = r.score;
    bestSeed = seed;
  }
  if (r.reason === 'no-move') buckets.noMove++;
  else if (r.reason === 'clear') buckets.clear++;
  else if (r.reason === 'cap') buckets.cap++;
  else buckets[r.reason]++;

  if ((g + 1) % 10 === 0) {
    process.stdout.write(`  ${g + 1}/${games} games, avg ${(total / (g + 1)).toFixed(1)}\r`);
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(' '.repeat(60) + '\r');

console.log(`games            ${games}`);
console.log(`max steps        ${maxSteps}`);
console.log(`obstacles        ${wallCount}`);
console.log(`average apples   ${(total / games).toFixed(1)}`);
console.log(`best             ${best} (seed ${bestSeed})`);
console.log(`deaths           self ${buckets.self}, wall ${buckets.wall}, out ${buckets.out}`);
console.log(`checkmates       ${buckets.noMove}`);
console.log(`full clears      ${buckets.clear}`);
console.log(`still alive      ${buckets.cap} (hit the step cap)`);
console.log(`elapsed          ${elapsed}s`);
