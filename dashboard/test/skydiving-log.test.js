import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPlaceholderSkydivingLog, jumpSummary, lastTwelveMonths, logDateLabel, reserveDaysLeft } from '../js/skydiving-log-model.js';

const NOW = Date.parse('2026-11-10T17:00:00Z');

test('placeholder jump totals agree with annual and current-year monthly counts', () => {
  const data = createPlaceholderSkydivingLog(NOW), summary = jumpSummary(data, NOW);
  assert.equal(data.placeholder, true);
  assert.equal(summary.total, data.jumpCountsByYear.reduce((total, record) => total + record.count, 0));
  assert.equal(summary.thisYear, data.jumpCountsByMonth.filter(record => record.month.startsWith('2026-')).reduce((total, record) => total + record.count, 0));
  assert.equal(summary.last12Months, data.jumpCountsByMonth.reduce((total, record) => total + record.count, 0));
  assert.equal(reserveDaysLeft(data.rigs[0].reserveRepackExpiresOn, NOW), 68);
  assert.equal(reserveDaysLeft(data.instructor.lastTIJumpOn, NOW), -6);
});

test('monthly series covers exactly twelve chronological months using the home timezone', () => {
  const months = lastTwelveMonths([{ month: '2026-01', count: 12 }], NOW);
  assert.equal(months.length, 12); assert.equal(months[0].month, '2025-12'); assert.equal(months[11].month, '2026-11');
  assert.equal(months.find(record => record.month === '2026-01').count, 12);
  assert.equal(months[0].count, null);
  const newYear = lastTwelveMonths([], Date.parse('2027-01-01T02:00:00Z'));
  assert.equal(newYear[0].month, '2026-01'); assert.equal(newYear[11].month, '2026-12');
  const january = lastTwelveMonths([], Date.parse('2027-01-01T17:00:00Z'));
  assert.equal(january[0].month, '2026-02'); assert.equal(january[11].month, '2027-01');
});

test('date-only repack expiration survives DST changes and rejects invalid dates', () => {
  assert.equal(reserveDaysLeft('2026-03-08', Date.parse('2026-03-07T18:00:00Z')), 1);
  assert.equal(reserveDaysLeft('2026-11-01', Date.parse('2026-10-31T18:00:00Z')), 1);
  assert.equal(reserveDaysLeft('2026-11-09', NOW), -1);
  assert.equal(reserveDaysLeft('2026-02-29', NOW), null);
  assert.equal(logDateLabel('2026-11-10'), 'Nov 10, 2026');
  assert.equal(logDateLabel(null), 'Not recorded');
});

test('missing real counts remain unknown instead of silently becoming zero', () => {
  assert.deepEqual(jumpSummary({ rigs: [], jumpCountsByYear: [], jumpCountsByMonth: [] }, NOW), {
    year: 2026, total: null, thisYear: null, last12Months: null,
  });
});

test('Skydiving renders rigs and both charts, marks placeholders, and shows instructor dates conditionally', () => {
  const data = { skydivingLog: createPlaceholderSkydivingLog(NOW) }, scroll = { scrollTop: 0 };
  const element = { innerHTML: '', querySelector: () => scroll };
  let view;
  const App = { current: 'skydiving', now: () => new Date(NOW), on() {},
    register(name, value) { assert.equal(name, 'skydiving'); view = value; },
    esc: text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  };
  const context = vm.createContext({ App, DATA: data, Intl, createPlaceholderSkydivingLog, jumpSummary, lastTwelveMonths, logDateLabel, reserveDaysLeft });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../js/views/skydiving.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  view.show(element);
  assert.match(element.innerHTML, /Placeholder data/); assert.match(element.innerHTML, /Primary rig/); assert.match(element.innerHTML, /Reserve repack expires/);
  assert.match(element.innerHTML, /Jump counts by year/); assert.match(element.innerHTML, /Jump counts for the last twelve months/);
  assert.match(element.innerHTML, /Instruction/);
  for (const field of ['lastTIJumpOn', 'lastAFFJumpOn', 'lastIADJumpOn']) assert.ok(element.innerHTML.includes(logDateLabel(data.skydivingLog.instructor[field])));
  assert.equal((element.innerHTML.match(/class="sd-chart-bar/g) || []).length, data.skydivingLog.jumpCountsByYear.length + 12);
  data.skydivingLog.isInstructor = false; data.skydivingLog.placeholder = false;
  data.skydivingLog.rigs[0].name = '<img src=x onerror=alert(1)>';
  view.show(element);
  assert.ok(!element.innerHTML.includes('Placeholder data')); assert.ok(!element.innerHTML.includes('Instruction'));
  assert.ok(!element.innerHTML.includes('<img')); assert.match(element.innerHTML, /&lt;img/);
});
