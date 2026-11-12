import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWeatherService, normalizeForecast, weatherResponse } from '../server/weather.js';
import { currentWeather, hourlyForecast, freshnessRemaining } from '../js/weather-model.js';
import { WEATHER_REFRESH_MS, WEATHER_MAX_AGE_MS } from '../js/weather-config.js';
const WEATHER_LOCATION = { name: 'New York, NY', postalCode: '10001', latitude: 40.7128, longitude: -74.006, timezone: 'America/New_York' };
import worker from '../server/worker.js';

// 11:30 PM in New York: the forecast must continue into the following day.
const NOW = Date.parse('2026-11-11T04:30:00Z');
const fixture = () => ({
  timezone: 'America/New_York', flags: { units: 'us' },
  currently: { time: NOW / 1000, temperature: 45.4, apparentTemperature: 40.2,
    windSpeed: 9.5, humidity: 0.65, icon: 'clear-night', summary: 'Clear' },
  hourly: { summary: 'Snow possible tomorrow.', data: Array.from({ length: 48 }, (_, i) => ({
    time: Math.floor(NOW / 3_600_000) * 3600 + i * 3600,
    temperature: 45 + i, icon: i === 1 ? 'snow' : 'clear-night', precipProbability: i === 1 ? 0.6 : 0,
  })) },
  daily: { data: [{ temperatureMax: 52.2, temperatureMin: 31.7 }] },
});

let upstream, origin, scenario, calls, captured;
before(async () => {
  upstream = createServer((req, res) => {
    calls++;
    const url = new URL(req.url, 'http://localhost');
    captured = { path: url.pathname, units: url.searchParams.get('units'), key: req.headers.apikey };
    if (req.headers.apikey !== 'test-weather-key' || url.searchParams.get('units') !== 'us'
      || url.pathname !== '/forecast/dashy/40.7128,-74.006') {
      res.writeHead(401).end('Invalid request');
      return;
    }
    if (scenario === 'unavailable') { res.writeHead(503).end('<html>Provider unavailable</html>'); return; }
    if (scenario === 'unauthorized') { res.writeHead(403).end('test-weather-key is invalid'); return; }
    if (scenario === 'limited') { res.writeHead(429).end('Rate limited'); return; }
    if (scenario === 'malformed') { res.writeHead(200).end('{'); return; }
    if (scenario === 'incomplete') { res.writeHead(200).end('{}'); return; }
    if (scenario === 'slow') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify(fixture())); }, 100);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(fixture()));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  origin = `http://127.0.0.1:${upstream.address().port}`;
});
beforeEach(() => { scenario = 'ok'; calls = 0; captured = null; });
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

function service(options = {}) {
  return createWeatherService({ apiKey: 'test-weather-key', location: WEATHER_LOCATION, origin, now: () => NOW, ...options });
}
const request = () => new Request('http://dashy.local/api/weather');

test('real HTTP request uses US units and header auth; returned data contains no key', async () => {
  const response = await weatherResponse(request(), service());
  assert.equal(response.status, 200);
  const text = await response.text();
  const weather = JSON.parse(text);
  assert.equal(captured.key, 'test-weather-key');
  assert.ok(!captured.path.includes('test-weather-key'));
  assert.ok(!text.includes('test-weather-key'));
  assert.equal(weather.location.name, 'New York, NY');
  assert.deepEqual(weather.units, { temperature: 'F', wind: 'mph' });
  assert.equal(weather.current.temperature, 45.4);
  assert.equal(weather.current.windSpeed, 9.5);
  assert.equal(weather.fetchedAt, NOW);
  assert.equal(weather.stale, false);
});

test('simultaneous requests and repeated reads share one forecast for fifteen minutes', async () => {
  let clock = NOW;
  const weather = service({ now: () => clock });
  await Promise.all([weather.forecast(), weather.forecast(), weather.forecast()]);
  assert.equal(calls, 1);
  clock += WEATHER_REFRESH_MS - 1;
  await weather.forecast();
  assert.equal(calls, 1);
  clock++;
  await weather.forecast();
  assert.equal(calls, 2);
});

test('outages preserve the last good forecast, mark it stale, and back off retries', async () => {
  let clock = NOW;
  const weather = service({ now: () => clock });
  await weather.forecast();
  clock += WEATHER_REFRESH_MS;
  scenario = 'unavailable';
  const stale = await weather.forecast();
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, NOW);
  assert.equal(calls, 2);
  await weather.forecast();
  assert.equal(calls, 2);
  clock = NOW + WEATHER_MAX_AGE_MS;
  assert.equal((await weatherResponse(request(), weather)).status, 503);
  clock += 60_000;
  scenario = 'ok';
  const recovered = await weather.forecast();
  assert.equal(recovered.stale, false);
  assert.equal(recovered.fetchedAt, clock);
});

