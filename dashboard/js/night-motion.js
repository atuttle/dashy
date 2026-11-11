// Reflect an axis at its edges, preserving constant speed even after an overshoot.
export function bounceNightAxis(position, velocity, elapsed, limit) {
  if (limit <= 0) return { position: 0, velocity };
  const start = Math.max(0, Math.min(limit, position));
  const speed = Math.abs(velocity);
  const phase = ((velocity < 0 ? 2 * limit - start : start) + speed * Math.max(0, elapsed)) % (2 * limit);
  return phase < limit
    ? { position: phase, velocity: speed }
    : { position: 2 * limit - phase, velocity: -speed };
}

// Compare collision times, not rounded screen positions or whether both axes bounced in a frame.
export function hitsNightCorner(state, bounds, elapsed) {
  if (bounds.x <= 0 || bounds.y <= 0 || !state.vx || !state.vy) return false;
  const x = (state.vx > 0 ? bounds.x - state.x : state.x) / Math.abs(state.vx);
  const y = (state.vy > 0 ? bounds.y - state.y : state.y) / Math.abs(state.vy);
  const epsilon = 1e-7; // Only floating-point tolerance; far smaller than a screen pixel.
  return x > epsilon && x <= elapsed + epsilon && Math.abs(x - y) <= epsilon;
}
