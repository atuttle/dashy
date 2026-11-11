import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { currentWeather, hourlyForecast } from '../js/weather-model.js';
import { bounceNightAxis, hitsNightCorner } from '../js/night-motion.js';
import { nextDeparture } from '../js/departure-model.js';

function dashboard(at, nightSize = {}) {
  let now = +new Date(at), tick;
  const nodes = new Map(), documentEvents = {};
  const frames = new Map();
  let frameId = 0;
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { dataset: {}, style: { setProperty() {} }, innerHTML: '',
        clientWidth: 1280, clientHeight: 800, offsetWidth: nightSize.width ?? 720, offsetHeight: nightSize.height ?? 320,
        classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c),
          toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
        events: {}, addEventListener(name, fn) { this.events[name] = fn; }, querySelector: node });
    }
    return nodes.get(selector);
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ Date: Clock, currentWeather, hourlyForecast, bounceNightAxis, hitsNightCorner, nextDeparture,
    DATA: { people: [], events: [], busyExtras: [] },
    document: { querySelector: node, querySelectorAll: () => [],
      addEventListener: (name, fn) => { documentEvents[name] = fn; } },
    location: { hash: '#home' }, history: { replaceState() {} },
    innerWidth: 1280, innerHeight: 800, addEventListener() {},
    setInterval: (fn, ms) => { if (ms === 1000) tick = fn; return 1; },
    setTimeout: () => 1, clearInterval() {}, clearTimeout() {},
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../js/icons.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  const App = context.App;
  App.register('home', { show() {} });
  App.register('calendar', { show() {} });
  App.Slideshow = class { start() {} stop() {} };
  vm.runInContext(readFileSync(new URL('../js/views/ambient.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  vm.runInContext(readFileSync(new URL('../js/views/departure.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
  App.start();
  return { App, node,
    advance(seconds) { for (let i = 0; i < seconds; i++) { now += 1000; tick(); } },
    jump(at) { now = +new Date(at); tick(); },
    touch() { documentEvents.pointerdown(); },
    frame(time) { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); },
    activeFrames() { return frames.size; },
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

test('a perfect corner swaps the clock for DVD for 15 seconds without stopping its motion', () => {
  const d = dashboard('2026-11-10T22:00:00', { width: 800, height: 480 });
  const block = d.node('#night .nt-inner');
  d.frame(0);
  for (let time = 250; time <= 40000; time += 250) d.frame(time);
  assert.equal(block.classList.contains('is-dvd'), true);
  const corner = block.style.transform;
  assert.equal(corner, 'translate3d(480.00px,320.00px,0)');
  d.frame(40250);
  assert.notEqual(block.style.transform, corner);
  d.App.emit('minute');
  assert.equal(block.classList.contains('is-dvd'), true);
  assert.match(block.innerHTML, /\/art\/night-dvd.svg/);
  d.frame(54999); assert.equal(block.classList.contains('is-dvd'), true);
  d.frame(55000); assert.equal(block.classList.contains('is-dvd'), false);
  d.App.setMode('day');
  assert.equal(d.activeFrames(), 0);
});

test('the corner demo guarantees its first hit without changing the normal drift speed', () => {
  const d = dashboard('2026-11-10T12:00:00');
  const block = d.node('#night .nt-inner');
  d.App.demoNightCorner();
  d.frame(0);
  for (let time = 250; time < 8000; time += 250) {
    d.frame(time);
    assert.equal(block.classList.contains('is-dvd'), false);
  }
  d.frame(8000);
  assert.equal(block.classList.contains('is-dvd'), true);
  d.frame(23000);
  assert.equal(block.classList.contains('is-dvd'), false);
});

test('departure reminders appear over day, ambient, and night screens and preserve the underlying mode', () => {
  for (const mode of ['day', 'ambient', 'night']) {
    const d = dashboard('2026-11-10T12:00:00');
    d.App.state.people = [{ id: 'dad', name: 'Dad', color: '#00A36C', rgb: '0 163 108', ink: '#FFFFFF' }];
    d.App.setMode(mode);
    d.App.state.events = [{ id: 'appointment', calendar: 'dad', people: ['dad'], title: 'Lunch',
      start: new Date('2026-11-10T12:25:00'), end: new Date('2026-11-10T13:00:00'), travel: 20 }];
    d.App.emit('data');
    assert.equal(d.node('#departure').hidden, false);
    assert.equal(d.node('.dep-time').textContent, 'Leave in 5 min');
    assert.equal(d.App.mode, mode);
    d.jump('2026-11-10T12:05:00');
    assert.equal(d.node('.dep-time').textContent, 'LEAVE NOW');
    d.jump('2026-11-10T12:09:59');
    assert.equal(d.node('.dep-time').textContent, 'LEAVE NOW');
    d.jump('2026-11-10T12:10:00');
    assert.equal(d.node('#departure').hidden, true);
    assert.equal(d.App.mode, mode);
    assert.equal(d.activeFrames(), mode === 'night' ? 1 : 0);
  }
});

test('clock jumps and calendar removals immediately update the departure overlay', () => {
  const d = dashboard('2026-11-10T12:00:00');
  d.App.state.events = [{ id: 'appointment', calendar: 'family', people: [], title: 'Family dinner',
    start: new Date('2026-11-10T18:00:00'), end: new Date('2026-11-10T19:00:00'), travel: 20 }];
  d.App.emit('data');
  assert.equal(d.node('#departure').hidden, true);
  d.App.setTime(17, 35);
  assert.equal(d.node('#departure').hidden, false);
  d.App.state.events = [];
  d.App.emit('data');
  assert.equal(d.node('#departure').hidden, true);
  assert.equal(d.activeFrames(), 0);
});
