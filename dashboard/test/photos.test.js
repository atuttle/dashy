import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAlbumUrl, imageUrl, parseAlbumPage, readAlbum } from '../server/photo-album.js';
import { createPhotoService, photoResponse, PHOTO_REFRESH_MS } from '../server/photos.js';

const LINK = 'https://photos.google.com/share/album-key?key=secret-key';
const raw = (id = 'photo-one', extra = {}) => [id, ['https://lh3.googleusercontent.com/' + id, 1200, 800], 1600000000000, null, null, 1600000000000, extra];
const page = (items, next = null) => ")]}'\n\n1234\n" + JSON.stringify([['wrb.fr', 'snAcKc', JSON.stringify([null, items, next])]]) + '\n';
const html = '<script>AF_dataServiceRequests={ds:{id:"snAcKc",request:["album-key",null,null,"secret-key"]}};</script>';
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 0, 255, 217]);

function fakeProvider() {
  const state = { items: [raw()], fail: false, images: 0, requests: 0 };
  state.fetch = async (url, options = {}) => {
    state.requests++;
    if (state.fail) throw new Error('provider error ' + LINK);
    if (url.includes('googleusercontent.com')) { state.images++; return new Response(jpeg); }
    if (options.method === 'POST') return new Response(page(state.items));
    return new Response(html);
  };
  return state;
}

test('only valid Google share links and Google image hosts are accepted', () => {
  assert.equal(validateAlbumUrl(LINK), LINK);
  assert.ok(validateAlbumUrl('https://photos.app.goo.gl/short-key'));
  for (const link of ['http://photos.google.com/share/a?key=b', 'https://photos.google.com.evil.test/share/a?key=b',
    'https://user:pass@photos.google.com/share/a?key=b', 'https://photos.google.com/album/private', 'https://127.0.0.1/share/a?key=b']) {
    assert.throws(() => validateAlbumUrl(link));
  }
  assert.equal(imageUrl('https://lh3.googleusercontent.com/photo=w400-h300'), 'https://lh3.googleusercontent.com/photo=w1920-h1920');
  assert.throws(() => imageUrl('https://lh3.googleusercontent.com.evil.test/image'));
  assert.throws(() => imageUrl('https://localhost/image'));
});

test('album parsing handles XSSI/length lines, video exclusion, metadata and continuation', () => {
  const parsed = parseAlbumPage(page([raw(), raw('video', { '76647426': [10000] }),
    raw('motion-photo', { '76647426': [1000], '146008172': [1] })], 'next-token'));
  assert.equal(parsed.photos.length, 2);
  assert.equal(parsed.itemCount, 3);
  assert.equal(parsed.next, 'next-token');
  assert.equal(parsed.photos[0].capturedAt, 1600000000000);
  assert.equal(parsed.photos[0].width, 1200);
  assert.throws(() => parseAlbumPage('<html>Sign in</html>'));
  assert.throws(() => parseAlbumPage(page([['broken-photo']])));
});

test('album reader paginates past the initial HTML page and deduplicates photos', async () => {
  let requests = 0;
  const result = await readAlbum(LINK, { fetchImpl: async (url, options = {}) => {
    if (!options.method) return new Response(html);
    const envelope = JSON.parse(new URLSearchParams(options.body).get('f.req'));
    const payload = JSON.parse(envelope[0][0][1]);
    requests++;
    assert.equal(payload[0], 'album-key');
    assert.equal(payload[3], 'secret-key');
    return new Response(payload[1] === null ? page(Array.from({ length: 300 }, (_, i) => raw('p-' + i)), 'next')
      : page([raw('p-299'), raw('p-300')]));
  } });
  assert.equal(requests, 2);
  assert.equal(result.length, 301);
});

test('redirects outside Google share hosts and repeated continuation tokens fail closed', async () => {
  await assert.rejects(readAlbum('https://photos.app.goo.gl/short', { fetchImpl: async () => new Response('', {
    status: 302, headers: { Location: 'https://evil.test/album' } }) }));
  await assert.rejects(readAlbum(LINK, { fetchImpl: async (url, opts = {}) => new Response(opts.method ? page([raw()], 'repeat') : html) }));
});

