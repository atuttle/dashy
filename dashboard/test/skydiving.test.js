import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { rateAviation, rateBasic, weekendDates, buildWeekendForecast } from '../js/skydiving-model.js';
import { parseAviationPage, normalizeBasicForecast, createSkydivingService, skydivingResponse } from '../server/skydiving.js';
import { SKYDIVING_REFRESH_MS } from '../js/skydiving-config.js';

const NOW = Date.parse('2026-11-11T00:00:00Z');
const HOUR = 3600000;
const good = { flightCategory: 'VFR', windSpeedMph: 18, windGustMph: 29, cloudCover: 'Partly cloudy', lowestCloudBaseFt: 5000, unlimitedBase: false };
const basicGood = { windSpeedMph: 18, cloudCover: 0.6, precipProbability: 0.2, icon: 'partly-cloudy-day' };
function points(step, fields) {
  const start = Date.parse('2026-11-14T00:00:00Z');
  return Array.from({ length: 72 / step + 1 }, (_, i) => ({ ...fields, time: start + i * step * HOUR }));
}
const aviation = () => ({ fetchedAt: NOW, issuedAt: NOW, points: points(3, good) });
const basic = () => ({ fetchedAt: NOW, points: points(1, basicGood) });

test('detailed thresholds preserve strict/inclusive boundaries and prioritize no-go', () => {
  assert.equal(rateAviation(good).label, 'likely');
  for (const category of ['IFR', 'MVFR', 'LIFR']) assert.equal(rateAviation({ ...good, flightCategory: category }).label, 'no-go');
  assert.equal(rateAviation({ ...good, windSpeedMph: 24, windGustMph: 30 }).label, 'no-go');
  assert.equal(rateAviation({ ...good, windSpeedMph: 18.1 }).label, 'questionable');
  assert.equal(rateAviation({ ...good, windGustMph: 30 }).label, 'questionable'); // spread = 12
  assert.equal(rateAviation({ ...good, windGustMph: 33 }).label, 'questionable'); // spread = 15
  assert.equal(rateAviation({ ...good, windGustMph: 33.1 }).label, 'no-go');
  assert.equal(rateAviation({ ...good, windGustMph: 33.01 }).label, 'no-go');
  assert.equal(rateAviation({ ...good, lowestCloudBaseFt: 4999 }).label, 'questionable');
  assert.equal(rateAviation({ ...good, cloudCover: 'Mostly cloudy', lowestCloudBaseFt: 3000 }).label, 'questionable');
  assert.equal(rateAviation({ ...good, cloudCover: 'Mostly cloudy', lowestCloudBaseFt: 2999 }).label, 'no-go');
  assert.equal(rateAviation({ ...good, lowestCloudBaseFt: 2999 }).label, 'questionable'); // AND, not OR
});

test('unlimited cloud base is favorable; missing fields and inconsistent gusts never become likely', () => {
  assert.equal(rateAviation({ ...good, lowestCloudBaseFt: null, unlimitedBase: true }).label, 'likely');
  for (const field of ['flightCategory', 'windSpeedMph', 'windGustMph', 'cloudCover', 'lowestCloudBaseFt']) {
    const result = rateAviation({ ...good, [field]: null });
    assert.equal(result.label, 'questionable');
    assert.equal(result.incomplete, true);
  }
  assert.equal(rateAviation({ ...good, windGustMph: 17 }).label, 'questionable');
  assert.equal(rateAviation({ ...good, flightCategory: 'IFR', windSpeedMph: null }).label, 'no-go');
});

test('basic ratings use the approved rain/cloud/wind limits and explicit precipitation forecast', () => {
  assert.equal(rateBasic(basicGood).label, 'probable');
  assert.equal(rateBasic({ ...basicGood, precipProbability: 0.201 }).label, 'maybe');
  assert.equal(rateBasic({ ...basicGood, cloudCover: 0.601 }).label, 'maybe');
  assert.equal(rateBasic({ ...basicGood, windSpeedMph: 18.1 }).label, 'maybe');
  assert.equal(rateBasic({ ...basicGood, windSpeedMph: 24 }).label, 'no-go');
  for (const icon of ['rain', 'snow', 'sleet', 'hail']) assert.equal(rateBasic({ ...basicGood, icon }).label, 'no-go');
  assert.equal(rateBasic({ ...basicGood, windSpeedMph: null }).label, 'maybe');
});

test('weekend dates use Eastern time, stay paired through Sunday, and roll forward Monday', () => {
  assert.deepEqual(weekendDates(NOW), ['2026-11-14', '2026-11-15']);
  assert.deepEqual(weekendDates(Date.parse('2026-11-16T03:59:00Z')), ['2026-11-14', '2026-11-15']); // still Sunday
  assert.deepEqual(weekendDates(Date.parse('2026-11-16T05:00:00Z')), ['2026-11-21', '2026-11-22']);
  assert.deepEqual(weekendDates(Date.parse('2027-01-01T12:00:00Z')), ['2027-01-02', '2027-01-03']);
});

