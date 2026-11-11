import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { nextDeparture } from '../js/departure-model.js';
import { bounceNightAxis } from '../js/night-motion.js';
import { travelBufferSeconds } from '../js/travel-model.js';

const MINUTE = 60000;
const START = +new Date('2026-11-11T16:00:00');
function event(overrides = {}) {
  return { id: 'appointment', calendar: 'dad', feedId: 'dad-personal', people: ['dad'],
    start: new Date(START), end: new Date(START + 60 * MINUTE), travel: 20,
    title: 'Appointment <with Dad>', loc: 'Location must not be shown', ...overrides };
}

test('departure begins exactly five minutes before leave-by, including drive time and buffer', () => {
  const appointment = event({ travel: 35 + travelBufferSeconds(35 * 60) / 60 });
  const leaveAt = START - 35 * MINUTE - 650000;
  assert.equal(nextDeparture([appointment], leaveAt - 5 * MINUTE - 1), null);
  assert.equal(nextDeparture([appointment], leaveAt - 5 * MINUTE).event, appointment);
  assert.equal(nextDeparture([appointment], leaveAt).leaveAt, leaveAt);
});

test('only Dad personal/work and Family calendars qualify, regardless of attendees', () => {
  const now = START - 23 * MINUTE;
  for (const [calendar, feedId] of [['dad', 'dad-personal'], ['dad', 'dad-work'], ['family', 'family']]) {
    const appointment = event({ calendar, feedId, people: [] });
    assert.equal(nextDeparture([appointment], now).event, appointment);
  }
  for (const calendar of ['mom', 'kiddo', 'unknown', undefined]) {
    assert.equal(nextDeparture([event({ calendar, people: ['dad', 'mom', 'kiddo'] })], now), null);
    assert.equal(nextDeparture([event({ calendar, travel: undefined, people: ['dad'] })], START), null);
  }
});

test('missing or invalid driving estimates fall back to appointment time; all-day events stay excluded', () => {
  for (const travel of [undefined, 0, -1, NaN, Infinity]) {
    const appointment = event({ travel });
    assert.equal(nextDeparture([appointment], START - 5 * MINUTE - 1), null);
    assert.equal(nextDeparture([appointment], START - 5 * MINUTE).leaveAt, START);
    assert.equal(nextDeparture([appointment], START + 5 * MINUTE - 1).event, appointment);
    assert.equal(nextDeparture([appointment], START + 5 * MINUTE), null);
  }
  assert.equal(nextDeparture([event({ allDay: true, travel: undefined })], START), null);
});

test('the reminder ends exactly five minutes after leave-by, before appointment start', () => {
  const appointment = event();
  const leaveAt = START - 20 * MINUTE;
  assert.equal(nextDeparture([appointment], leaveAt).event, appointment);
  assert.equal(nextDeparture([appointment], leaveAt + 5 * MINUTE - 1).event, appointment);
  assert.equal(nextDeparture([appointment], leaveAt + 5 * MINUTE), null);
  assert.equal(nextDeparture([appointment], START), null);
});

test('route refresh preserves the leave-by deadline without repeating at appointment time', () => {
  const appointment = event();
  const departures = new Map();
  const leaveAt = START - 20 * MINUTE;
  nextDeparture([appointment], leaveAt - 3 * MINUTE, departures);
  const refreshed = event({ travel: undefined });
  assert.equal(nextDeparture([refreshed], leaveAt - 2 * MINUTE, departures).leaveAt, leaveAt);
  assert.equal(nextDeparture([refreshed], leaveAt + MINUTE, departures).leaveAt, leaveAt);
  assert.equal(nextDeparture([refreshed], leaveAt + 5 * MINUTE, departures), null);
  assert.equal(nextDeparture([refreshed], START, departures), null);
});

test('removal, rescheduling, and calendar ownership changes clear remembered departure times', () => {
  for (const replacement of [[], [event({ travel: undefined, start: new Date(START + 60 * MINUTE) })],
    [event({ calendar: 'mom' })], [event({ allDay: true })]]) {
    const departures = new Map();
    nextDeparture([event()], START - 23 * MINUTE, departures);
    assert.equal(nextDeparture(replacement, START - 22 * MINUTE, departures), null);
    assert.equal(departures.size, 0);
  }
});

test('the earliest eligible departure wins, even when another calendar owns the home hero', () => {
  const first = event({ id: 'first', calendar: 'family' });
  const second = event({ id: 'second', travel: 18 });
  assert.equal(nextDeparture([event({ calendar: 'mom', travel: 25 }), second, first], START - 21 * MINUTE).event, first);
  assert.equal(nextDeparture([first, second], START - 15 * MINUTE).event, second);
});