test('photos persist privately across service restarts, offline errors preserve them, and URLs never reach UI', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dashy-photos-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const provider = fakeProvider();
  let clock = 1000000000;
  let service = createPhotoService({ albumUrl: LINK, cacheDir, fetchImpl: provider.fetch, now: () => clock });
  await service.sync();
  const saved = await service.snapshot();
  assert.equal(saved.photos.length, 1);
  assert.equal(saved.albumCount, 1);
  assert.equal(saved.photos[0].o, 'l');
  assert.ok(!JSON.stringify(saved).includes('secret-key'));
  assert.ok(!JSON.stringify(saved).includes('googleusercontent.com'));
  assert.ok(!JSON.stringify(saved).includes('photo-one'));
  assert.equal((await service.image(saved.photos[0].id)).mime, 'image/jpeg');
  assert.equal(await service.image('../manifest.json'), null);
  assert.equal(provider.images, 1);
  clock += PHOTO_REFRESH_MS;
  await service.sync();
  assert.equal(provider.images, 1); // unchanged images are not downloaded again
  provider.fail = true;
  service = createPhotoService({ albumUrl: LINK, cacheDir, fetchImpl: provider.fetch, now: () => clock });
  await service.sync();
  const offline = await service.snapshot();
  assert.equal(offline.error, true);
  assert.equal(offline.photos[0].id, saved.photos[0].id);
  assert.equal((await service.image(saved.photos[0].id)).bytes.length, jpeg.length);
  const folders = await readdir(cacheDir);
  const manifest = await readFile(join(cacheDir, folders[0], 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes('secret-key') && !manifest.includes('googleusercontent.com'));
});

test('successful inventories apply removals; confirmed empty albums clear saved photos', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dashy-photos-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const provider = fakeProvider();
  const service = createPhotoService({ albumUrl: LINK, cacheDir, fetchImpl: provider.fetch });
  await service.sync();
  const old = (await service.snapshot()).photos[0].id;
  provider.items = [raw('replacement')];
  await service.sync();
  assert.equal(await service.image(old), null);
  assert.equal((await service.snapshot()).photos.length, 1);
  provider.items = [];
  await service.sync();
  assert.equal((await service.snapshot()).photos.length, 0);
  assert.equal((await service.snapshot()).error, false);
});

test('a failed second page never prunes the last complete cached album', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dashy-photos-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let partial = false;
  const provider = fakeProvider();
  const service = createPhotoService({ albumUrl: LINK, cacheDir, fetchImpl: async (url, options = {}) => {
    if (partial && options.method === 'POST') {
      const call = JSON.parse(JSON.parse(new URLSearchParams(options.body).get('f.req'))[0][0][1]);
      if (call[1]) throw new Error('Second page unavailable');
      return new Response(page([raw('new-photo')], 'page-two'));
    }
    return provider.fetch(url, options);
  } });
  await service.sync();
  const original = (await service.snapshot()).photos[0].id;
  partial = true;
  await service.sync();
  const result = await service.snapshot();
  assert.equal(result.error, true);
  assert.equal(result.photos.length, 1);
  assert.equal(result.photos[0].id, original);
  assert.ok(await service.image(original));
});

test('cache caps and unexpected image bodies are explicit instead of silently succeeding', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dashy-photos-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const provider = fakeProvider(); provider.items = [raw('one'), raw('two')];
  const service = createPhotoService({ albumUrl: LINK, cacheDir, fetchImpl: provider.fetch, maxPhotos: 1 });
  await service.sync();
  const result = await service.snapshot();
  assert.equal(result.capped, true);
  assert.equal(result.albumCount, 2);
  assert.equal(result.photos.length, 1);
  const broken = createPhotoService({ albumUrl: LINK + '-other', cacheDir, fetchImpl: async (url, opts) =>
    url.includes('googleusercontent.com') ? new Response('<html>not an image</html>') : provider.fetch(url, opts) });
  await broken.sync();
  assert.equal((await broken.snapshot()).error, true);
  assert.equal((await broken.snapshot()).photos.length, 0);
});

test('unconfigured routes stay empty and image requests accept only opaque IDs and GET', async () => {
  const service = createPhotoService();
  const response = await photoResponse(new Request('http://localhost/api/photos'), service);
  const value = await response.json();
  assert.equal(value.configured, false);
  assert.equal(value.photos.length, 0);
  assert.equal((await photoResponse(new Request('http://localhost/api/photos/not-an-id'), service)).status, 404);
  assert.equal((await photoResponse(new Request('http://localhost/api/photos', { method: 'POST' }), service)).status, 405);
});
