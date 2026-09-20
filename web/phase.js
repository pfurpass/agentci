// Both UIs re-render their lists on every event, which restarts CSS animations.
// A negative animation-delay lets a freshly created element resume the cycle where the old one
// was, so a spinner stays smooth no matter how often we redraw.
export function animDelay(startedAt, durationMs, now = Date.now()) {
  if (!startedAt || !Number.isFinite(startedAt) || startedAt > now) return '0s';
  return `-${(((now - startedAt) % durationMs) / 1000).toFixed(2)}s`;
}

export const RING_MS = 1350;
export const SPIN_MS = 900;

export function ringSvg(startedAt, now = Date.now()) {
  return `<svg class="spin-ring" viewBox="0 0 40 40" aria-hidden="true">`
    + '<rect class="track" x="1.5" y="1.5" width="37" height="37" rx="11"/>'
    + `<rect class="run" x="1.5" y="1.5" width="37" height="37" rx="11" style="animation-delay:${animDelay(startedAt, RING_MS, now)}"/>`
    + '</svg>';
}
