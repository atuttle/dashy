import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_REFRESH_MS, mergeCalendarFeeds, parseCalendarFeed, sanitizeCalendar } from '../js/calendar-model.js';
import { createCalendarService, calendarResponse } from '../server/calendars.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const calendar = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const event = (...fields) => ['BEGIN:VEVENT', ...fields, 'END:VEVENT'].join('\r\n');
const feed = (ics, id = 'dad-personal', owner = 'dad') => ({ id, calendar: owner, ics });
const simple = event('UID:appointment', 'DTSTART:20261101T150000Z', 'DTEND:20261101T160000Z', 'SUMMARY:Appointment');

test('recurrences honor DST, exclusions, moved instances, and cancellations', () => {
  const zone = ['BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
  const master = event('UID:repeat', 'DTSTART;TZID=America/New_York:20261030T090000',
    'DTEND;TZID=America/New_York:20261030T100000', 'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;TZID=America/New_York:20261031T090000', 'SUMMARY:Daily');
  const cancelled = event('UID:repeat', 'RECURRENCE-ID;TZID=America/New_York:20261102T090000',
    'DTSTART;TZID=America/New_York:20261102T090000', 'DTEND;TZID=America/New_York:20261102T100000', 'STATUS:CANCELLED');
  const moved = event('UID:repeat', 'RECURRENCE-ID;TZID=America/New_York:20261103T090000',
    'DTSTART;TZID=America/New_York:20261103T110000', 'DTEND;TZID=America/New_York:20261103T120000', 'SUMMARY:Moved');
  const events = parseCalendarFeed(feed(calendar(zone, master, cancelled, moved)), { now: NOW });
  assert.deepEqual(events.map(e => e.start.toISOString()), ['2026-10-30T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-03T16:00:00.000Z']);
  assert.equal(events[2].title, 'Moved');
});

test('all-day dates use local midnight and preserve exclusive end; missing end lasts one day', () => {
  const events = parseCalendarFeed(feed(calendar(
    event('UID:trip', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261103', 'SUMMARY:Trip'),
    event('UID:holiday', 'DTSTART;VALUE=DATE:20261101', 'SUMMARY:Holiday'))), { now: NOW });
  assert.ok(events.every(e => e.allDay && e.start.getHours() === 0 && e.end.getHours() === 0));
  assert.equal(events[0].end.getDate(), 3);
  assert.equal(events[1].end.getDate(), 2);
});

test('Dad feeds merge duplicate invitations, while Family remains a separate source', () => {
  const result = mergeCalendarFeeds([feed(calendar(simple)), feed(calendar(simple), 'dad-work'),
    feed(calendar(simple), 'family', 'family')], { now: NOW });
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map(e => e.calendar), ['dad', 'family']);
  assert.deepEqual(result.events[1].people, []);
  assert.ok(result.events.every(e => e.readonly));
});

test('feed failure is explicit, retains available events, and never supplies placeholders', () => {
  const result = mergeCalendarFeeds([{ id: 'dad-work', calendar: 'dad', error: true },
    { ...feed(calendar(simple)), error: true, stale: true }], { now: NOW });
  assert.equal(result.events.length, 1);
  assert.ok(result.feeds.every(f => f.error));
  assert.equal(result.feeds[1].stale, true);
});

test('feed sanitizing removes source URL, attendees, alarms, and redacts exact feed URL in text', () => {
  const url = 'https://calendar.example/secret.ics';
  const cleaned = sanitizeCalendar(calendar('SOURCE:' + url, event('UID:test', 'DTSTART:20261101T150000Z',
    'SUMMARY:Line one\r\n continued', 'ATTENDEE:mailto:private@example.com', 'URL:' + url,
    'DESCRIPTION:' + url, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'END:VALARM')), url);
  assert.ok(!cleaned.includes(url) && !cleaned.includes('ATTENDEE') && !cleaned.includes('VALARM'));
  assert.match(cleaned, /SUMMARY:Line onecontinued/);
});

test('sanitizing preserves every event field, including title and end time', () => {
  const original = calendar(event('DTSTART:20261101T233000Z', 'DTEND:20261102T010000Z',
    'UID:recording', 'SUMMARY:Podcast recording', 'LOCATION:Office', 'DESCRIPTION:Recording session', 'SEQUENCE:2'));
  const parsed = parseCalendarFeed(feed(sanitizeCalendar(original)), { now: NOW });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Podcast recording');
  assert.equal(parsed[0].end - parsed[0].start, 90 * 60000);
  assert.equal(parsed[0].loc, 'Office');
  assert.equal(parsed[0].notes, 'Recording session');
  assert.equal(parsed[0].sequence, 2);
});

test('server coalesces reads, refreshes at fifteen minutes, and keeps stale data through outages', async () => {
  let now = NOW, calls = 0, fail = false;
  const service = createCalendarService([{ id: 'dad-personal', calendar: 'dad', url: 'https://example.com/private' }], {
    now: () => now, fetchImpl: async () => {
      calls++;
      if (fail) throw new Error('https://example.com/private');
      return new Response(calendar(simple));
    },
  });
  await Promise.all([service.snapshot(), service.snapshot()]);
  assert.equal(calls, 1);
  now += CALENDAR_REFRESH_MS - 1;
  await service.snapshot();
  assert.equal(calls, 1);
  now++;
  fail = true;
  const stale = await service.snapshot();
  assert.equal(calls, 2);
  assert.equal(stale.feeds[0].stale, true);
  assert.equal(stale.feeds[0].error, true);
  assert.ok(stale.feeds[0].ics);
  assert.ok(!JSON.stringify(stale).includes('https://example.com/private'));
  await service.snapshot();
  assert.equal(calls, 2);
  now += 86400000;
  assert.equal((await service.snapshot()).feeds[0].ics, undefined);
});

test('manual refresh fetches all five feeds, coalesces clicks, bypasses failure backoff and retains private errors', async () => {
  let now = NOW, calls = 0, fail = false, title = 'Original';
  const feeds = ['dad-personal', 'dad-work', 'mom', 'kiddo', 'family'].map(id => ({
    id, calendar: id.startsWith('dad') ? 'dad' : id, url: 'https://example.com/private-' + id,
  }));
  const service = createCalendarService(feeds, { now: () => now, fetchImpl: async () => {
    calls++; if (fail) throw new Error('Private provider error');
    return new Response(calendar(simple.replace('SUMMARY:Appointment', 'SUMMARY:' + title)));
  } });
  const first = await service.snapshot(); assert.equal(calls, 5);
  now += 60000; title = 'Changed';
  const request = () => new Request('http://localhost/api/calendars', { method: 'POST', headers: { Origin: 'http://localhost' } });
  const [one, two] = await Promise.all([calendarResponse(request(), service), calendarResponse(request(), service)]);
  const refreshed = await one.json(); assert.deepEqual(refreshed, await two.json());
  assert.equal(calls, 10); assert.equal(refreshed.feeds.length, 5);
  assert.ok(refreshed.feeds.every(feed => feed.ics.includes('SUMMARY:Changed')));
  assert.ok(refreshed.feeds.every(feed => feed.fetchedAt > first.feeds[0].fetchedAt));
  assert.ok(!JSON.stringify(refreshed).includes('https://example.com/private-'));
  await service.snapshot(); assert.equal(calls, 10);
  fail = true; const stale = await service.snapshot({ force: true });
  assert.ok(stale.feeds.every(feed => feed.stale && feed.error && feed.ics));
  now += 1000; fail = false; await service.snapshot({ force: true }); assert.equal(calls, 20);
  assert.equal((await calendarResponse(new Request('http://localhost/api/calendars', { method: 'POST', headers: { Origin: 'https://example.com' } }), service)).status, 403);
  assert.equal((await calendarResponse(new Request('http://localhost/api/calendars', { method: 'DELETE' }), service)).status, 405);
  assert.equal(calls, 20);
});

test('manual refresh arriving during a cached calendar read still reaches the feeds', async () => {
  let calls = 0;
  const service = createCalendarService([{ id: 'family', calendar: 'family', url: 'https://example.com/private' }], {
    now: () => NOW, fetchImpl: async () => { calls++; return new Response(calendar(simple)); },
  });
  await service.snapshot();
  await Promise.all([service.snapshot(), service.snapshot({ force: true })]);
  assert.equal(calls, 2);
});

test('browser manual calendar refresh uses POST, prevents duplicate requests, and retains events on failure', async () => {
  let now = NOW, fail = false, hold, release, delay;
  const handlers = {}, methods = [], data = {}, status = [];
  const App = { on: (name, callback) => { handlers[name] = callback; }, emit(name) { if (name === 'calendarstatus') status.push(!!this.calendarStatus.refreshing); } };
  const context = vm.createContext({ App, DATA: data, Date: { now: () => now }, AbortSignal, CALENDAR_REFRESH_MS,
    mergeCalendarFeeds: feeds => mergeCalendarFeeds(feeds, { now }),
    setTimeout: (_callback, wait) => { delay = wait; }, clearTimeout() {}, addEventListener() {},
    fetch: async (_url, options) => {
      methods.push(options.method); if (hold) await hold; if (fail) throw new Error('Offline');
      return { ok: true, json: async () => ({ feeds: [{ id: 'family', calendar: 'family', ics: calendar(simple), fetchedAt: now }] }) };
    },
  }); context.window = context;
  vm.runInContext(readFileSync(new URL('../js/calendars.js', import.meta.url), 'utf8').replace(/^import .*;\n/, ''), context);
  await handlers.ready(); assert.deepEqual(methods, ['GET']);
  now += 60000; hold = new Promise(resolve => { release = resolve; });
  const manual = App.refreshCalendars(); App.refreshCalendars();
  assert.equal(App.calendarStatus.refreshing, true); assert.deepEqual(methods, ['GET', 'POST']);
  release(); await manual; hold = null;
  assert.equal(App.calendarStatus.refreshing, false); assert.equal(delay, CALENDAR_REFRESH_MS);
  const events = data.events; fail = true; await App.refreshCalendars();
  assert.equal(data.events, events); assert.equal(App.calendarStatus.error, true); assert.equal(App.calendarStatus.refreshing, false);
  assert.equal(delay, 60000); assert.ok(status.includes(true));
});
