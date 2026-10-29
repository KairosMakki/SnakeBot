'use strict';

/**
 * Vision-layer tests.
 *
 * `detectBoard()` and `readGrid()` are the only parts of the bot that touch pixels, and they
 * are pure functions: they take a raw RGBA buffer.  These tests render a synthetic Google
 * Snake board (checkerboard, snake, apple, obstacles) and assert that the bot reads it back
 * exactly - no browser or canvas required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Core } = require('./helpers/harness');

const COLS = 17;
const ROWS = 15;
const CELL = 20;
const PAD = 10;

const LIGHT = [170, 215, 120];
const DARK = [158, 203, 110];
const SNAKE = [60, 90, 200];
const APPLE = [220, 40, 40];
const WALL = [60, 120, 60];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/**
 * Render a synthetic board into a plain RGBA array.
 * `walls` / `snake` are cell indices, `head` is the snake cell that gets the white eyes.
 */
function renderBoard({
  cols = COLS,
  rows = ROWS,
  cell = CELL,
  pad = PAD,
  snake = [],
  apple = -1,
  walls = [],
  head = -1,
} = {}) {
  const W = cols * cell + pad * 2;
  const H = rows * cell + pad * 2;
  const data = new Uint8ClampedArray(W * H * 4);

  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  };
  const rect = (x0, y0, w, h, color) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, color);
  };

  // black frame
  rect(0, 0, W, H, BLACK);

  const cellRect = (i, color) => {
    const cx = i % cols;
    const cy = (i / cols) | 0;
    rect(pad + cx * cell, pad + cy * cell, cell, cell, color);
  };

  // checkerboard playfield
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      cellRect(y * cols + x, (x + y) % 2 ? DARK : LIGHT);
    }
  }

  for (const i of snake) cellRect(i, SNAKE);
  for (const i of walls) cellRect(i, WALL);
  if (apple >= 0) cellRect(apple, APPLE);

  // eyes = a white block in the head cell (this is how readGrid finds the head)
  if (head >= 0) {
    const cx = head % cols;
    const cy = (head / cols) | 0;
    rect(pad + cx * cell + 6, pad + cy * cell + 6, 8, 8, WHITE);
  }

  return { data, W, H };
}

const CFG = { cols: COLS, rows: ROWS, cell: null };

test('detectBoard(): finds the playfield and the 17x15 grid', () => {
  const { data, W, H } = renderBoard();
  const B = Core.detectBoard(data, W, H, CFG, null);
  assert.ok(B, 'board detected');
  assert.equal(B.cols, COLS);
  assert.equal(B.rows, ROWS);
  assert.equal(B.minX, PAD);
  assert.equal(B.minY, PAD);
  assert.ok(Math.abs(B.cellX - CELL) < 0.001);
  assert.ok(Math.abs(B.cellY - CELL) < 0.001);
});

test('detectBoard(): returns null for a blank canvas', () => {
  const W = 200;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  assert.equal(Core.detectBoard(data, W, H, CFG, null), null);
});

test('detectBoard(): trusts the measured cell size over a wrong config hint', () => {
  const { data, W, H } = renderBoard();
  const B = Core.detectBoard(data, W, H, { cols: 23, rows: 19, cell: null }, null);
  assert.ok(B, 'board detected despite the bogus hint');
  assert.equal(B.cols, COLS);
  assert.equal(B.rows, ROWS);
});

test('detectBoard(): never shrinks the board when the snake covers an edge', () => {
  // All cells except the top row are playable; the top row is covered by the snake,
  // so a naive bounding box would report a smaller board.  `prev` must prevent that.
  const first = renderBoard();
  const B1 = Core.detectBoard(first.data, first.W, first.H, CFG, null);
  const snakeRow = [];
  for (let x = 0; x < COLS; x++) snakeRow.push(x);
  const covered = renderBoard({ snake: snakeRow, head: 0 });
  const B2 = Core.detectBoard(covered.data, covered.W, covered.H, CFG, B1);
  assert.ok(B2);
  assert.equal(B2.rows, ROWS);
  assert.equal(B2.minY, PAD);
});

test('readGrid(): reads snake, head, apple and obstacles exactly', () => {
  const snake = [idx(4, 5), idx(5, 5), idx(6, 5), idx(7, 5)]; // head last
  const apple = idx(12, 11);
  const walls = [idx(2, 2), idx(14, 14)];
  const { data, W, H } = renderBoard({ snake, apple, walls, head: idx(7, 5) });

  const B = Core.detectBoard(data, W, H, CFG, null);
  const g = Core.readGrid(data, W, B);

  assert.deepEqual(g.snake.slice().sort((a, b) => a - b), snake.slice().sort((a, b) => a - b));
  assert.equal(g.apple, apple);
  assert.deepEqual(g.walls.slice().sort((a, b) => a - b), walls.slice().sort((a, b) => a - b));
  assert.equal(g.head, idx(7, 5), 'head identified by the white eyes');
});

test('readGrid(): the outer ring is playable, not wall', () => {
  const apple = idx(0, 0); // top-left corner
  const { data, W, H } = renderBoard({ apple, head: -1 });
  const B = Core.detectBoard(data, W, H, CFG, null);
  const g = Core.readGrid(data, W, B);
  assert.equal(g.apple, apple);
  assert.deepEqual(g.walls, []);
});

test('readGrid(): handles an empty board without crashing', () => {
  const { data, W, H } = renderBoard();
  const B = Core.detectBoard(data, W, H, CFG, null);
  const g = Core.readGrid(data, W, B);
  assert.deepEqual(g.snake, []);
  assert.deepEqual(g.walls, []);
  assert.equal(g.apple, -1);
  assert.equal(g.head, -1);
});

test('headEntering(): detects the head crossing into the next cell', () => {
  const head = idx(7, 5);
  const { data, W, H } = renderBoard({ snake: [head], head });
  const B = Core.detectBoard(data, W, H, CFG, null);

  // the head is drawn in the cell, so the left edge of its own cell is "snake"
  assert.equal(Core.headEntering(data, W, B, head, 1), true, 'entering from the left');
  // the next cell is still empty board
  assert.equal(Core.headEntering(data, W, B, idx(8, 5), 1), false, 'empty cell ahead');
});

function idx(x, y) {
  return y * COLS + x;
}
