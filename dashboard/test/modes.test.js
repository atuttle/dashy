import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { currentWeather, hourlyForecast } from '../js/weather-model.js';

function dashboard(at) {
  let now = +new Date(at), tick;
  const nodes = new Map(), documentEvents = {};
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { dataset: {}, style: { setProperty() {} }, innerHTML: '',
        classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
        events: {}, addEventListener(name, fn) { this.events[name] = fn; } });
    }
    return nodes.get(selector);
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ Date: Clock, currentWeather, hourlyForecast,
    DATA: { people: [], events: [], busyExtras: [] },
    document: { querySelector: node, querySelectorAll: () => [],
      addEventListener: (name, fn) => { documentEvents[name] = fn; } },
    location: { hash: '#home' }, history: { replaceState() {} },
    innerWidth: 1280, innerHeight: 800, addEventListener() {},
    setInterval: (fn, ms) => { if (ms === 1000) tick = fn; return 1; },
    setTimeout: () => 1, clearInterval() {}, clearTimeout() {},
  });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../js/icons.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  const App = context.App;
  App.register('home', { show() {} });
  App.register('calendar', { show() {} });
  App.Slideshow = class { start() {} stop() {} };
  vm.runInContext(readFileSync(new URL('../js/views/ambient.js', import.meta.url), 'utf8'), context);
  App.start();
  return { App, node,
    advance(seconds) { for (let i = 0; i < seconds; i++) { now += 1000; tick(); } },
    jump(at) { now = +new Date(at); tick(); },
    touch() { documentEvents.pointerdown(); },
  };
}

test('night mode starts at 9:30 PM local time even while the dashboard is active', () => {
  const d = dashboard('2026-11-10T21:29:58');
  d.App.go('calendar');
  d.advance(1); d.touch();
  assert.equal(d.App.mode, 'day');
  d.advance(1);
  assert.equal(d.App.mode, 'night');
  assert.equal(d.App.current, 'home');
});

test('night startup initializes the overlays before switching modes and omits security claims', () => {
  for (const at of ['2026-11-10T21:30:00', '2026-11-11T00:00:00', '2026-11-11T05:59:59']) {
    const d = dashboard(at);
    assert.equal(d.App.mode, 'night');
    assert.match(d.node('#night .nt-inner').innerHTML, /nt-time/);
    assert.doesNotMatch(d.node('#night .nt-inner').innerHTML, /House locked|alarm armed|nt-lock/);
  }
});

test('6 AM restores the daytime dashboard, including after a suspended app resumes', () => {
  const d = dashboard('2026-11-11T05:59:59');
  d.advance(1);
  assert.equal(d.App.mode, 'day');
  const resumed = dashboard('2026-11-10T23:00:00');
  resumed.jump('2026-11-11T08:00:00');
  assert.equal(resumed.App.mode, 'day');
});

test('the photo screen saver starts after two idle minutes and tapping wakes Today', () => {
  const d = dashboard('2026-11-10T12:00:00');
  d.App.go('calendar'); d.touch();
  d.advance(59); assert.equal(d.App.current, 'calendar');
  d.advance(1); assert.equal(d.App.current, 'home');
  d.advance(59); assert.equal(d.App.mode, 'day');
  d.advance(1); assert.equal(d.App.mode, 'ambient');
  d.touch(); d.node('#ambient').events.click();
  assert.equal(d.App.mode, 'day'); assert.equal(d.App.current, 'home');
  d.advance(119); assert.equal(d.App.mode, 'day');
});

test('the photo screen saver switches to the night clock at the scheduled boundary', () => {
  const d = dashboard('2026-11-10T21:27:00');
  d.advance(120); assert.equal(d.App.mode, 'ambient');
  d.advance(60); assert.equal(d.App.mode, 'night');
});

test('tapping the night clock allows 20 idle seconds on the dim dashboard', () => {
  const d = dashboard('2026-11-10T22:00:00');
  d.touch(); d.node('#night').events.click();
  d.advance(19); assert.equal(d.App.mode, 'nightdash');
  d.touch(); d.advance(19); assert.equal(d.App.mode, 'nightdash');
  d.advance(1); assert.equal(d.App.mode, 'night');
});

test('a full-screen alert delays the scheduled mode change until it is dismissed', () => {
  const d = dashboard('2026-11-10T21:29:59');
  d.node('#takeover').classList.add('is-open');
  d.advance(1); assert.equal(d.App.mode, 'day');
  d.node('#takeover').classList.remove('is-open');
  d.advance(1); assert.equal(d.App.mode, 'night');
});
