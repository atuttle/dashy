import { CALENDAR_REFRESH_MS, mergeCalendarFeeds } from './calendar-model.js';

const App = window.App;
window.DATA.events = [];
App.calendarStatus = { loading: true, feeds: [] };
let pending = false;
let timer;
async function refresh(force = false) {
  if (pending) return;
  pending = true;
  App.calendarStatus = { ...App.calendarStatus, refreshing: true };
  App.emit('calendarstatus');
  let delay = CALENDAR_REFRESH_MS;
  try {
    const response = await fetch('/api/calendars', { method: force ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Unavailable');
    const result = await response.json();
    if (!Array.isArray(result.feeds) || !result.feeds.length) throw new Error('Unconfigured');
    const merged = mergeCalendarFeeds(result.feeds);
    window.DATA.events = merged.events;
    App.calendarStatus = { loading: false, feeds: merged.feeds };
    if (merged.feeds.some(feed => feed.error)) delay = 60000;
    else delay = Math.max(1000, Math.min(...result.feeds.map(feed => feed.fetchedAt)) + CALENDAR_REFRESH_MS - Date.now());
  } catch {
    App.calendarStatus = { loading: false, error: true, feeds: App.calendarStatus.feeds };
    delay = 60000;
  } finally {
    pending = false;
    App.calendarStatus.refreshing = false;
    App.emit('calendarstatus');
    App.emit('data');
    App.emit('calendars');
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  }
}

App.calendarMessage = function (owner) {
  const status = App.calendarStatus;
  if (status.loading) return 'Loading calendars…';
  const feeds = status.feeds.filter(feed => !owner || feed.calendar === owner);
  if (status.error || !feeds.length || feeds.some(feed => feed.error)) return 'Calendar feed unavailable';
  return '';
};
App.refreshCalendars = function () { return refresh(true); };
App.on('ready', function () { return refresh(); });
window.addEventListener('online', function () { refresh(); });
