import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function slideshow(photos) {
  const listeners = {};
  const App = { now: () => new Date('2026-11-11T17:00:00Z'), esc: String,
    photoMessage: () => 'Downloading photos…', person: id => ({ id }),
    on: (name, fn) => { (listeners[name] ||= []).push(fn); },
    fmt: { month: d => String(d.getMonth() + 1) } };
  const context = vm.createContext({ App, DATA: { photos }, document: {},
    setInterval: () => 1, clearInterval() {}, setTimeout() {} });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../js/slideshow.js', import.meta.url), 'utf8'), context);
  return { App, data: context.DATA, emit: name => (listeners[name] || []).forEach(fn => fn()) };
}
const photo = (id, o = 'l') => ({ id, o, src: '/api/photos/' + id, tag: 'google-album', capturedAt: null });

test('all slideshow layouts handle one or two real photos without missing panes', () => {
  for (const photos of [[photo('one')], [photo('one', 'p')], [photo('one'), photo('two', 'p')]]) {
    const { App } = slideshow(photos);
    for (const layout of ['auto', 'cover', 'pair', 'collage', 'polaroid']) {
      const show = new App.Slideshow({}, { layout });
      for (let i = 0; i < 6; i++) {
        const slide = show.pick();
        assert.ok(slide.photos.length > 0);
        assert.ok(slide.photos.every(Boolean));
        if (slide.layout === 'pair') assert.equal(slide.photos.length, 2);
        if (slide.layout === 'collage') assert.equal(slide.photos.length, 3);
      }
    }
  }
});

test('empty albums show a real loading state and start automatically when the first cached photo arrives', () => {
  const { App, data, emit } = slideshow([]);
  const element = { innerHTML: '' };
  const show = new App.Slideshow(element);
  show.render = function (slide) { this.current = slide; };
  show.start();
  assert.equal(show.current, null);
  assert.match(element.innerHTML, /Downloading photos/);
  data.photos = [photo('one')];
  emit('photos');
  assert.equal(show.current.photos[0].id, 'one');
});

test('removed images are cleared from active slides and history while stopped slides stay stopped', () => {
  const { App, data, emit } = slideshow([photo('one'), photo('two')]);
  const show = new App.Slideshow({ innerHTML: '' });
  show.render = function (slide) { this.current = slide; };
  show.start();
  show.history = [{ photos: [photo('deleted')] }];
  data.photos = [photo('replacement')];
  emit('photos');
  assert.equal(show.current.photos[0].id, 'replacement');
  assert.ok(show.history.every(s => s.photos.every(p => p.id !== 'deleted')));
  show.stop();
  data.photos = [];
  emit('photos');
  assert.equal(show.running, false);
  assert.equal(show.timer, null);
});

test('cache URLs replace demo image services and missing metadata never invents a date or place', () => {
  const { App } = slideshow([]);
  const p = photo('one');
  assert.equal(App.photoSrc(p), p.src);
  const meta = App.photoMeta(p);
  assert.equal(meta.date, '');
  assert.equal(meta.place, '');
  assert.equal(meta.onThisDay, false);
});