for (const mode of ['unauthorized', 'limited', 'unavailable', 'malformed', 'incomplete', 'slow']) {
  test(`${mode} response produces an honest unavailable state without provider errors or secrets`, async () => {
    scenario = mode;
    const response = await weatherResponse(request(), service({ timeoutMs: mode === 'slow' ? 20 : 2000 }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Weather unavailable. Retrying shortly.' });
  });
}

test('missing configuration and unsupported methods make no provider request', async () => {
  assert.equal((await weatherResponse(request(), service({ apiKey: '' }))).status, 503);
  const response = await weatherResponse(new Request(request().url, { method: 'POST' }), service());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
  assert.equal(calls, 0);
});

test('unexpected units and invalid temperatures are rejected instead of mislabeled', () => {
  const metric = fixture();
  metric.flags.units = 'si';
  assert.throws(() => normalizeForecast(metric, NOW, WEATHER_LOCATION));
  const missing = fixture();
  missing.currently.temperature = null;
  assert.throws(() => normalizeForecast(missing, NOW, WEATHER_LOCATION));
});

test('hourly display crosses midnight using tomorrow’s data and New York’s timezone', () => {
  const weather = normalizeForecast(fixture(), NOW, WEATHER_LOCATION);
  const hours = hourlyForecast(weather, 7, NOW);
  assert.equal(hours.length, 7);
  assert.equal(hours[0].label, 'Now');
  assert.equal(hours[1].label, '12a');
  assert.equal(hours[1].t, 46);
  assert.equal(hours[1].c, 'snow');
  assert.equal(hours[1].p, 60);
  assert.deepEqual(hourlyForecast(weather, 7, NOW + 49 * 3_600_000), []);
});

test('missing or expired data never falls back to sample weather', () => {
  assert.equal(currentWeather(null, 'loading', NOW).label, 'Loading weather…');
  assert.equal(currentWeather(null, 'error', NOW).temp, '—');
  const weather = normalizeForecast(fixture(), NOW, WEATHER_LOCATION);
  assert.equal(currentWeather(weather, 'ready', NOW).available, true);
  assert.equal(currentWeather(weather, 'error', NOW).stale, true);
  assert.equal(currentWeather(weather, 'ready', NOW + WEATHER_MAX_AGE_MS).available, false);
});

test('freshness countdown starts full, reaches half at 7.5 minutes, and empties at 15 minutes', () => {
  const weather = normalizeForecast(fixture(), NOW, WEATHER_LOCATION);
  assert.equal(freshnessRemaining(weather, NOW), 1);
  assert.equal(freshnessRemaining(weather, NOW + WEATHER_REFRESH_MS / 2), 0.5);
  assert.equal(freshnessRemaining(weather, NOW + WEATHER_REFRESH_MS), 0);
  assert.equal(freshnessRemaining({ ...weather, stale: true }, NOW), 0);
  assert.equal(freshnessRemaining({ ...weather, fetchedAt: NOW + 1000 }, NOW), 1);
});

test('browser resumes saved freshness and schedules refresh from fetch time, not page load', async () => {
  const cached = normalizeForecast(fixture(), NOW - WEATHER_REFRESH_MS / 2, WEATHER_LOCATION);
  const timers = new Map();
  const listeners = {};
  const App = { on: (name, fn) => { listeners[name] = fn; }, emit: () => {} };
  const window = { App, DATA: { weather: null }, addEventListener: () => {} };
  const document = { addEventListener: () => {} };
  const source = readFileSync(new URL('../js/weather.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
  let requests = 0;
  const context = vm.createContext({ window, document, localStorage: {
    getItem: () => JSON.stringify(cached), setItem: () => {},
  }, Date: class extends Date { static now() { return NOW; } },
  WEATHER_LOCATION, WEATHER_REFRESH_MS, WEATHER_MAX_AGE_MS, AbortController,
  setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
  clearTimeout: id => timers.delete(id),
  fetch: async () => { requests++; return Response.json({ ...cached, stale: false }); },
  });
  vm.runInContext(source, context);
  listeners.ready();
  assert.equal(window.DATA.weather.fetchedAt, cached.fetchedAt);
  // Wait for the response body and refresh's finally block, not an arbitrary elapsed delay.
  for (let i = 0; i < 20 && App.weatherStatus === 'loading'; i++) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(App.weatherStatus, 'ready');
  assert.equal(requests, 1);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, WEATHER_REFRESH_MS / 2);
});

test('hosted worker keeps API errors as JSON and delegates page requests to static assets', async () => {
  const env = { ASSETS: { fetch: async () => new Response('dashboard') } };
  assert.equal((await worker.fetch(request(), env)).status, 503);
  assert.equal((await worker.fetch(new Request('http://dashy.local/api/missing'), env)).status, 404);
  assert.equal(await (await worker.fetch(new Request('http://dashy.local/'), env)).text(), 'dashboard');
});
