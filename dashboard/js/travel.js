import { addressQuery, travelKey, usableTravel, travelBufferSeconds, TRAVEL_HORIZON_MS } from './travel-model.js';

const App = window.App;
const estimates = new Map();
let pending = false;

function apply() {
  const now = Date.now();
  for (const event of window.DATA.events) {
    const estimate = estimates.get(travelKey(event));
    delete event.travel; delete event.driveMinutes; delete event.bufferMinutes;
    if (!event.allDay && usableTravel(estimate, now, +event.start)) {
      event.driveMinutes = estimate.driveSeconds / 60;
      event.bufferMinutes = travelBufferSeconds(estimate.driveSeconds) / 60;
      event.travel = event.driveMinutes + event.bufferMinutes;
    }
  }
  App.emit('data');
}

async function refresh() {
  if (pending) return;
  pending = true;
  const now = Date.now();
  const candidates = window.DATA.events.filter(event => !event.allDay && +event.start > now
    && +event.start <= now + TRAVEL_HORIZON_MS && addressQuery(event.loc))
    .sort((a, b) => a.start - b.start).slice(0, 4);
  const keep = new Set(candidates.map(travelKey));
  for (const key of estimates.keys()) if (!keep.has(key)) estimates.delete(key);
  apply();
  try {
    for (const event of candidates) {
      const key = travelKey(event), saved = estimates.get(key);
      if (saved?.nextCheckAt > Date.now() && (saved.status !== 'ok' || usableTravel(saved, Date.now(), +event.start))) continue;
      try {
        const params = new URLSearchParams({ destination: addressQuery(event.loc), eventStart: String(+event.start) });
        const response = await fetch('/api/travel?' + params, { cache: 'no-store', signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw new Error('Unavailable');
        const result = await response.json();
        estimates.set(key, { ...result, nextCheckAt: Math.max(Date.now() + 60000, Math.min(result.nextCheckAt || Date.now() + 300000, Date.now() + 1800000)) });
        if (result.status === 'unconfigured') break;
      } catch { estimates.set(key, { status: 'unavailable', nextCheckAt: Date.now() + 300000 }); }
      apply();
    }
  } finally { pending = false; apply(); }
}

App.on('calendars', refresh);
App.on('ready', function () { setInterval(refresh, 60000); });
window.addEventListener('online', refresh);