function overlay(at, events = []) {
  let now = at, frameId = 0;
  const nodes = new Map(), handlers = {}, frames = new Map(), windowEvents = {};
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { style: {}, textContent: '', hidden: true,
      clientWidth: 1280, clientHeight: 800, offsetWidth: 752, offsetHeight: 432 });
    return nodes.get(selector);
  }
  const App = { $: node, now: () => new Date(now), events: () => events,
    fmt: { mins: m => Math.max(0, Math.round(m)) + ' min' },
    on(name, fn) { (handlers[name] ||= []).push(fn); },
    emit(name) { for (const fn of handlers[name] || []) fn(); } };
  const context = vm.createContext({ App, nextDeparture, bounceNightAxis,
    window: { addEventListener(name, fn) { windowEvents[name] = fn; } }, document: {},
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id) });
  vm.runInContext(readFileSync(new URL('../js/views/departure.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
  App.emit('ready');
  return { node, App, frames,
    advance(to) { now = to; App.emit('second'); },
    events(list) { events = list; App.emit('data'); },
    resize: () => windowEvents.resize(),
    frame(time) { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); } };
}

test('the overlay activates on a live data update, uses only the title, and cleans up on expiration', () => {
  const d = overlay(START - 25 * MINUTE);
  assert.equal(d.node('#departure').hidden, true);
  assert.equal(d.frames.size, 0);
  d.events([event()]);
  assert.equal(d.node('#departure').hidden, false);
  assert.equal(d.node('.dep-time').textContent, 'Leave in 5 min');
  assert.equal(d.node('.dep-title').textContent, 'Appointment <with Dad>');
  assert.doesNotMatch(d.node('#departure').innerHTML, /Location|dvd|loc|nt-/);
  assert.equal(d.frames.size, 1);
  d.advance(START - 24 * MINUTE + 1);
  assert.equal(d.node('.dep-time').textContent, 'Leave in 4 min');
  assert.equal(d.frames.size, 1);
  d.advance(START - 20 * MINUTE - 1);
  assert.equal(d.node('.dep-time').textContent, 'Leave in 1 min');
  d.advance(START - 20 * MINUTE);
  assert.equal(d.node('.dep-time').textContent, 'LEAVE NOW');
  d.advance(START - 15 * MINUTE - 1);
  assert.equal(d.node('.dep-time').textContent, 'LEAVE NOW');
  d.advance(START - 15 * MINUTE);
  assert.equal(d.node('#departure').hidden, true);
  assert.equal(d.frames.size, 0);
  d.advance(START);
  d.events([event({ travel: undefined })]);
  assert.equal(d.node('#departure').hidden, true);
});

test('without a driving estimate the overlay counts down to appointment start and ends five minutes later', () => {
  const d = overlay(START - 5 * MINUTE, [event({ travel: undefined })]);
  assert.equal(d.node('#departure').hidden, false);
  assert.equal(d.node('.dep-time').textContent, 'Leave in 5 min');
  d.advance(START - 1);
  assert.equal(d.node('.dep-time').textContent, 'Leave in 1 min');
  d.advance(START);
  assert.equal(d.node('.dep-time').textContent, 'LEAVE NOW');
  d.advance(START + 5 * MINUTE - 1);
  assert.equal(d.node('#departure').hidden, false);
  assert.equal(d.node('.dep-time').textContent, 'LEAVE NOW');
  d.advance(START + 5 * MINUTE);
  assert.equal(d.node('#departure').hidden, true);
  assert.equal(d.frames.size, 0);
});

test('the overlay bounces at the night clock speed with no DVD swap and clamps after resizing', () => {
  const d = overlay(START - 25 * MINUTE, [event()]);
  const content = d.node('.dep-inner');
  d.frame(0);
  const initial = content.style.transform;
  for (let time = 250; time <= 40000; time += 250) d.frame(time);
  assert.notEqual(content.style.transform, initial);
  assert.equal(d.node('.dep-time').textContent, 'Leave in 5 min');
  assert.equal(content.style.transform, 'translate3d(504.00px,344.00px,0)');
  for (let time = 40250; time <= 44000; time += 250) d.frame(time);
  assert.equal(content.style.transform, 'translate3d(528.00px,360.00px,0)');
  for (let time = 44250; time <= 46000; time += 250) d.frame(time);
  assert.equal(content.style.transform, 'translate3d(516.00px,368.00px,0)');
  content.offsetWidth = 1280; content.offsetHeight = 800;
  d.resize();
  assert.equal(content.style.transform, 'translate3d(0.00px,0.00px,0)');
  d.frame(46250);
  assert.equal(content.style.transform, 'translate3d(0.00px,0.00px,0)');
  d.events([]);
  assert.equal(d.frames.size, 0);
});
