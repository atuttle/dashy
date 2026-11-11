import { countdownSchedule, expandCountdowns, COUNTDOWN_RETRY_MS } from './countdown-model.js';

const App = window.App;
App.countdownState = { loading: true, events: [], error: false, configured: true };
let pending = false, timer;

async function refresh(force = false) {
  if (pending) return;
  pending = true;
  App.countdownState = { ...App.countdownState, refreshing: true };
  App.emit('countdowns');
  let next = countdownSchedule().nextRefreshAt;
  try {
    const response = await fetch('/api/countdowns', { method: force ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Calendar unavailable');
    const result = await response.json();
    if (typeof result.configured !== 'boolean') throw new Error('Calendar unavailable');
    const events = result.ics ? expandCountdowns(result.ics) : [];
    App.countdownState = { loading: false, configured: result.configured, error: !!result.error,
      stale: !!result.stale, events, fetchedAt: result.fetchedAt, nextRefreshAt: result.nextRefreshAt };
    if (result.error) next = Math.min(next, Date.now() + COUNTDOWN_RETRY_MS);
    if (Number.isFinite(result.nextRefreshAt)) next = Math.min(next, result.nextRefreshAt);
  } catch {
    next = Math.min(next, Date.now() + COUNTDOWN_RETRY_MS);
    App.countdownState = { ...App.countdownState, loading: false, error: true, stale: !!App.countdownState.events.length, nextRefreshAt: next };
  } finally {
    pending = false;
    App.countdownState.refreshing = false;
    App.emit('data'); App.emit('countdowns');
    clearTimeout(timer);
    timer = setTimeout(refresh, Math.max(1000, next - Date.now()));
  }
}

App.refreshCountdowns = function () { return refresh(true); };
App.on('ready', function () { return refresh(); });
window.addEventListener('online', function () { refresh(); });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && (!App.countdownState.fetchedAt || Date.now() >= (App.countdownState.nextRefreshAt || 0))) refresh();
});
