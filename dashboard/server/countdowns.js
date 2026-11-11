import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeCalendar } from '../js/calendar-model.js';
import { countdownSchedule, COUNTDOWN_RETRY_MS } from '../js/countdown-model.js';

const MAX_BYTES = 4 * 1024 * 1024;

export function createCountdownService({ url, cacheDir, fetchImpl = fetch, now = Date.now } = {}) {
  let saved, loaded = false, pending, pendingForced = false, error = false, attemptedAt;
  const cacheFile = url && cacheDir ? join(cacheDir, createHash('sha256').update(url).digest('hex') + '.json') : null;
  async function load() {
    if (loaded) return;
    loaded = true;
    if (!cacheFile) return;
    try {
      if ((await stat(cacheFile)).size > MAX_BYTES + 1024 * 1024) return;
      const data = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (Number.isFinite(data.fetchedAt) && data.fetchedAt > 0 && data.fetchedAt <= now() && typeof data.ics === 'string') {
        saved = { ics: sanitizeCalendar(data.ics, url), fetchedAt: data.fetchedAt };
      }
    } catch { /* First run or interrupted/invalid cache: fetch normally. */ }
  }
  async function refresh(force) {
    await load();
    const schedule = countdownSchedule(now());
    const retryAt = attemptedAt == null ? 0 : Math.min(attemptedAt + COUNTDOWN_RETRY_MS, countdownSchedule(attemptedAt).nextRefreshAt);
    const due = !saved || saved.fetchedAt < schedule.lastRefreshAt;
    if (force || (due && (!error || now() >= retryAt))) {
      attemptedAt = now();
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) throw new Error('Calendar unavailable');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BYTES) throw new Error('Calendar unavailable');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        saved = { ics: sanitizeCalendar(new TextDecoder().decode(bytes), url), fetchedAt: now() };
        error = false;
        if (cacheFile) {
          try {
            await mkdir(cacheDir, { recursive: true, mode: 0o700 });
            await chmod(cacheDir, 0o700);
            await writeFile(cacheFile + '.tmp', JSON.stringify(saved), { mode: 0o600 });
            await rename(cacheFile + '.tmp', cacheFile);
          } catch { /* Keep the successful in-memory result if disk writes fail. */ }
        }
      } catch { error = true; }
    }
    return { configured: true, error, stale: error && !!saved,
      ...(saved || {}), nextRefreshAt: error ? Math.min(attemptedAt + COUNTDOWN_RETRY_MS, countdownSchedule(attemptedAt).nextRefreshAt) : countdownSchedule(now()).nextRefreshAt };
  }
  function snapshot({ force = false } = {}) {
    if (!url) return Promise.resolve({ configured: false, error: false, nextRefreshAt: countdownSchedule(now()).nextRefreshAt });
    // An explicit refresh must still fetch if it arrives during a cached GET.
    if (pending && force && !pendingForced) return pending.then(() => snapshot({ force: true }));
    if (!pending) {
      pendingForced = force;
      pending = refresh(force).finally(() => { pending = null; pendingForced = false; });
    }
    return pending;
  }
  return { snapshot };
}

export async function countdownResponse(request, service) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET' && request.method !== 'POST') return new Response('{}', { status: 405, headers });
  if (request.method === 'POST' && (request.headers.get('Sec-Fetch-Site') === 'cross-site'
      || (request.headers.has('Origin') && request.headers.get('Origin') !== new URL(request.url).origin))) return new Response('{}', { status: 403, headers });
  try { return new Response(JSON.stringify(await service.snapshot({ force: request.method === 'POST' })), { headers }); }
  catch { return new Response('{"error":true}', { status: 503, headers }); }
}
