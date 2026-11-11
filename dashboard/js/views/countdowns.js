import { countdownItems } from '../countdown-model.js';
import { countdownBanner } from '../countdown-view.js';

const App = window.App;
let element;

function syncLabel(state) {
  if (state.loading) return 'Loading countdowns…';
  if (state.refreshing) return 'Refreshing…';
  if (!state.configured) return 'Countdown calendar not configured';
  if (state.error) return state.fetchedAt ? 'Calendar unavailable · showing saved dates' : 'Countdown calendar unavailable';
  return '';
}

function updatedLabel(fetchedAt) {
  if (!fetchedAt) return '';
  const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return 'Updated ' + minutes + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'Updated ' + hours + ' hr ago';
  const days = Math.floor(hours / 24);
  return 'Updated ' + days + (days === 1 ? ' day ago' : ' days ago');
}

function render() {
  if (!element) return;
  const state = App.countdownState, events = countdownItems(state.events, +App.now());
  const status = syncLabel(state);
  const updated = updatedLabel(state.fetchedAt);
  const scroll = element.querySelector('.cd-grid')?.scrollTop || 0;
  element.innerHTML = '<div class="countdowns"><header class="cd-header"><h1 class="serif">Countdowns</h1>' +
    '<div class="cd-sync' + (state.error && !state.refreshing ? ' cd-sync--error' : '') + '"><div class="cd-sync-text" aria-live="polite">' +
    (status ? '<span>' + App.esc(status) + '</span>' : '') + (updated ? '<span class="label">' + App.esc(updated) + '</span>' : '') + '</div>' +
    '<button class="icon-btn" data-countdown-refresh aria-label="Refresh countdowns" aria-busy="' + !!state.refreshing + '"' +
    (state.refreshing ? ' disabled' : '') + '>' + App.icon('undo', 26) + '</button></div></header>' +
    '<div class="cd-grid">' + (events.length ? events.map(event => countdownBanner(event)).join('') : '<div class="cd-empty serif">' +
      App.esc(state.loading || state.error || !state.configured ? syncLabel(state) : 'No countdowns yet. Add an event to your countdown calendar.') + '</div>') + '</div></div>';
  element.querySelector('.cd-grid').scrollTop = scroll;
}

App.register('countdowns', { minutely: true, show(el) {
  if (element !== el) {
    element = el;
    element.addEventListener('click', function (event) {
      const button = event.target.closest('[data-countdown-refresh]');
      if (button && !button.disabled) App.refreshCountdowns();
    });
  }
  render();
} });
App.on('countdowns', function () { if (App.current === 'countdowns') render(); });
App.on('minute', function () { if (App.current === 'countdowns') render(); });
