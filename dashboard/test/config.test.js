import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { displayConfig, runtimeConfig, configResponse } from '../server/config.js';
import { weatherLocation } from '../js/weather-config.js';
import worker from '../server/worker.js';

const location = { name: 'Example City', latitude: 40.7128, longitude: -74.006, timezone: 'America/New_York' };
const privateConfig = () => ({ people: { dad: 'Robin', mom: 'Sam', kiddo: 'Alex', family: 'Our household' },
  weather: { ...location, apiKey: 'private-weather-key' },
  photos: { albumUrl: 'https://photos.app.goo.gl/private-album' },
  calendars: [{ id: 'dad-work', calendar: 'dad', url: 'https://example.com/private-feed.ics' }],
  travel: { apiKey: 'private-travel-key', homeAddress: '123 Private Street' },
  countdowns: { url: 'https://example.com/private-countdowns.ics' },
});

test('display config has generic defaults and allows only names and location through', async () => {
  assert.deepEqual(displayConfig().people, { dad: 'Dad', mom: 'Mom', kiddo: 'Kiddo', family: 'Family' });
  assert.equal(displayConfig().weather.latitude, null);
  const response = configResponse(new Request('http://localhost/api/config'), privateConfig());
  const text = await response.text(), value = JSON.parse(text);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(value.people, privateConfig().people);
  assert.equal(value.weather.name, location.name);
  assert.equal(value.weather.latitude, location.latitude);
  for (const secret of ['private-weather-key', 'private-travel-key', 'private-album', 'private-feed', 'Private Street', 'private-countdowns']) {
    assert.ok(!text.includes(secret));
  }
  assert.equal(configResponse(new Request('http://localhost/api/config', { method: 'POST' }), {}).status, 405);
});

test('JSON settings override generic environment settings without changing calendar ownership', () => {
  const config = runtimeConfig(privateConfig(), { DASHY_DAD_NAME: 'Pat', DASHY_WEATHER_LATITUDE: '1',
    ICAL_DAD_PERSONAL_URL: 'https://example.com/env.ics' });
  assert.equal(config.people.dad, 'Robin');
  assert.equal(config.weather.latitude, location.latitude);
  assert.equal(config.calendars[0].calendar, 'dad');
  const env = runtimeConfig({}, { DASHY_DAD_NAME: 'Pat', DASHY_WEATHER_LATITUDE: '0', DASHY_WEATHER_LONGITUDE: '0',
    ICAL_KIDDO_URL: 'https://example.com/env.ics' });
  assert.equal(displayConfig(env).people.dad, 'Pat');
  assert.equal(env.weather.latitude, 0);
  assert.equal(env.calendars[0].calendar, 'kiddo');
});

test('invalid labels, coordinates, and timezones are rejected without echoing private values', () => {
  for (const config of [{ people: { dad: '<img src=x>' } }, { weather: { latitude: 91 } },
    { weather: { longitude: '40' } }, { weather: { timezone: 'private-invalid-zone' } }]) {
    assert.throws(() => displayConfig(config), error => !error.message.includes('private-invalid-zone') && !error.message.includes('<img'));
  }
});

test('browser loads private labels onto generic identities before startup and uses generic defaults on failure', async () => {
  for (const fail of [false, true]) {
    const people = [{ id: 'dad', name: 'Dad' }, { id: 'mom', name: 'Mom' }, { id: 'kiddo', name: 'Kiddo' }];
    const DATA = { people, family: { id: 'family', name: 'Family' } };
    const WEATHER_LOCATION = weatherLocation();
    const window = { App: {}, DATA };
    const context = vm.createContext({ window, WEATHER_LOCATION, weatherLocation, AbortSignal,
      fetch: async () => fail ? Promise.reject(new Error('offline')) : Response.json(displayConfig(privateConfig())) });
    vm.runInContext(readFileSync(new URL('../js/household.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
    await window.App.configReady;
    assert.deepEqual(people.map(p => p.id), ['dad', 'mom', 'kiddo']);
    assert.deepEqual(people.map(p => p.name), fail ? ['Dad', 'Mom', 'Kiddo'] : ['Robin', 'Sam', 'Alex']);
    assert.equal(WEATHER_LOCATION.latitude, fail ? null : location.latitude);
    assert.equal(DATA.family.name, fail ? 'Family' : 'Our household');
  }
});

test('hosted worker reads its JSON secret and exposes only display settings', async () => {
  const env = { DASHY_CONFIG: JSON.stringify(privateConfig()), ASSETS: { fetch: async () => new Response('page') } };
  const response = await worker.fetch(new Request('https://example.com/api/config'), env);
  assert.deepEqual(await response.json(), displayConfig(privateConfig()));
  assert.equal((await worker.fetch(new Request('https://example.com/api/config'), { DASHY_CONFIG: '{' })).status, 503);
  assert.equal(await (await worker.fetch(new Request('https://example.com/'), { ...env, DASHY_CONFIG: '{' })).text(), 'page');
});
