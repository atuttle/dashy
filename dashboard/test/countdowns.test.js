import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { countdownSchedule, countdownItems, countdownTheme, expandCountdowns, nextCountdown, COUNTDOWN_TIME_ZONE, COUNTDOWN_RETRY_MS } from '../js/countdown-model.js';
import { countdownBanner } from '../js/countdown-view.js';
import { createCountdownService, countdownResponse } from '../server/countdowns.js';

const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR', ''].join('\r\n');
const event = (id, start, end, title = id, extra = '') => ['BEGIN:VEVENT', 'UID:' + id,
  'DTSTART' + (start.length === 8 ? ';VALUE=DATE' : '') + ':' + start,
  'DTEND' + (end.length === 8 ? ';VALUE=DATE' : '') + ':' + end,
  'SUMMARY:' + title, extra, 'END:VEVENT'].filter(Boolean).join('\r\n');
const FEED_URL = 'https://calendar.example.com/private-countdown-token/basic.ics';
const ICS = calendar(event('annual', '20000320', '20000321', 'Birthday', 'RRULE:FREQ=YEARLY'), event('trip', '20261201', '20261209', 'Vacation'));

test('Eastern refresh schedule respects exact boundaries and summer/winter offsets', () => {
  for (const [input, last, next] of [
    ['2026-01-10T10:59:59Z', '2026-01-09T22:00:00Z', '2026-01-10T11:00:00Z'],
    ['2026-01-10T11:00:00Z', '2026-01-10T11:00:00Z', '2026-01-10T17:00:00Z'],
    ['2026-01-10T17:00:00Z', '2026-01-10T17:00:00Z', '2026-01-10T22:00:00Z'],
    ['2026-07-10T21:00:00Z', '2026-07-10T21:00:00Z', '2026-07-11T10:00:00Z'],
  ]) {
    const schedule = countdownSchedule(Date.parse(input));
    assert.equal(schedule.lastRefreshAt, Date.parse(last)); assert.equal(schedule.nextRefreshAt, Date.parse(next));
  }
});

test('overnight refreshes cross both DST changes at 6 AM local', () => {
  assert.equal(countdownSchedule(Date.parse('2026-03-07T22:00:00Z')).nextRefreshAt, Date.parse('2026-03-08T10:00:00Z'));
  assert.equal(countdownSchedule(Date.parse('2026-10-31T21:00:00Z')).nextRefreshAt, Date.parse('2026-11-01T11:00:00Z'));
});

test('recurring countdowns look beyond 90 days and show only the next occurrence per series', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const items = countdownItems(expandCountdowns(ICS, now), now);
  assert.deepEqual(items.map(x => x.title), ['Vacation', 'Birthday']);
  assert.equal(items.filter(x => x.uid === 'annual').length, 1);
  assert.equal(items[1].start.getFullYear(), 2027);
  assert.equal(items[1].days, 130);
});

test('countdowns honor moved and canceled recurring instances', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const ics = calendar(event('birthday', '20001112', '20001113', 'Birthday', 'RRULE:FREQ=YEARLY'),
    event('birthday', '20261114', '20261115', 'Birthday celebration', 'RECURRENCE-ID;VALUE=DATE:20261112'),
    event('canceled', '20261111', '20261112', 'Canceled trip', 'STATUS:CANCELLED'));
  const items = countdownItems(expandCountdowns(ics, now), now);
  assert.equal(items.length, 1); assert.equal(items[0].days, 4); assert.equal(items[0].title, 'Birthday celebration');
});

