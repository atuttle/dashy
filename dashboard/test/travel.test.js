import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { addressQuery, travelBufferSeconds, travelRefreshMs, usableTravel, travelKey, TRAVEL_HORIZON_MS } from '../js/travel-model.js';
import { createTravelService, travelResponse } from '../server/travel.js';

const HOME = '123 Example Street, New York, NY 10001';
const DESTINATION = '456 Main St, West Chester, PA 19380';
const KEY = 'fake-server-only-key';

async function fixture(t, options = {}) {
  let now = Date.parse('2026-11-10T15:00:00Z');
  const state = { calls: [], failure: 0, duration: 2100, ambiguous: false, ...options };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let text = ''; for await (const chunk of request) text += chunk;
    state.calls.push({ url, headers: request.headers, body: text && JSON.parse(text), method: request.method });
    response.setHeader('Content-Type', 'application/json');
    if (state.failure) { response.writeHead(state.failure); response.end(JSON.stringify({ error: KEY + HOME })); return; }
    if (url.pathname.endsWith('/geocode')) {
      const home = url.searchParams.get('query') === HOME;
      const item = { type: 'address', address: { houseNumber: home ? '123' : '456', street: home ? 'Example Street' : 'Main Street', municipality: home ? 'New York' : 'West Chester', countrySubdivision: 'PA', postalCode: home ? '10001' : '19380' },
        position: { type: 'Point', coordinates: home ? [-75.8, 40] : [-75.6, 40] } };
      const results = [item];
      if (!home) {
        const duplicate = structuredClone(item);
        duplicate.position.coordinates[1] += 0.003;
        if (state.ambiguous) duplicate.address.municipality = 'Different City';
        results.push(duplicate);
      }
      response.end(JSON.stringify({ results }));
    } else response.end(JSON.stringify({ routes: [{ summary: { travelDurationInSeconds: state.duration } }], ignoredSecret: KEY }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const fetchImpl = (url, init) => {
    const mapped = new URL(url); mapped.protocol = 'http:'; mapped.host = '127.0.0.1:' + server.address().port;
    return fetch(mapped, init);
  };
  const service = createTravelService({ apiKey: KEY, homeAddress: HOME, fetchImpl, now: () => now });
  return { state, service, start: now + 3600000, now: () => now, advance: ms => { now += ms; } };
}

test('proportional buffer handles 35 minutes and caps at 15 minutes', () => {
  assert.equal(travelBufferSeconds(35 * 60), 350);
  assert.equal(travelBufferSeconds(30 * 60), 300);
  assert.equal(travelBufferSeconds(90 * 60), 900);
  assert.equal(travelBufferSeconds(180 * 60), 900);
});

test('address filtering skips virtual meetings, named places, and PO boxes', () => {
  for (const value of ['Home', 'Office', 'Zoom', 'https://meet.google.com/abc', 'PO Box 123', 'https://example.com/123 Main St', null]) assert.equal(addressQuery(value), null);
  assert.equal(addressQuery('Hospital\n701 E Marshall St, West Chester, PA 19380'), '701 E Marshall St, West Chester, PA 19380');
  assert.equal(addressQuery(HOME), HOME);
});

test('real HTTP geocodes and traffic-aware arrival routing coalesce and keep credentials private', async t => {
  const { state, service, start, now } = await fixture(t);
  const [one, two] = await Promise.all([service.snapshot(DESTINATION, start), service.snapshot(DESTINATION, start)]);
  assert.deepEqual(one, two);
  assert.equal(one.status, 'ok');
  assert.equal(one.driveSeconds, 2100); assert.equal(one.bufferSeconds, 350);
  assert.equal(one.nextCheckAt - now(), 300000);
  assert.equal(state.calls.length, 3);
  for (const call of state.calls) {
    assert.equal(call.headers['tomtom-api-key'], KEY);
    assert.ok(!String(call.url).includes(KEY));
  }
  const route = state.calls[2];
  assert.equal(route.headers['tomtom-api-version'], '3');
  assert.equal(route.body.traffic, 'live'); assert.equal(route.body.travelMode, 'car');
  assert.equal(route.body.arrivalDateTime, new Date(start).toISOString());
  assert.deepEqual(route.body.routePlanningLocations.origin.coordinates, [-75.8, 40]);
  await service.snapshot(DESTINATION, start);
  assert.equal(state.calls.length, 3);
  const serialized = JSON.stringify(one);
  for (const secret of [KEY, HOME, DESTINATION, '-75.8']) assert.ok(!serialized.includes(secret));
});

test('traffic rechecks reuse geocodes and account for the previous buffer', async t => {
  const f = await fixture(t);
  await f.service.snapshot(DESTINATION, f.start);
  f.advance(300001); f.state.duration = 2400;
  const result = await f.service.snapshot(DESTINATION, f.start);
  assert.equal(f.state.calls.length, 4);
  assert.equal(f.state.calls[3].body.arrivalDateTime, new Date(f.start - 350000).toISOString());
  assert.equal(result.driveSeconds, 2400); assert.equal(result.bufferSeconds, 400);
});

test('provider failures discard departure estimates and back off without exposing error bodies', async t => {
  const f = await fixture(t);
  await f.service.snapshot(DESTINATION, f.start);
  f.advance(300001); f.state.failure = 429;
  const result = await f.service.snapshot(DESTINATION, f.start);
  assert.equal(result.status, 'unavailable'); assert.equal(result.driveSeconds, undefined);
  assert.ok(!JSON.stringify(result).includes(KEY));
  await f.service.snapshot(DESTINATION, f.start);
  assert.equal(f.state.calls.length, 4);
});

test('a far-future cached trip switches to frequent checks as departure approaches', async t => {
  const f = await fixture(t);
  const start = f.now() + 3 * 3600000;
  let result = await f.service.snapshot(DESTINATION, start);
  assert.equal(result.nextCheckAt - f.now(), 30 * 60000);
  f.advance(25 * 60000);
  result = await f.service.snapshot(DESTINATION, start);
  assert.equal(f.state.calls.length, 4);
  assert.equal(result.nextCheckAt - f.now(), 5 * 60000);
});

test('distinct ambiguous addresses are rejected, while duplicate entrances are accepted', async t => {
  const f = await fixture(t, { ambiguous: true });
  assert.equal((await f.service.snapshot(DESTINATION, f.start)).status, 'unavailable');
  assert.equal(f.state.calls.length, 2);
});

test('unconfigured, non-address, past, and distant events make no provider requests', async t => {
  const f = await fixture(t);
  assert.equal((await createTravelService().snapshot(DESTINATION, f.start)).status, 'unconfigured');
  for (const [destination, start] of [['Office', f.start], [DESTINATION, f.now() - 1], [DESTINATION, f.now() + 86400001]]) assert.equal((await f.service.snapshot(destination, start)).status, 'skipped');
  assert.equal(f.state.calls.length, 0);
});

test('route adapter enforces GET and no-store, and local estimates expire more quickly near departure', async t => {
  const f = await fixture(t);
  const url = 'http://localhost/api/travel?' + new URLSearchParams({ destination: DESTINATION, eventStart: String(f.start) });
  const response = await travelResponse(new Request(url), f.service);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await travelResponse(new Request(url, { method: 'POST' }), f.service)).status, 405);
  const estimate = await response.json();
  assert.ok(usableTravel(estimate, f.now(), f.start));
  assert.ok(!usableTravel(estimate, f.now() + 15 * 60000, f.start));
  assert.equal(travelRefreshMs(f.now() + 10 * 3600000, 2100, f.now()), 30 * 60000);
});

