import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { currentWeather, hourlyForecast } from '../js/weather-model.js';

function loadDashboard() {
  const context = vm.createContext({
    document: { addEventListener() {} },
    setTimeout, clearTimeout, setInterval,
    currentWeather, hourlyForecast,
  });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../js/data.js', import.meta.url), 'utf8'), context);
  const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
  vm.runInContext(appSource, context);
  return { App: context.App, data: context.DATA, context };
}

test('household has three people and a separate fourth calendar with valid references', () => {
  const { App, data } = loadDashboard();
  assert.deepEqual(Array.from(data.people, p => p.name), ['Dad', 'Mom', 'Kiddo']);
  assert.deepEqual(Array.from(App.calendars(), p => p.id), ['dad', 'mom', 'kiddo', 'family']);
  const people = new Set(data.people.map(p => p.id));
  const calendars = new Set(App.calendars().map(p => p.id));
  for (const event of [...data.events, ...data.busyExtras]) {
    assert.ok(calendars.has(event.calendar), `Unknown calendar on ${event.id}`);
    assert.equal(new Set(event.people).size, event.people.length);
    for (const id of event.people) assert.ok(people.has(id));
  }
  for (const chore of data.chores) assert.ok(chore.who === 'any' || people.has(chore.who));
  for (const photo of data.photos) assert.ok(people.has(photo.from));
});

test('Family events display on their own calendar without anyone invited', () => {
  const { App, data } = loadDashboard();
  const event = data.events.find(e => e.calendar === 'family' && !e.allDay);
  assert.equal(event.people.length, 0);
  assert.equal(App.isFamily(event), true);
  assert.equal(App.evColor(event), data.family);
  assert.ok(App.timedOn(event.start, 'family').includes(event));
  for (const person of data.people) assert.ok(!App.timedOn(event.start, person.id).includes(event));
  const allDay = data.events.find(e => e.calendar === 'family' && e.allDay);
  assert.ok(App.allDayOn(allDay.start, 'family').includes(allDay));
});

test('inviting everyone to a personal event does not turn it into a Family-calendar event', () => {
  const { App, data } = loadDashboard();
  const event = data.events.find(e => e.calendar === 'dad' && !e.allDay);
  event.people = data.ALL.slice();
  assert.equal(App.isFamily(event), false);
  assert.equal(App.evColor(event).id, 'dad');
  assert.ok(App.timedOn(event.start, 'dad').includes(event));
  assert.ok(!App.timedOn(event.start, 'family').includes(event));
  assert.ok(!App.timedOn(event.start, 'mom').includes(event));
});

test('Calendar refresh button shows busy state without moving the selected day or scroll position', () => {
  const { App, data, context } = loadDashboard();
  vm.runInContext(readFileSync(new URL('../js/icons.js', import.meta.url), 'utf8'), context);
  data.events = []; App.current = 'calendar'; App.calendarStatus = { loading: false, refreshing: false, feeds: [] };
  App.calendarMessage = () => '';
  let calls = 0, onScroll;
  const attributes = {}, button = { disabled: false, setAttribute: (key, value) => { attributes[key] = value; } };
  const handlers = {}, scroll = { scrollTop: 0, addEventListener: (_name, callback) => { onScroll = callback; } };
  const element = { innerHTML: '', addEventListener: (name, callback) => { handlers[name] = callback; },
    querySelector: selector => selector === '.grid-scroll' ? scroll : selector === '[data-calendar-refresh]' ? button : null,
  };
  App.refreshCalendars = () => { calls++; App.calendarStatus.refreshing = true; App.emit('calendarstatus'); };
  vm.runInContext(readFileSync(new URL('../js/views/calendar.js', import.meta.url), 'utf8'), context);
  App.views.calendar.show(element, {});
  assert.match(element.innerHTML, /aria-label="Refresh calendars"/);
  handlers.click({ target: { closest: selector => selector === '[data-nav]' ? { dataset: { nav: '1' } } : null } });
  const before = element.innerHTML.match(/<div class="cal-title">[\s\S]*?<\/div><\/div>/)[0];
  scroll.scrollTop = 321; onScroll();
  const click = { target: { closest: selector => selector === '[data-calendar-refresh]' ? button : null } };
  handlers.click(click); handlers.click(click);
  assert.equal(calls, 1); assert.equal(button.disabled, true); assert.equal(attributes['aria-busy'], 'true');
  App.calendarStatus.refreshing = false; App.emit('calendarstatus'); App.emit('data');
  assert.equal(button.disabled, false); assert.equal(attributes['aria-busy'], 'false'); assert.equal(scroll.scrollTop, 321);
  assert.equal(element.innerHTML.match(/<div class="cal-title">[\s\S]*?<\/div><\/div>/)[0], before);
});