test('Today selects one nearest countdown, rolls forward, and skips events already underway', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const events = expandCountdowns(calendar(
    event('ongoing', '20261109', '20261120', 'Ongoing vacation'),
    event('past', '20261110T140000Z', '20261110T150000Z', 'Finished event'),
    event('soon', '20261110T180000Z', '20261110T190000Z', 'Next timed event'),
    event('later', '20261115', '20261116', 'Next birthday'),
  ), now);
  assert.equal(nextCountdown(events, now).title, 'Next timed event');
  assert.equal(nextCountdown(events, Date.parse('2026-11-10T18:30:00Z')).title, 'Next birthday');
  assert.equal(nextCountdown(events, Date.parse('2026-11-16T17:00:00Z')), null);
  const annual = expandCountdowns(calendar(event('annual', '20001109', '20001120', 'Annual vacation', 'RRULE:FREQ=YEARLY')), now);
  assert.equal(nextCountdown(annual, now).start.getFullYear(), 2027);
});

test('compact Today banner shares its theme, links to Countdowns, and preserves the date', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const next = nextCountdown(expandCountdowns(calendar(event('birthday', '20261115', '20261116', '<b>Birthday</b>')), now), now);
  const html = countdownBanner(next, { compact: true, stale: true });
  assert.match(html, /cd-banner--birthday h-countdown/); assert.match(html, /data-go="countdowns"/);
  assert.match(html, /&lt;b&gt;Birthday&lt;\/b&gt;/); assert.ok(html.includes(next.dateLabel));
  assert.equal((html.match(/<button /g) || []).length, 1); assert.match(html, /Saved dates/);
  assert.ok(!countdownBanner(next).includes('h-countdown'));
});

test('all-day dates and day counts stay correct in UTC and Pacific browsers, including a DST day', () => {
  const source = `import {expandCountdowns,countdownItems} from './js/countdown-model.js';
    const now=Date.parse('2026-03-07T18:00:00Z');
    const items=countdownItems(expandCountdowns(${JSON.stringify(calendar(event('day', '20260308', '20260309')))},now),now);
    console.log(JSON.stringify({days:items[0].days,label:items[0].dateLabel}));`;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { days: 1, label: 'Sun, Mar 8, 2026' });
  }
});

test('hours, days, weeks, months, today and underway states never count backward', () => {
  const now = Date.parse('2026-11-10T17:00:00Z');
  const items = countdownItems(expandCountdowns(calendar(
    event('now', '20261109', '20261112'), event('today', '20261110', '20261111'),
    event('hours', '20261110T193000Z', '20261110T203000Z'),
    event('soon', '20261110T173000Z', '20261110T183000Z'),
    event('days', '20261115', '20261116'), event('weeks', '20261201', '20261202'),
    event('months', '20270310', '20270311'), event('past', '20261101', '20261102'),
    event('fourteen', '20261124', '20261125'), event('fifteen', '20261125', '20261126'),
    event('eight-weeks', '20270105', '20270106'), event('over-eight-weeks', '20270106', '20270107'),
  ), now), now);
  const by = Object.fromEntries(items.map(x => [x.uid, x]));
  assert.equal(by.now.amount, 'Now'); assert.equal(by.today.amount, 'Today');
  assert.equal(by.hours.amount, 2); assert.equal(by.hours.unit, 'hours');
  assert.equal(by.soon.amount, '<1'); assert.equal(by.soon.unit, 'hour');
  assert.equal(by.days.amount, 5); assert.equal(by.weeks.unit, 'weeks'); assert.equal(by.months.unit, 'months');
  assert.equal(by.fourteen.amount, 14); assert.equal(by.fourteen.unit, 'days');
  assert.equal(by.fifteen.unit, 'weeks'); assert.equal(by['eight-weeks'].amount, 8); assert.equal(by['eight-weeks'].unit, 'weeks');
  assert.equal(by['over-eight-weeks'].unit, 'months');
  assert.equal(by.past, undefined);
});

