'use strict';

/**
 * Planner unit + property tests.
 *
 * `Core.plan()` is the only function that decides where the snake goes, so these tests focus
 * on one guarantee: **every direction it returns is survivable on the next tick**, and it
 * never gives up while a legal move exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Core,
  COLS,
  ROWS,
  DIRS,
  idx,
  makeRng,
  headingOf,
  randomBody,
  legalMoves,
} = require('./helpers/harness');

const NO_WALLS = new Uint8Array(COLS * ROWS);

/** Target cell of a plan result. */
function targetOf(body, dir) {
  return Core.nbr(body[0], dir, COLS, ROWS);
}

test('nbr(): stays inside the grid and maps directions correctly', () => {
  assert.equal(Core.nbr(idx(0, 0), 0, COLS, ROWS), -1, 'up from the top row is outside');
  assert.equal(Core.nbr(idx(0, 0), 3, COLS, ROWS), -1, 'left from the first column is outside');
  assert.equal(Core.nbr(idx(0, 0), 1, COLS, ROWS), idx(1, 0), 'right');
  assert.equal(Core.nbr(idx(0, 0), 2, COLS, ROWS), idx(0, 1), 'down');
  assert.equal(Core.nbr(idx(COLS - 1, ROWS - 1), 1, COLS, ROWS), -1, 'right from the last column is outside');
  assert.equal(Core.nbr(idx(COLS - 1, ROWS - 1), 2, COLS, ROWS), -1, 'down from the last row is outside');
});

test('moves straight toward a clear apple', () => {
  const body = [idx(6, 7), idx(5, 7), idx(4, 7), idx(3, 7)];
  const apple = idx(10, 7);
  assert.equal(Core.plan(body, apple, COLS, ROWS, NO_WALLS, 1), 1);
});

test('eats an apple that sits directly beside the head', () => {
  const body = [idx(5, 7), idx(4, 7), idx(3, 7)];
  const apple = idx(5, 6);
  assert.equal(Core.plan(body, apple, COLS, ROWS, NO_WALLS, 1), 0);
});

test('never reverses into its own neck', () => {
  const body = [idx(5, 7), idx(4, 7), idx(3, 7)];
  // heading = right, so "left" (3) would be an instant self-hit
  for (let i = 0; i < 25; i++) {
    const d = Core.plan(body, idx(15, 13), COLS, ROWS, NO_WALLS, 1);
    assert.notEqual(d, 3, 'must never return a 180 degree turn');
  }
});

test('follows the tail when it is the only way out (boxed-in ring)', () => {
  // head (10,8); up/left/right are permanent body, down is the tail which vacates this tick
  const ring = [146, 145, 128, 129, 130, 147, 164, 163];
  const heading = headingOf(ring);
  const d = Core.plan(ring, -1, COLS, ROWS, NO_WALLS, heading);
  assert.equal(d, 2, 'must move down into the vacating tail cell');
  assert.equal(targetOf(ring, d), ring[ring.length - 1]);
});

test('returns -1 (instead of a suicidal move) when genuinely checkmated', () => {
  // head surrounded on all four sides by body that does NOT vacate this tick
  const body = [idx(5, 5), idx(5, 4), idx(6, 4), idx(6, 5), idx(6, 6), idx(5, 6), idx(4, 6), idx(4, 5), idx(4, 4)];
  const apple = idx(12, 2);
  const d = Core.plan(body, apple, COLS, ROWS, NO_WALLS, headingOf(body));
  assert.equal(d, -1);
});

test('works without a visible apple (exploration mode)', () => {
  const body = [idx(8, 7), idx(7, 7), idx(6, 7), idx(5, 7)];
  const d = Core.plan(body, -1, COLS, ROWS, NO_WALLS, 1);
  assert.ok(d >= 0 && d <= 3, 'still makes a legal move');
});

test('is deterministic for identical inputs', () => {
  const body = [idx(8, 7), idx(7, 7), idx(6, 7), idx(5, 7)];
  const walls = new Uint8Array(COLS * ROWS);
  walls[idx(10, 7)] = 1;
  const a = Core.plan(body, idx(14, 3), COLS, ROWS, walls, 1);
  const b = Core.plan(body, idx(14, 3), COLS, ROWS, walls, 1);
  assert.equal(a, b);
});

