import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readAlbum, boundedBytes, imageType, PHOTO_UA, validateAlbumUrl } from './photo-album.js';

export const PHOTO_REFRESH_MS = 60 * 60 * 1000;
const ID = /^[a-f0-9]{64}$/;
const hash = text => createHash('sha256').update(text).digest('hex');

export function createPhotoService({ albumUrl, cacheDir, fetchImpl = fetch, now = Date.now,
  maxPhotos = 1000, maxBytes = 512 * 1024 * 1024 } = {}) {
  let manifest = { version: 1, photos: [], albumCount: 0, syncedAt: null, capped: false };
  let pending = null, nextAt = 0, error = false, initialized = false;
  const configured = !!albumUrl;
  const folder = configured ? join(cacheDir, hash(albumUrl)) : null;
  const filename = id => join(folder, id + '.img');
  let initialization;
  async function init() {
    if (!initialization) initialization = (async () => {
      if (!configured) return;
      validateAlbumUrl(albumUrl);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(cacheDir, 0o700); await chmod(folder, 0o700);
      try {
        const saved = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
        if (saved.version === 1 && Array.isArray(saved.photos)) {
          saved.photos = (await Promise.all(saved.photos.filter(p => ID.test(p.id) && ID.test(p.version)
            && Number.isInteger(p.bytes) && p.bytes > 0 && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(p.mime)).map(async p => {
            try { return (await stat(filename(p.id))).size === p.bytes ? p : null; } catch { return null; }
          }))).filter(Boolean);
          manifest = saved;
        }
      } catch { /* A missing/corrupt manifest can be rebuilt from the source. */ }
      initialized = true;
    })();
    return initialization;
  }
  async function atomic(path, bytes) {
    const temp = path + '.' + randomBytes(6).toString('hex') + '.partial';
    try { await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async function save() { await atomic(join(folder, 'manifest.json'), JSON.stringify(manifest)); }

  async function synchronize() {
    await init();
    if (!configured) return;
    try {
      // Never prune based on a partial or failed album listing.
      const inventory = await readAlbum(albumUrl, { fetchImpl });
      inventory.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
      const selected = inventory.slice(0, maxPhotos).map(p => ({ ...p, id: hash(p.key), fingerprint: hash(p.url) }));
      const wanted = new Set(selected.map(p => p.id));
      manifest.photos = manifest.photos.filter(p => wanted.has(p.id));
      manifest.albumCount = inventory.length;
      manifest.capped = inventory.length > maxPhotos;
      await save();
      // Remove excluded photos and abandoned writes before growing the cache.
      for (const name of await readdir(folder)) {
        if ((/^[a-f0-9]{64}\.img$/.test(name) && !wanted.has(name.slice(0, -4))) || name.endsWith('.partial')) await unlink(join(folder, name));
      }
      let used = manifest.photos.reduce((sum, p) => sum + p.bytes, 0), failed = false;
      for (const photo of selected) {
        const old = manifest.photos.find(p => p.id === photo.id);
        if (old?.fingerprint === photo.fingerprint) continue;
        if (used >= maxBytes) { manifest.capped = true; break; }
        try {
          const response = await fetchImpl(photo.url, { redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'User-Agent': PHOTO_UA, Accept: 'image/jpeg,image/png,image/webp,image/gif' } });
          const bytes = await boundedBytes(response, 10 * 1024 * 1024);
          const mime = imageType(bytes);
          const total = used - (old?.bytes || 0) + bytes.byteLength;
          if (total > maxBytes) { manifest.capped = true; break; }
          await atomic(filename(photo.id), bytes);
          const item = { id: photo.id, fingerprint: photo.fingerprint, version: hash(bytes), mime, bytes: bytes.byteLength,
            width: photo.width, height: photo.height, capturedAt: photo.capturedAt };
          manifest.photos = manifest.photos.filter(p => p.id !== photo.id).concat(item);
          used = total;
          await save(); // First downloaded photo is immediately available while the rest sync.
        } catch { failed = true; }
      }
      if (!failed) manifest.syncedAt = now();
      await save();
      error = failed;
      nextAt = now() + (failed ? 5 * 60000 : PHOTO_REFRESH_MS);
    } catch {
      error = true;
      nextAt = now() + 5 * 60000;
    }
  }
  function start() {
    if (!configured) return Promise.resolve();
    if (!pending) pending = synchronize().finally(() => { pending = null; });
    return pending;
  }
  return {
    sync: start,
    async snapshot() {
      await init();
      if (configured && !pending && now() >= nextAt) start().catch(() => {});
      return { configured, syncing: !!pending, error, syncedAt: manifest.syncedAt,
        albumCount: manifest.albumCount, capped: manifest.capped,
        photos: manifest.photos.map(p => ({ id: p.id, src: '/api/photos/' + p.id + '?v=' + p.version.slice(0, 16),
          o: p.height > p.width ? 'p' : 'l', capturedAt: p.capturedAt, tag: 'google-album', place: '' })) };
    },
    async image(id) {
      await init();
      const photo = initialized && ID.test(id) && manifest.photos.find(p => p.id === id);
      if (!photo) return null;
      try { return { bytes: await readFile(filename(id)), mime: photo.mime }; } catch { return null; }
    },
  };
}

export async function photoResponse(request, service) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  const path = new URL(request.url).pathname;
  try {
    if (path === '/api/photos') return Response.json(await service.snapshot(), { headers });
    const match = path.match(/^\/api\/photos\/([a-f0-9]{64})$/);
    const photo = match ? await service.image(match[1]) : null;
    if (!photo) return new Response('', { status: 404, headers });
    return new Response(photo.bytes, { headers: { ...headers, 'Content-Type': photo.mime, 'Cache-Control': 'private, max-age=3600' } });
  } catch { return Response.json({ error: 'Photos unavailable' }, { status: 503, headers }); }
}