test('event titles select holiday backgrounds, including punctuation, aliases and anniversary spelling', () => {
  for (const [title, tone] of [
    ['KIDDO’S BIRTHDAY', 'birthday'], ['Mom bday', 'birthday'], ['🎂', 'birthday'],
    ['Christmas', 'christmas'], ['Xmas', 'christmas'], ['Thanksgiving', 'autumn'],
    ["New Year's Day", 'newyear'], ['NYE', 'newyear'], ["Valentine's Day", 'valentine'],
    ['Easter', 'easter'], ['Independence Day', 'independence'], ['July 4th', 'independence'],
    ['Halloween', 'halloween'], ['St. Patrick’s Day', 'stpatrick'], ["Saint Patrick's Day", 'stpatrick'],
    ['Mother’s Day', 'mothers'], ['Mothers Day', 'mothers'], ["Father's Day", 'fathers'],
    ['Memorial Day', 'memorial'], ["Veteran's Day", 'veterans'], ['Veterans Day', 'veterans'], ['Veterans’ Day', 'veterans'],
    ['Labor Day', 'labor'], ['Labour Day', 'labor'], ['Wedding anniversary', 'wedding'], ['Wedding anniverary', 'wedding'],
    ['Dating anniversary', 'anniversary'], ['Anniverary', 'anniversary'], ['Hanukkah', 'green'], ['Beach vacation', 'green'],
    ['Concert', 'purple'], ['Skydiving boogie', 'green'], ['Some event', 'ink'],
  ]) assert.deepEqual(countdownTheme(title), { tone });
});

async function fixture(t, start = '2026-11-10T11:30:00Z') {
  const directory = await mkdtemp(join(tmpdir(), 'dashy-countdowns-'));
  let now = Date.parse(start);
  const state = { calls: 0, fail: false, text: ICS };
  const server = createServer((req, res) => { state.calls++; res.writeHead(state.fail ? 503 : 200); res.end(state.fail ? FEED_URL : state.text); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  const fetchImpl = (_url, init) => fetch('http://127.0.0.1:' + server.address().port, init);
  const options = { url: FEED_URL, cacheDir: directory, fetchImpl, now: () => now };
  return { state, directory, options, service: createCountdownService(options), now: () => now, set: time => { now = Date.parse(time); } };
}

test('HTTP feed checks coalesce, persist privately, survive restart, and catch up missed slots once', async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.service.snapshot(), f.service.snapshot()]);
  assert.deepEqual(one, two); assert.equal(f.state.calls, 1);
  f.set('2026-11-10T16:59:59Z');
  await createCountdownService(f.options).snapshot(); assert.equal(f.state.calls, 1);
  f.set('2026-11-10T17:00:00Z');
  await f.service.snapshot(); assert.equal(f.state.calls, 2);
  f.set('2026-11-11T15:00:00Z');
  const caughtUp = await createCountdownService(f.options).snapshot(); assert.equal(f.state.calls, 3);
  assert.equal(caughtUp.nextRefreshAt, Date.parse('2026-11-11T17:00:00Z'));
  const files = await readdir(f.directory); assert.equal(files.length, 1);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, files[0]))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(f.directory, files[0]), 'utf8')).includes(FEED_URL));
});

test('offline failures retain saved dates, use five-minute retries, and preserve source age', async t => {
  const f = await fixture(t); const first = await f.service.snapshot();
  f.set('2026-11-10T17:00:00Z'); f.state.fail = true;
  const offline = await f.service.snapshot();
  assert.equal(offline.error, true); assert.equal(offline.stale, true);
  assert.equal(offline.ics, first.ics); assert.equal(offline.fetchedAt, first.fetchedAt);
  assert.equal(offline.nextRefreshAt, Date.parse('2026-11-10T17:05:00Z'));
  await f.service.snapshot(); assert.equal(f.state.calls, 2);
  f.set('2026-11-10T17:05:00Z'); f.state.fail = false;
  assert.equal((await f.service.snapshot()).error, false); assert.equal(f.state.calls, 3);
});