test('browser integrates drive and buffer into leave-by and removes estimates on failure/calendar changes', async () => {
  const handlers = {}, data = { events: [{ id: 'one', loc: DESTINATION, start: new Date(Date.now() + 3600000) }] };
  let status = 'ok'; let interval;
  const context = vm.createContext({ URLSearchParams, AbortSignal, Date, Map, Set, addressQuery, travelKey, usableTravel, travelBufferSeconds, TRAVEL_HORIZON_MS,
    DATA: data, setInterval: callback => { interval = callback; }, addEventListener() {},
    App: { on: (event, callback) => { handlers[event] = callback; }, emit() {} },
    fetch: async () => ({ ok: true, json: async () => ({ status, source: 'TomTom', driveSeconds: 2100, fetchedAt: Date.now(), nextCheckAt: Date.now() + 60000 }) }),
  });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../js/travel.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  handlers.ready(); await handlers.calendars();
  assert.equal(data.events[0].driveMinutes, 35);
  assert.equal(data.events[0].bufferMinutes, 350 / 60);
  assert.equal(data.events[0].travel, 35 + 350 / 60);
  const old = data.events[0];
  data.events = [{ ...old, loc: 'Office' }]; await interval();
  assert.equal(data.events[0].travel, undefined);
  status = 'unavailable'; data.events = [{ ...old }]; await interval();
  assert.equal(data.events[0].travel, undefined);
});
