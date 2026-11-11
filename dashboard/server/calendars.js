import { CALENDAR_REFRESH_MS, sanitizeCalendar } from '../js/calendar-model.js';

export function createCalendarService(feeds, { fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  let pending, pendingForced = false;
  async function readFeed(feed, force) {
    let saved = cache.get(feed.id);
    const meta = { id: feed.id, name: feed.name, calendar: feed.calendar };
    if (!force && saved && now() - saved.attempt < (saved.error ? 60000 : CALENDAR_REFRESH_MS)) return { ...meta, ...saved.data, error: saved.error, stale: saved.error && !!saved.data.ics };
    try {
      const response = await fetchImpl(feed.url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
      if (!response.ok) throw new Error('Unavailable');
      const text = await response.text();
      if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error('Feed too large');
      const data = { ics: sanitizeCalendar(text, feed.url), fetchedAt: now() };
      saved = { attempt: now(), data, error: false };
    } catch {
      const data = saved?.data && now() - saved.data.fetchedAt < 86400000 ? saved.data : {};
      saved = { attempt: now(), data, error: true };
    }
    cache.set(feed.id, saved);
    return { ...meta, ...saved.data, error: saved.error, stale: saved.error && !!saved.data.ics };
  }
  function snapshot({ force = false } = {}) {
    if (pending && force && !pendingForced) return pending.then(() => snapshot({ force: true }));
    if (!pending) {
      pendingForced = force;
      pending = Promise.all(feeds.map(feed => readFeed(feed, force))).then(results => ({ feeds: results })).finally(() => { pending = null; pendingForced = false; });
    }
    return pending;
  }
  return { snapshot };
}

export async function calendarResponse(request, service) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET' && request.method !== 'POST') return new Response('{}', { status: 405, headers });
  if (request.method === 'POST' && (request.headers.get('Sec-Fetch-Site') === 'cross-site'
      || (request.headers.has('Origin') && request.headers.get('Origin') !== new URL(request.url).origin))) return new Response('{}', { status: 403, headers });
  try { return new Response(JSON.stringify(await service.snapshot({ force: request.method === 'POST' })), { headers }); }
  catch { return new Response('{"error":true}', { status: 503, headers }); }
}
