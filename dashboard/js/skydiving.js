import { buildWeekendForecast } from './skydiving-model.js';
import { SKYDIVING_REFRESH_MS } from './skydiving-config.js';

const App = window.App;
let saved = null, pending = false, timer;
App.skydivingStatus = 'loading';
App.skydivingDays = () => buildWeekendForecast(saved);

async function refresh() {
  if (pending) return;
  pending = true;
  let delay = SKYDIVING_REFRESH_MS;
  try {
    const response = await fetch('/api/skydiving', { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Unavailable');
    const value = await response.json();
    if (value.station !== 'KMDT' || !Number.isFinite(value.checkedAt)) throw new Error('Unexpected forecast');
    saved = value;
    App.skydivingStatus = 'ready';
    const fetched = [value.aviation, value.basic].filter(source => source && !source.stale && Number.isFinite(source.fetchedAt));
    if (fetched.length) delay = Math.max(1000, Math.min(...fetched.map(source => source.fetchedAt)) + SKYDIVING_REFRESH_MS - Date.now());
    if (!value.aviation || !value.basic || value.aviation.stale || value.basic.stale) delay = Math.min(delay, 5 * 60000);
  } catch {
    App.skydivingStatus = 'error';
    if (saved) saved = { ...saved,
      aviation: saved.aviation ? { ...saved.aviation, stale: true } : null,
      basic: saved.basic ? { ...saved.basic, stale: true } : null };
    delay = 5 * 60000;
  } finally {
    pending = false;
    App.emit('skydiving');
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  }
}
App.on('ready', refresh);
window.addEventListener('online', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
