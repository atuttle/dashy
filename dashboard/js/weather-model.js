import { WEATHER_LOCATION, WEATHER_REFRESH_MS, WEATHER_MAX_AGE_MS } from './weather-config.js';

const icons = {
  'clear-day': 'sun', 'clear-night': 'moon', cloudy: 'cloud',
  'partly-cloudy-day': 'partly', 'partly-cloudy-night': 'partly',
  rain: 'rain', snow: 'snow', sleet: 'sleet', hail: 'sleet',
  wind: 'wind', fog: 'fog', thunderstorm: 'thunder',
};
const round = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : '—';

export function freshnessRemaining(weather, now = Date.now()) {
  if (!weather || weather.stale || !Number.isFinite(weather.fetchedAt)) return 0;
  return Math.max(0, Math.min(1, 1 - (now - weather.fetchedAt) / WEATHER_REFRESH_MS));
}

export function currentWeather(weather, status, now = Date.now()) {
  if (!weather || now - weather.fetchedAt >= WEATHER_MAX_AGE_MS) {
    const message = status === 'loading' ? 'Loading weather…' : 'Weather unavailable';
    return { available: false, temp: '—', cond: 'cloud', summary: message, label: message,
      location: WEATHER_LOCATION.name, stale: false };
  }
  return {
    available: true,
    location: weather.location.name,
    temp: round(weather.current.temperature),
    cond: icons[weather.current.icon] || 'cloud',
    label: weather.current.summary,
    summary: weather.summary || weather.current.summary,
    hi: round(weather.high), lo: round(weather.low),
    feels: round(weather.current.feelsLike), wind: round(weather.current.windSpeed),
    humidity: weather.current.humidity == null ? '—' : round(weather.current.humidity * 100),
    fetchedAt: weather.fetchedAt,
    stale: weather.stale || status === 'error' || now - weather.fetchedAt >= WEATHER_REFRESH_MS,
  };
}

export function hourlyForecast(weather, count, now = Date.now()) {
  if (!weather || now - weather.fetchedAt >= WEATHER_MAX_AGE_MS) return [];
  const start = weather.hourly.findIndex(point => point.time + 3_600_000 > now);
  if (start < 0) return [];
  return weather.hourly.slice(start, start + count).map((point, index) => ({
    time: point.time,
    t: round(point.temperature),
    c: icons[point.icon] || 'cloud',
    p: point.precipProbability == null ? null : Math.round(point.precipProbability * 100),
    label: index === 0 ? 'Now' : new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: true, timeZone: WEATHER_LOCATION.timezone,
    }).format(point.time).replace(/\s/g, '').replace('AM', 'a').replace('PM', 'p'),
  }));
}
