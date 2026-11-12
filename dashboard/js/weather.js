import { WEATHER_LOCATION, WEATHER_REFRESH_MS, WEATHER_MAX_AGE_MS } from './weather-config.js';

const App = window.App;
const cacheKey = () => `dashy.weather.${WEATHER_LOCATION.latitude},${WEATHER_LOCATION.longitude}.v1`;
let inFlight = false;
let refreshTimer;
App.weatherStatus = 'loading';

function validWeather(value) {
  return value?.source === 'Pirate Weather' && value.units?.temperature === 'F'
    && Number.isFinite(value.fetchedAt) && value.fetchedAt <= Date.now() + 60_000
    && value.location?.latitude === WEATHER_LOCATION.latitude
    && value.location?.longitude === WEATHER_LOCATION.longitude
    && Number.isFinite(value.current?.temperature) && Array.isArray(value.hourly);
}

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch('/api/weather', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Weather unavailable');
    const weather = await response.json();
    if (!validWeather(weather)) throw new Error('Invalid weather');
    window.DATA.weather = weather;
    App.weatherStatus = weather.stale ? 'error' : 'ready';
    try { localStorage.setItem(cacheKey(), JSON.stringify(weather)); } catch { /* Storage is optional. */ }
  } catch {
    App.weatherStatus = 'error';
  } finally {
    clearTimeout(timeout);
    inFlight = false;
    App.emit('weather');
    clearTimeout(refreshTimer);
    const nextRefresh = App.weatherStatus === 'error' ? 60_000
      : Math.max(1000, window.DATA.weather.fetchedAt + WEATHER_REFRESH_MS - Date.now());
    refreshTimer = setTimeout(refresh, nextRefresh);
  }
}

App.on('ready', function () {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey()));
    if (validWeather(cached) && Date.now() - cached.fetchedAt < WEATHER_MAX_AGE_MS) {
      window.DATA.weather = cached;
      App.weatherStatus = 'ready';
      App.emit('weather');
    }
  } catch { /* A corrupt cache must not prevent startup. */ }
  refresh();
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!window.DATA.weather
      || Date.now() - window.DATA.weather.fetchedAt >= WEATHER_REFRESH_MS)) refresh();
  });
});