test('scheduled slots override failure backoff, feed changes never reuse another private cache', async t => {
  const f = await fixture(t, '2026-11-10T16:59:59Z'); f.state.fail = true;
  assert.equal((await f.service.snapshot()).nextRefreshAt, Date.parse('2026-11-10T17:00:00Z'));
  f.set('2026-11-10T17:00:00Z'); f.state.fail = false;
  await f.service.snapshot(); assert.equal(f.state.calls, 2);
  f.state.fail = true;
  const replacement = await createCountdownService({ ...f.options, url: 'https://example.com/replacement-private.ics' }).snapshot();
  assert.equal(replacement.ics, undefined); assert.equal(replacement.error, true);
});

test('display response strips calendar credentials and private metadata, and rejects unsupported methods', async t => {
  const f = await fixture(t);
  f.state.text = ICS.replace('VERSION:2.0', 'VERSION:2.0\r\nSOURCE:' + FEED_URL).replace('SUMMARY:Vacation', 'SUMMARY:Vacation\r\nURL:' + FEED_URL + '\r\nATTENDEE:mailto:private@example.com');
  const response = await countdownResponse(new Request('http://localhost/api/countdowns'), f.service);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text(); assert.ok(!text.includes(FEED_URL)); assert.ok(!text.includes('private@example.com'));
  assert.equal((await countdownResponse(new Request('http://localhost/api/countdowns', { method: 'DELETE' }), f.service)).status, 405);
  assert.equal((await createCountdownService().snapshot()).configured, false);
});

test('manual POST refreshes the upstream feed immediately, coalesces clicks, and keeps the fixed schedule', async t => {
  const f = await fixture(t);
  const first = await f.service.snapshot(); assert.equal(f.state.calls, 1);
  f.set('2026-11-10T12:00:00Z');
  f.state.text = calendar(event('new-event', '20261225', '20261226', 'New Christmas event'));
  const request = () => new Request('http://localhost/api/countdowns', { method: 'POST', headers: { Origin: 'http://localhost' } });
  const [response, duplicate] = await Promise.all([countdownResponse(request(), f.service), countdownResponse(request(), f.service)]);
  const updated = await response.json(); assert.deepEqual(updated, await duplicate.json());
  assert.equal(f.state.calls, 2); assert.match(updated.ics, /New Christmas event/);
  assert.ok(updated.fetchedAt > first.fetchedAt);
  assert.equal(updated.nextRefreshAt, Date.parse('2026-11-10T17:00:00Z'));
  await f.service.snapshot(); assert.equal(f.state.calls, 2);
  f.state.fail = true; assert.equal((await f.service.snapshot({ force: true })).stale, true);
  f.state.fail = false; f.set('2026-11-10T12:01:00Z');
  const retry = await f.service.snapshot({ force: true }); assert.equal(retry.error, false); assert.equal(f.state.calls, 4);
  const denied = await countdownResponse(new Request('http://localhost/api/countdowns', { method: 'POST', headers: { Origin: 'https://example.com' } }), f.service);
  assert.equal(denied.status, 403); assert.equal(f.state.calls, 4);
});

test('a manual refresh arriving during a cached read still fetches the feed', async t => {
  const f = await fixture(t); await f.service.snapshot();
  f.state.text = calendar(event('updated', '20261225', '20261226', 'Updated event'));
  const reloaded = createCountdownService(f.options);
  const cached = reloaded.snapshot(); const manual = reloaded.snapshot({ force: true });
  await cached; assert.match((await manual).ics, /Updated event/);
  assert.equal(f.state.calls, 2);
});

