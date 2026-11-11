const App = window.App;
window.DATA.photos = [];
App.photoStatus = { loading: true, configured: false, syncing: false, error: false };
let pending = false, timer;
let favourites = new Set();
try { favourites = new Set(JSON.parse(localStorage.getItem('dashy.photo-favourites') || '[]')); } catch { /* Optional. */ }

App.photoMessage = function () {
  const status = App.photoStatus;
  if (status.loading) return 'Loading photos…';
  if (status.error) return window.DATA.photos.length ? 'Sync unavailable · showing saved photos' : 'Photos unavailable · trying again';
  if (!status.configured) return 'Add a Google Photos album';
  if (status.syncing) return window.DATA.photos.length ? 'Syncing photos…' : 'Downloading photos…';
  if (!window.DATA.photos.length) return 'No photos in this album';
  return status.capped ? window.DATA.photos.length + ' of ' + status.albumCount + ' photos saved' : '';
};
App.setPhotoFavourite = function (photo, on) {
  photo.fav = on;
  window.DATA.photos.forEach(p => { if (p.id === photo.id) p.fav = on; });
  if (on) favourites.add(photo.id); else favourites.delete(photo.id);
  try { localStorage.setItem('dashy.photo-favourites', JSON.stringify([...favourites])); } catch { /* Optional. */ }
};

async function refresh() {
  if (pending) return;
  pending = true;
  let delay = 60000;
  try {
    const response = await fetch('/api/photos', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Unavailable');
    const result = await response.json();
    if (!Array.isArray(result.photos) || typeof result.configured !== 'boolean') throw new Error('Invalid photos');
    const photos = result.photos.map(p => {
      if (!/^[a-f0-9]{64}$/.test(p.id) || !new RegExp('^/api/photos/' + p.id + '\\?v=[a-f0-9]{16}$').test(p.src)
        || !['l', 'p'].includes(p.o)) throw new Error('Invalid photo');
      return { ...p, fav: favourites.has(p.id) };
    });
    window.DATA.photos = photos;
    App.photoStatus = { ...result, photos: undefined, loading: false };
    if (result.syncing) delay = 5000;
  } catch {
    App.photoStatus = { ...App.photoStatus, loading: false, error: true };
  } finally {
    pending = false;
    App.emit('photos');
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  }
}
App.on('ready', refresh);
window.addEventListener('online', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