test('property: 800 random states never produce an illegal move', () => {
  const rnd = makeRng(0x5eed);
  let checked = 0;
  let tailFollows = 0;

  for (let t = 0; t < 1000 && checked < 800; t++) {
    const len = 3 + Math.floor(rnd() * 45);
    const body = randomBody(rnd, len);
    if (body.length < 3) continue;

    const heading = headingOf(body);
    if (heading < 0) continue;

    const walls = new Uint8Array(COLS * ROWS);
    if (rnd() < 0.5) {
      for (let k = 0; k < 8; k++) {
        const c = idx(
          1 + Math.floor(rnd() * (COLS - 2)),
          1 + Math.floor(rnd() * (ROWS - 2))
        );
        if (!body.includes(c)) walls[c] = 1;
      }
    }

    const occ = new Map(body.map((c, i) => [c, i]));
    const free = [];
    for (let i = 0; i < COLS * ROWS; i++) if (!occ.has(i) && !walls[i]) free.push(i);
    if (!free.length) continue;
    const apple = free[Math.floor(rnd() * free.length)];

    const d = Core.plan(body, apple, COLS, ROWS, walls, heading);
    const legal = legalMoves(body, walls);
    checked++;

    if (d < 0) {
      assert.equal(legal.length, 0, `returned -1 although ${legal.length} legal move(s) exist`);
      continue;
    }

    const target = targetOf(body, d);
    assert.ok(target >= 0, 'move stayed inside the grid');
    assert.equal(walls[target], 0, 'move did not enter a wall/obstacle');
    assert.notEqual(target, body[1], 'move did not reverse into the neck');

    const o = occ.has(target) ? occ.get(target) : -1;
    assert.ok(o < 0 || o === body.length - 1, 'move only entered the tail (which vacates now)');
    if (o === body.length - 1) tailFollows++;
  }

  assert.ok(checked >= 700, `expected a meaningful sample, got ${checked}`);
  assert.ok(tailFollows > 0, 'the tail-follow path was exercised');
});

test('property: never plans into a wall while looping around an obstacle field', () => {
  // Apple behind a wall on the same row: the bot has to detour, never cut through.
  const walls = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS - 2; y++) walls[idx(8, y)] = 1;

  const body = [idx(5, 7), idx(4, 7), idx(3, 7), idx(2, 7)];
  let heading = 1;
  let apple = idx(12, 7);

  for (let step = 0; step < 120 && apple >= 0; step++) {
    const d = Core.plan(body, apple, COLS, ROWS, walls, heading);
    if (d < 0) break;
    const next = targetOf(body, d);
    assert.ok(next >= 0, 'stayed inside the grid');
    assert.equal(walls[next], 0, `step ${step} entered a wall cell`);
    assert.notEqual(next, body[1], 'no reversal');

    const grow = next === apple;
    body.unshift(next);
    if (grow) apple = -1;
    else body.pop();
    heading = d;
  }

  assert.equal(apple, -1, 'eventually reached the apple behind the wall');
});

test('can collect an apple on the wall-adjacent outer row', () => {
  // head heading left along the top row, apple on the far left edge
  const body = [idx(6, 0), idx(7, 0), idx(8, 0), idx(9, 0)];
  let heading = 3;
  let apple = idx(0, 0);
  let ate = false;

  for (let step = 0; step < 40; step++) {
    const d = Core.plan(body, apple, COLS, ROWS, NO_WALLS, heading);
    if (d < 0) break;
    const next = targetOf(body, d);
    assert.ok(next >= 0, 'stayed inside the grid');
    const grow = next === apple;
    body.unshift(next);
    if (grow) {
      ate = true;
      break;
    }
    body.pop();
    heading = d;
  }

  assert.ok(ate, 'ate the edge apple');
});

test('handles a taller-than-wide board (grid size is not hardcoded)', () => {
  const cols = 11;
  const rows = 21;
  const body = [10, 9, 8, 7]; // top row, moving right, away from the wall
  const apple = [idx(10, 20, cols)][0];
  const d = Core.plan(body, apple, cols, rows, null, 1);
  assert.ok(d >= 0 && d <= 3);
  const target = Core.nbr(body[0], d, cols, rows);
  assert.ok(target >= 0 && target < cols * rows);
});

test('DIRS matches the documented up/right/down/left order', () => {
  assert.deepEqual(DIRS, [[0, -1], [1, 0], [0, 1], [-1, 0]]);
});