test('browser schedules the next fixed slot while countdown rendering uses its own clock', async () => {
  let now = Date.parse('2026-11-10T17:00:00Z'), fail = false, timeout, release;
  const methods = []; let hold;
  const handlers = {}, App = { on: (name, callback) => { handlers[name] = callback; }, emit() {} };
  const context = vm.createContext({ App, Date: { now: () => now }, AbortSignal, COUNTDOWN_RETRY_MS,
    countdownSchedule: (time = now) => countdownSchedule(time), expandCountdowns: text => expandCountdowns(text, now),
    setTimeout: (callback, delay) => { timeout = { callback, delay }; }, clearTimeout() {},
    document: { addEventListener() {} }, addEventListener() {},
    fetch: async (_url, options) => { methods.push(options.method); if (hold) await hold; if (fail) throw new Error('Offline'); return { ok: true, json: async () => ({ configured: true, ics: ICS, fetchedAt: now, nextRefreshAt: countdownSchedule(now).nextRefreshAt }) }; },
  }); context.window = context;
  vm.runInContext(readFileSync(new URL('../js/countdowns.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  await handlers.ready(); assert.equal(timeout.delay, 5 * 3600000);
  now += 60000; hold = new Promise(resolve => { release = resolve; });
  const manual = App.refreshCountdowns(); App.refreshCountdowns();
  assert.equal(App.countdownState.refreshing, true); assert.deepEqual(methods, ['GET', 'POST']);
  release(); await manual; hold = null;
  assert.equal(App.countdownState.refreshing, false);
  assert.equal(timeout.delay, 5 * 3600000 - 60000);
  const events = App.countdownState.events;
  now += 5 * 3600000; fail = true; await timeout.callback();
  assert.equal(timeout.delay, 5 * 60000); assert.equal(App.countdownState.events, events); assert.equal(App.countdownState.stale, true);
});

test('countdown view renders real banners, escapes titles, and wires the refresh button with busy feedback', () => {
  const now = Date.parse('2026-11-10T17:00:00Z'); const grid = { scrollTop: 0 };
  let click, refreshCalls = 0;
  const element = { innerHTML: '', querySelector: () => grid, addEventListener: (name, callback) => { assert.equal(name, 'click'); click = callback; } };
  let view; const App = { now: () => new Date(now), current: 'countdowns',
    countdownState: { events: expandCountdowns(calendar(event('cake', '20261115', '20261116', '<b>Birthday</b>')), now), configured: true, fetchedAt: now - 6 * 60000 },
    esc: text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    register: (name, value) => { assert.equal(name, 'countdowns'); view = value; }, on() {},
    refreshCountdowns: () => { refreshCalls++; },
  };
  const context = vm.createContext({ App, Date: { now: () => now }, countdownItems, countdownBanner }); context.window = context;
  vm.runInContext(readFileSync(new URL('../js/icons.js', import.meta.url), 'utf8'), context);
  const iconCalls = [];
  App.icon = name => { assert.ok(context.ICONS[name]); iconCalls.push(name); return '<svg data-icon="' + name + '"></svg>'; };
  vm.runInContext(readFileSync(new URL('../js/views/countdowns.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
  view.show(element);
  assert.match(element.innerHTML, /cd-banner--birthday/); assert.match(element.innerHTML, /&lt;b&gt;Birthday&lt;\/b&gt;/);
  assert.deepEqual(iconCalls, ['undo']);
  assert.ok(!element.innerHTML.match(/<article[\s\S]*?<\/article>/)[0].includes('<svg'));
  assert.match(element.innerHTML, /until/); assert.match(element.innerHTML, /days/);
  assert.ok(!element.innerHTML.includes('Refreshes at'));
  assert.match(element.innerHTML, /Updated 6 min ago/); assert.match(element.innerHTML, /aria-label="Refresh countdowns"/);
  click({ target: { closest: () => ({ disabled: false }) } }); assert.equal(refreshCalls, 1);
  App.countdownState.refreshing = true; view.show(element);
  assert.match(element.innerHTML, /Refreshing…/); assert.match(element.innerHTML, /aria-busy="true" disabled/);
  click({ target: { closest: () => ({ disabled: true }) } }); assert.equal(refreshCalls, 1);
  App.countdownState = { events: [], error: false, configured: true }; view.show(element);
  assert.match(element.innerHTML, /No countdowns yet/); assert.ok(!element.innerHTML.includes('cd-banner '));
  App.countdownState.error = true; view.show(element); assert.match(element.innerHTML, /unavailable/);
});
