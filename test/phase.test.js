import test from 'node:test';
import assert from 'node:assert/strict';
import { animDelay, ringSvg, RING_MS, SPIN_MS } from '../web/phase.js';

test('animDelay resumes the cycle instead of restarting it', () => {
  const now = 1_000_000;
  assert.equal(animDelay(now, RING_MS, now), '-0.00s', 'a call that just started begins at 0');
  assert.equal(animDelay(now - 400, RING_MS, now), '-0.40s');
  assert.equal(animDelay(now - RING_MS, RING_MS, now), '-0.00s', 'a full cycle is back at the start');
  assert.equal(animDelay(now - RING_MS - 200, RING_MS, now), '-0.20s', 'phase survives many cycles');
  assert.equal(animDelay(now - 12_345, SPIN_MS, now), `-${(((12_345 % SPIN_MS) / 1000)).toFixed(2)}s`);
});

test('animDelay tolerates missing or future timestamps', () => {
  assert.equal(animDelay(undefined, RING_MS), '0s');
  assert.equal(animDelay(NaN, RING_MS), '0s');
  assert.equal(animDelay(Date.now() + 5000, RING_MS), '0s');
});

test('ringSvg renders track + running stroke with the phase delay', () => {
  const now = 1_000_000;
  const svg = ringSvg(now - 675, now);
  assert.match(svg, /class="spin-ring"/);
  assert.match(svg, /class="track"/);
  assert.match(svg, /class="run"[^>]*animation-delay:-0\.68s/);
});
