import ICAL from 'ical.js';

export const CALENDAR_REFRESH_MS = 15 * 60 * 1000;
const EVENT_FIELDS = new Set(['uid', 'dtstart', 'dtend', 'duration', 'rrule', 'rdate', 'exdate', 'recurrence-id', 'status', 'summary', 'location', 'description', 'sequence', 'last-modified']);

// Remove feed/source URLs, attendee addresses, alarms, and unused properties before sending to UI.
export function sanitizeCalendar(text, secretUrl = '') {
  const parsed = new ICAL.Component(ICAL.parse(text));
  if (parsed.name !== 'vcalendar') throw new Error('Invalid calendar');
  const safe = new ICAL.Component('vcalendar');
  safe.addPropertyWithValue('version', '2.0');
  for (const zone of parsed.getAllSubcomponents('vtimezone')) safe.addSubcomponent(zone);
  for (const component of parsed.getAllSubcomponents('vevent')) {
    const event = new ICAL.Component('vevent');
    // addProperty reparents/removes from the source array; iterate a copy to retain every field.
    for (const property of component.getAllProperties().slice()) {
      if (EVENT_FIELDS.has(property.name)) event.addProperty(property);
    }
    safe.addSubcomponent(event);
  }
  return secretUrl ? safe.toString().split(secretUrl).join('[redacted]') : safe.toString();
}

export function parseCalendarFeed(feed, { now = Date.now(), beforeDays = 45, afterDays = 90 } = {}) {
  const root = new ICAL.Component(ICAL.parse(feed.ics));
  for (const component of root.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(component.getFirstPropertyValue('tzid'), new ICAL.Timezone(component));
  }
  const start = now - beforeDays * 86_400_000;
  const end = now + afterDays * 86_400_000;
  const components = root.getAllSubcomponents('vevent');
  const exceptions = new Map();
  for (const component of components) {
    if (component.hasProperty('recurrence-id')) {
      const uid = component.getFirstPropertyValue('uid');
      if (!exceptions.has(uid)) exceptions.set(uid, []);
      exceptions.get(uid).push(component);
    }
  }
  const events = [];
  function add(item, begin, finish, occurrence) {
    if (String(item.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    const from = begin.toJSDate(), until = finish.toJSDate();
    if (+from >= end || +until < start) return;
    const key = `${feed.calendar}|${item.uid}|${occurrence || begin.toString()}`;
    events.push({ id: 'ical-' + encodeURIComponent(key), key, uid: item.uid, feedId: feed.id,
      calendar: feed.calendar, people: feed.calendar === 'family' ? [] : [feed.calendar],
      title: item.summary || '(Untitled)', start: from, end: until, allDay: begin.isDate,
      loc: item.location || '', notes: item.description || '',
      sequence: item.sequence || 0, readonly: true });
  }
  for (const component of components) {
    if (component.hasProperty('recurrence-id')) continue;
    const event = new ICAL.Event(component, { exceptions: exceptions.get(component.getFirstPropertyValue('uid')) || [] });
    if (!event.startDate) continue;
    if (!event.isRecurring()) { add(event, event.startDate, event.endDate); continue; }
    const iterator = event.iterator();
    let occurrence, iterations = 0;
    while ((occurrence = iterator.next())) {
      if (++iterations > 100000) throw new Error('Recurrence expansion limit reached');
      if (+occurrence.toJSDate() >= end) break;
      const details = event.getOccurrenceDetails(occurrence);
      add(details.item, details.startDate, details.endDate, occurrence.toString());
    }
  }
  return events;
}

export function mergeCalendarFeeds(feeds, options) {
  const unique = new Map();
  const statuses = [];
  for (const feed of feeds) {
    try {
      if (!feed.ics) throw new Error('Feed unavailable');
      const events = parseCalendarFeed(feed, options);
      for (const event of events) {
        if (!unique.has(event.key) || unique.get(event.key).sequence < event.sequence) unique.set(event.key, event);
      }
      statuses.push({ id: feed.id, calendar: feed.calendar, error: !!feed.error, stale: !!feed.stale, count: events.length });
    } catch {
      statuses.push({ id: feed.id, calendar: feed.calendar, error: true, stale: false, count: 0 });
    }
  }
  return { events: [...unique.values()].sort((a, b) => a.start - b.start), feeds: statuses };
}
