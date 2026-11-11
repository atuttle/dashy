// Public shared-album protocol reference: eyalgal/album_slideshow/google_scraper.py.
// No account cookies, Google login, or third-party album proxy is used.
export const PHOTO_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const KEY = /^[A-Za-z0-9_-]{1,1024}$/;

export function validateAlbumUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /\s/.test(value)) throw new Error('Invalid album link');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !((url.hostname === 'photos.app.goo.gl' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
      || (url.hostname === 'photos.google.com' && /^\/share\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && KEY.test(url.searchParams.get('key') || '')))) {
    throw new Error('Invalid album link');
  }
  return url.href;
}

export function imageUrl(value) {
  if (typeof value !== 'string') throw new Error('Invalid image URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !/^[a-z0-9-]+\.googleusercontent\.com$/.test(url.hostname)) throw new Error('Invalid image URL');
  url.pathname = url.pathname.replace(/=[wh]\d+(?:-[a-z0-9]+)*$/i, '') + '=w1920-h1920';
  return url.href;
}

export async function boundedBytes(response, limit) {
  if (!response.ok || !response.body) throw new Error('Photo provider unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Photo response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function albumKeys(albumUrl, fetchImpl = fetch) {
  let address = validateAlbumUrl(albumUrl);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetchImpl(address, { redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': PHOTO_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location) throw new Error('Album redirect unavailable');
      address = validateAlbumUrl(new URL(location, address).href);
      continue;
    }
    const html = new TextDecoder().decode(await boundedBytes(response, 8 * 1024 * 1024));
    const match = html.match(/snAcKc[^}]*?request:\s*\[\s*"([A-Za-z0-9_-]+)"\s*,\s*null\s*,\s*null\s*,\s*"([A-Za-z0-9_-]+)"/s);
    if (!match) throw new Error('Shared album unavailable');
    return { album: match[1], auth: match[2] };
  }
  throw new Error('Too many album redirects');
}

function marker(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  if (!Array.isArray(node) && Object.hasOwn(node, key)) return true;
  return Object.values(node).some(value => marker(value, key, depth + 1));
}

export function parseAlbumPage(text) {
  // Responses may include an XSSI prefix and numeric byte-count lines before the JSON.
  let payload;
  for (const line of text.split('\n')) {
    let entries;
    try { entries = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    const entry = entries.find(item => Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === 'snAcKc');
    if (entry && typeof entry[2] === 'string') { payload = JSON.parse(entry[2]); break; }
  }
  if (!Array.isArray(payload) || !Array.isArray(payload[1])
      || !(payload[2] == null || typeof payload[2] === 'string')) throw new Error('Album format changed');
  const photos = [];
  for (const raw of payload[1]) {
    if (marker(raw, '76647426') && !marker(raw, '146008172')) continue; // Keep the still image of motion photos.
    const visual = raw?.[1];
    if (!Array.isArray(raw) || typeof raw[0] !== 'string' || !KEY.test(raw[0]) || !Array.isArray(visual)
      || !Number.isInteger(visual[1]) || !Number.isInteger(visual[2]) || visual[1] <= 0 || visual[2] <= 0) throw new Error('Album item format changed');
    const capturedAt = Number.isInteger(raw[2]) && raw[2] >= -2208988800000 && raw[2] <= 4102444800000 ? raw[2] : null;
    photos.push({ key: raw[0], url: imageUrl(visual[0]), width: visual[1], height: visual[2], capturedAt });
  }
  return { photos, next: payload[2] || null, itemCount: payload[1].length };
}

export async function readAlbum(albumUrl, { fetchImpl = fetch } = {}) {
  const keys = await albumKeys(albumUrl, fetchImpl);
  const photos = new Map(), tokens = new Set();
  let next = null, totalItems = 0;
  do {
    if (tokens.has(next)) throw new Error('Repeated album page');
    tokens.add(next);
    const inner = JSON.stringify([keys.album, next, null, keys.auth]);
    const envelope = JSON.stringify([[['snAcKc', inner, null, 'generic']]]);
    const url = 'https://photos.google.com/u/0/_/PhotosUi/data/batchexecute?rpcids=snAcKc&source-path=' + encodeURIComponent('/share/' + keys.album);
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': PHOTO_UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Origin: 'https://photos.google.com', Referer: 'https://photos.google.com/share/' + keys.album + '?key=' + keys.auth },
      body: new URLSearchParams({ 'f.req': envelope }).toString() });
    const page = parseAlbumPage(new TextDecoder().decode(await boundedBytes(response, 8 * 1024 * 1024)));
    totalItems += page.itemCount;
    if (totalItems > 20000 || tokens.size > 100) throw new Error('Album limit exceeded');
    for (const photo of page.photos) photos.set(photo.key, photo);
    next = page.next;
  } while (next);
  return [...photos.values()];
}

export function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.slice(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i])) return 'image/png';
  const first = new TextDecoder().decode(bytes.slice(0, 12));
  if (first.startsWith('RIFF') && first.slice(8) === 'WEBP') return 'image/webp';
  if (first.startsWith('GIF87a') || first.startsWith('GIF89a')) return 'image/gif';
  throw new Error('Unexpected image format');
}
