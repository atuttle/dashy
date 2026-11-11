import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounceNightAxis, hitsNightCorner } from '../js/night-motion.js';

test('night motion moves at a steady subtle speed', () => {
  assert.deepEqual(bounceNightAxis(100, 6, 10, 500), { position: 160, velocity: 6 });
  assert.deepEqual(bounceNightAxis(100, 4, 10, 500), { position: 140, velocity: 4 });
});

test('each edge reflects an overshoot without sticking or changing speed', () => {
  assert.deepEqual(bounceNightAxis(98, 6, 1, 100), { position: 96, velocity: -6 });
  assert.deepEqual(bounceNightAxis(2, -6, 1, 100), { position: 4, velocity: 6 });
  assert.deepEqual(bounceNightAxis(94, 6, 1, 100), { position: 100, velocity: -6 });
});

test('an overnight run stays inside the screen and visits both directions', () => {
  let state = { position: 50, velocity: 6 };
  const directions = new Set();
  for (let minute = 0; minute < 8 * 60; minute++) {
    state = bounceNightAxis(state.position, state.velocity, 60, 427);
    assert.ok(state.position >= 0 && state.position <= 427);
    assert.equal(Math.abs(state.velocity), 6);
    directions.add(Math.sign(state.velocity));
  }
  assert.equal(directions.size, 2);
});

test('resizing clamps the block inside its new bounds and handles no travel room', () => {
  assert.deepEqual(bounceNightAxis(300, 6, 1, 100), { position: 94, velocity: -6 });
  assert.deepEqual(bounceNightAxis(300, 6, 10, 0), { position: 0, velocity: 6 });
  assert.deepEqual(bounceNightAxis(300, -4, 10, -20), { position: 0, velocity: -4 });
});

test('perfect corner hits are detected between frames in all four directions', () => {
  for (const vx of [-6, 6]) for (const vy of [-4, 4]) {
    const state = { x: vx > 0 ? 94 : 6, y: vy > 0 ? 96 : 4, vx, vy };
    assert.equal(hitsNightCorner(state, { x: 100, y: 100 }, 1), true);
    assert.equal(hitsNightCorner(state, { x: 100, y: 100 }, .9), false);
  }
});

test('two wall hits in the same frame are not a corner when their times differ', () => {
  assert.equal(hitsNightCorner({ x: 94, y: 95.9, vx: 6, vy: 4 }, { x: 100, y: 100 }, 2), false);
  assert.equal(hitsNightCorner({ x: 100, y: 100, vx: -6, vy: -4 }, { x: 100, y: 100 }, .25), false);
  assert.equal(hitsNightCorner({ x: 0, y: 0, vx: 6, vy: 4 }, { x: 0, y: 0 }, .25), false);
});