test('day ratings use 9 AM–local sunset and exclude overnight hazards', () => {
  const source = aviation();
  source.points.find(p => p.time === Date.parse('2026-11-14T06:00:00Z')).flightCategory = 'IFR'; // 1 AM
  const days = buildWeekendForecast({ aviation: source }, NOW);
  assert.deepEqual(days.map(d => d.label), ['likely', 'likely']);
  assert.equal(new Date(days[0].start).toISOString(), '2026-11-14T14:00:00.000Z'); // 9 AM EST
  assert.ok(days[0].end > Date.parse('2026-11-14T21:30:00Z') && days[0].end < Date.parse('2026-11-14T22:00:00Z'));
  assert.ok(days.every(d => d.points.every(p => p.time >= d.start && p.time < d.end)));
  const summer = buildWeekendForecast({}, Date.parse('2027-07-01T12:00:00Z'))[0];
  assert.equal(new Date(summer.start).toISOString(), '2027-07-03T13:00:00.000Z'); // 9 AM EDT
  assert.ok(summer.end > Date.parse('2027-07-04T00:30:00Z') && summer.end < Date.parse('2027-07-04T01:00:00Z'));
});

test('one daytime no-go overrides other likely points and each day is independent', () => {
  const source = aviation();
  source.points.find(p => p.time === Date.parse('2026-11-14T18:00:00Z')).windSpeedMph = 24;
  const days = buildWeekendForecast({ aviation: source }, NOW);
  assert.deepEqual(days.map(d => d.label), ['no-go', 'likely']);
  assert.match(days[0].reasons.join(), /24 mph/);
});

test('basic forecasts cover the long range, then each day upgrades independently to aviation', () => {
  const source = aviation();
  source.points = source.points.filter(p => p.time <= Date.parse('2026-11-15T00:00:00Z'));
  const days = buildWeekendForecast({ aviation: source, basic: basic() }, NOW);
  assert.deepEqual(days.map(d => [d.source, d.label]), [['aviation', 'likely'], ['basic', 'probable']]);
  assert.deepEqual(buildWeekendForecast({ basic: basic() }, NOW).map(d => d.label), ['probable', 'probable']);
});

test('partial aviation cannot be replaced by an optimistic basic forecast', () => {
  const source = aviation();
  source.points = source.points.filter(p => p.time <= Date.parse('2026-11-14T18:00:00Z'));
  source.points.at(-1).flightCategory = 'MVFR';
  const saturday = buildWeekendForecast({ aviation: source, basic: basic() }, NOW)[0];
  assert.equal(saturday.source, 'mixed');
  assert.equal(saturday.label, 'no-go');
  assert.match(saturday.reasons.join(), /MVFR/);
  assert.equal(buildWeekendForecast({ aviation: source }, NOW)[0].incomplete, true);
});

test('missing/expired/stale data does not produce a favorable rating; gaps invalidate full-day coverage', () => {
  assert.deepEqual(buildWeekendForecast({}, NOW).map(d => d.label), ['unavailable', 'unavailable']);
  assert.equal(buildWeekendForecast({ aviation: { ...aviation(), stale: true } }, NOW)[0].label, 'unavailable');
  assert.equal(buildWeekendForecast({ basic: { ...basic(), fetchedAt: NOW - 2 * HOUR } }, NOW)[0].label, 'unavailable');
  const source = basic();
  source.points = source.points.filter(p => p.time !== Date.parse('2026-11-14T18:00:00Z'));
  assert.equal(buildWeekendForecast({ basic: source }, NOW)[0].label, 'unavailable');
});

test('completed Saturday stays completed on Sunday and only remaining Sunday hours are rated', () => {
  const now = Date.parse('2026-11-15T17:30:00Z');
  const source = { ...basic(), fetchedAt: now };
  source.points.find(p => p.time === Date.parse('2026-11-15T14:00:00Z')).windSpeedMph = 30;
  const days = buildWeekendForecast({ basic: source }, now);
  assert.equal(days[0].label, 'finished');
  assert.equal(days[1].label, 'probable');
  assert.equal(days[1].remaining, true);
});

function htmlFixture(issue = NOW / 1000) {
  const data = { timezone: 'America/New_York', windunit: 'mph',
    epochs: [issue + HOUR / 1000, issue + 4 * HOUR / 1000],
    sources: [{ product: 'NBS', issue }, { product: 'NBS', issue }],
    weather: [{ WSP: 6, GST: 8, LCB: 'Unlimited', CAT: 'VFR', SKY: 2 }, { WSP: 20, GST: 30, LCB: 30, CAT: 'MVFR', SKY: 70 }],
    charts: [{ key: 'WSP', values: [6.90468, 23.0156] }, { key: 'GST', values: [9.20624, 34.5234] }, { key: 'LCB', values: [null, 3000] }] };
  return '<pre>KMDT NBM NBS GUIDANCE</pre><span class="sky-name">Clear</span><span class="sky-name">Mostly cloudy</span>' +
    '<script type="application/json" id="forecast-data">' + JSON.stringify(data) + '</script>';
}
const basicFixture = () => ({ timezone: 'America/New_York', flags: { units: 'us' }, hourly: { data: [{
  time: NOW / 1000, windSpeed: 15, windGust: 18, cloudCover: 0.4, precipProbability: 0.1, icon: 'partly-cloudy-day' }] } });

