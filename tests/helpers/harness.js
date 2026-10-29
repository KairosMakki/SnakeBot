'use strict';

/**
 * Shared test harness for the SnakeBot planner.
 *
 * The userscript is a single browser file, but it exports its pure `Core` module when it is
 * loaded through CommonJS (`module.exports` exists).  That lets these tests plan and play
 * complete games in Node without a browser, canvas or keyboard.
 *
 * Everything here is deterministic: every game is driven by an explicit seed, so CI failures
 * are reproducible by re-running the same seed.
 */

const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'google_snake_bot_user.js');
const Core = require(SCRIPT);

const COLS = 17;
const ROWS = 15;
const N = COLS * ROWS;
const DIRS = Core.DIRS;

const idx = (x, y, cols = COLS) => y * cols + x;
const xy = (i, cols = COLS) => [i % cols, (i / cols) | 0];

/** Small, fast, fully deterministic 32-bit LCG. */
function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Direction the snake is currently travelling (body[1] -> body[0]), or -1. */
function headingOf(body, cols = COLS, rows = ROWS) {
  if (body.length < 2) return -1;
  for (let d = 0; d < 4; d++) {
    if (Core.nbr(body[1], d, cols, rows) === body[0]) return d;
  }
  return -1;
}

/**
 * Build a random, valid snake (head first) by walking a self-avoiding path.
 * Each consecutive pair is adjacent, so the result is always a legal body.
 */
function randomBody(rnd, len, cols = COLS, rows = ROWS) {
  let x = 1 + Math.floor(rnd() * (cols - 2));
  let y = 1 + Math.floor(rnd() * (rows - 2));
  const cells = [idx(x, y, cols)];
  const used = new Set(cells);

  for (let i = 1; i < len; i++) {
    const options = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const c = idx(nx, ny, cols);
      if (!used.has(c)) options.push(c);
    }
    if (!options.length) break;
    const next = options[Math.floor(rnd() * options.length)];
    cells.push(next);
    used.add(next);
    [x, y] = xy(next, cols);
  }
  return cells;
}

/** Every direction that does not kill the snake on the very next tick. */
function legalMoves(body, walls, cols = COLS, rows = ROWS) {
  const head = body[0];
  const occ = new Map(body.map((c, i) => [c, i]));
  const len = body.length;
  const out = [];
  for (let d = 0; d < 4; d++) {
    const m = Core.nbr(head, d, cols, rows);
    if (m < 0) continue;
    if (walls && walls[m]) continue;
    if (len > 1 && m === body[1]) continue; // reversing into the neck
    const o = occ.has(m) ? occ.get(m) : -1;
    // A body cell is only safe when it is the tail and the snake is not growing.
    if (o >= 0 && o !== len - 1) continue;
    out.push(d);
  }
  return out;
}

/** Place `count` obstacles that never overlap the snake and never seal it in completely. */
function scatterWalls(rnd, count, body, cols = COLS, rows = ROWS) {
  const walls = new Uint8Array(cols * rows);
  const blocked = new Set(body);
  let tries = 0;
  while (count > 0 && tries++ < 500) {
    const x = 2 + Math.floor(rnd() * (cols - 4));
    const y = 2 + Math.floor(rnd() * (rows - 4));
    const c = idx(x, y, cols);
    if (blocked.has(c)) continue;
    walls[c] = 1;
    count--;
  }
  return walls;
}

const START = [idx(8, 7), idx(7, 7), idx(6, 7), idx(5, 7)];
const START_HEADING = 1; // right

/**
 * Play one complete simulated game using exactly the rules Google Snake uses:
 *
 *  - the head moves one cell per tick;
 *  - moving into a wall / outside the grid / any body segment is death;
 *  - moving into the current tail cell is legal only when the snake is not growing;
 *  - eating the apple grows the snake and spawns a new apple.
 *
 * Apple placement is deterministic (`seed`) and can be restricted to the outer ring
 * (`appleMode: 'edge'`) to exercise wall-row pursuit.
 */
function playGame(options = {}) {
  const {
    seed = 1,
    cols = COLS,
    rows = ROWS,
    wallCount = 0,
    appleMode = 'free',
    maxSteps = 3000,
    start = START,
    heading = START_HEADING,
  } = options;

  const rnd = makeRng(seed);
  const body = start.slice();
  const occ = new Set(body);
  let dir = heading;
  let score = 0;
  let reason = 'cap';
  let step = 0;

  const walls = wallCount > 0 ? scatterWalls(rnd, wallCount, body, cols, rows) : new Uint8Array(cols * rows);

  const pickApple = () => {
    const candidates = [];
    if (appleMode === 'edge') {
      for (let x = 0; x < cols; x++) candidates.push(idx(x, 0, cols), idx(x, rows - 1, cols));
      for (let y = 1; y < rows - 1; y++) candidates.push(idx(0, y, cols), idx(cols - 1, y, cols));
    } else {
      for (let i = 0; i < cols * rows; i++) candidates.push(i);
    }
    const free = candidates.filter((c) => !walls[c] && !occ.has(c));
    return free.length ? free[Math.floor(rnd() * free.length)] : -1;
  };

  let apple = pickApple();

  for (; step < maxSteps; step++) {
    const d = Core.plan(body, apple, cols, rows, walls, dir);
    if (d == null || d < 0) {
      reason = 'no-move';
      break;
    }

    const head = body[0];
    const [hx, hy] = xy(head, cols);
    const nx = hx + DIRS[d][0];
    const ny = hy + DIRS[d][1];

    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
      reason = 'out';
      break;
    }
    const target = ny * cols + nx;
    if (walls[target]) {
      reason = 'wall';
      break;
    }

    const grow = target === apple;
    const tail = body[body.length - 1];
    if (occ.has(target) && !(target === tail && !grow)) {
      reason = 'self';
      break;
    }

    body.unshift(target);
    occ.add(target);
    if (grow) {
      score++;
      apple = pickApple();
      if (apple < 0) {
        reason = 'clear';
        break;
      }
    } else {
      occ.delete(body.pop());
    }
    dir = d;
  }

  return {
    score,
    reason,
    steps: step,
    len: body.length,
    apple,
    walls,
    body: body.slice(),
  };
}

module.exports = {
  Core,
  COLS,
  ROWS,
  N,
  DIRS,
  START,
  START_HEADING,
  SCRIPT,
  idx,
  xy,
  makeRng,
  headingOf,
  randomBody,
  legalMoves,
  scatterWalls,
  playGame,
};