test('USAirNet extraction uses converted chart mph/feet, explicit unlimited base, categories and source times', () => {
  const source = parseAviationPage(htmlFixture(), NOW);
  assert.equal(source.points[0].windSpeedMph, 7); // not raw 6 knots
  assert.equal(source.points[0].windGustMph, 9);
  assert.equal(source.points[0].unlimitedBase, true);
  assert.equal(source.points[1].lowestCloudBaseFt, 3000); // not raw 30 hundreds of feet
  assert.equal(source.points[1].cloudCover, 'Mostly cloudy');
  assert.equal(source.points[1].flightCategory, 'MVFR');
  assert.equal(source.issuedAt, NOW);
  assert.throws(() => parseAviationPage(htmlFixture().replace('KMDT', 'KPHL'), NOW));
  assert.throws(() => parseAviationPage('<html>Temporary outage</html>', NOW));
});

test('basic normalization rejects wrong units/location and keeps unknown fields unknown', () => {
  assert.equal(normalizeBasicForecast(basicFixture(), NOW).points[0].windSpeedMph, 15);
  const missing = basicFixture();
  missing.hourly.data[0].windSpeed = null;
  assert.equal(normalizeBasicForecast(missing, NOW).points[0].windSpeedMph, null);
  const metric = basicFixture(); metric.flags.units = 'si';
  assert.throws(() => normalizeBasicForecast(metric, NOW));
});

test('source requests are coalesced, cached hourly, header-authenticated, and fail independently', async () => {
  let clock = NOW, failAviation = false;
  const requests = [];
  const service = createSkydivingService({ apiKey: 'fake-secret', now: () => clock, fetchImpl: async (url, options) => {
    requests.push({ url, key: options.headers.apikey });
    if (url.includes('usairnet')) {
      if (failAviation) throw new Error('Failure');
      return new Response(htmlFixture());
    }
    return Response.json(basicFixture());
  } });
  const [first] = await Promise.all([service.snapshot(), service.snapshot()]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].key, 'fake-secret');
  assert.ok(requests[1].url.includes('extend=hourly') && requests[1].url.includes('40.2,-76.77'));
  assert.ok(!requests[1].url.includes('fake-secret'));
  assert.ok(!JSON.stringify(first).includes('fake-secret'));
  await service.snapshot(); assert.equal(requests.length, 2);
  clock += SKYDIVING_REFRESH_MS;
  failAviation = true;
  const next = await service.snapshot();
  assert.equal(requests.length, 4);
  assert.equal(next.aviation.stale, true);
  assert.equal(next.basic.stale, false);
  await service.snapshot(); assert.equal(requests.length, 4);
  clock += 5 * 60000;
  await service.snapshot(); assert.equal(requests.length, 5);
});

test('wrong methods make no upstream request; missing keys do not prevent the aviation source', async () => {
  let calls = 0;
  const service = createSkydivingService({ now: () => NOW, fetchImpl: async () => { calls++; return new Response(htmlFixture()); } });
  const invalid = await skydivingResponse(new Request('http://localhost/api/skydiving', { method: 'POST' }), service);
  assert.equal(invalid.status, 405);
  assert.equal(calls, 0);
  const response = await skydivingResponse(new Request('http://localhost/api/skydiving'), service);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls, 1);
  assert.equal((await response.json()).basic, null);
});

test('browser refresh resumes source age after reload and removes favorable stale ratings on errors', async () => {
  const listeners = {}, timers = new Map();
  const App = { on: (name, fn) => { listeners[name] = fn; }, emit() {} };
  const window = { App, addEventListener() {} };
  const snapshot = { station: 'KMDT', checkedAt: NOW,
    aviation: { ...aviation(), fetchedAt: NOW - HOUR / 2 }, basic: { ...basic(), fetchedAt: NOW - HOUR / 2 } };
  let fail = false;
  const context = vm.createContext({ window, document: { addEventListener() {} },
    buildWeekendForecast: snapshot => buildWeekendForecast(snapshot, NOW), SKYDIVING_REFRESH_MS, AbortSignal,
    Date: class extends Date { static now() { return NOW; } },
    fetch: async () => { if (fail) throw new Error('Offline'); return Response.json(snapshot); },
    setTimeout: (fn, delay) => { const id = Symbol(); timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const source = readFileSync(new URL('../js/skydiving.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  await listeners.ready();
  assert.equal(App.skydivingStatus, 'ready');
  assert.ok(App.skydivingDays().every(day => day.label === 'likely'));
  assert.equal([...timers.values()][0].delay, HOUR / 2);
  fail = true;
  await [...timers.values()][0].fn();
  assert.equal(App.skydivingStatus, 'error');
  assert.ok(App.skydivingDays().every(day => day.label === 'unavailable'));
  assert.equal([...timers.values()][0].delay, 5 * 60000);
});
