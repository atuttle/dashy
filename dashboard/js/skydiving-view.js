import { SKYDIVING_LOCATION as LOCATION } from './skydiving-config.js';

const App = window.App;
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: LOCATION.timezone, month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: LOCATION.timezone, hour: 'numeric', minute: '2-digit' });
const sourceName = source => ({ aviation: 'USAirNet', basic: 'Basic forecast', mixed: 'Aviation + basic' }[source] || 'Awaiting forecast');
const value = (number, suffix = '') => Number.isFinite(number) ? App.esc(Math.round(number).toLocaleString()) + suffix : '—';
const time = timestamp => timeFormat.format(new Date(timestamp));
const ordinal = new Intl.PluralRules('en-US', { type: 'ordinal' });
const dayNumber = date => {
  const day = Number(date.slice(-2));
  return day + ({ one: 'st', two: 'nd', few: 'rd', other: 'th' }[ordinal.select(day)]);
};

function dayBands(day) {
  // One band per actual forecast time. Mixed sources can share a timestamp;
  // keep its most restrictive result rather than adding a duplicate band.
  const rank = { good: 0, caution: 1, unknown: 2, bad: 3 };
  const bands = new Map();
  for (const point of day.points) {
    const tone = point.label === 'no-go' ? 'bad' : point.incomplete ? 'unknown'
      : ['likely', 'probable'].includes(point.label) ? 'good'
      : ['questionable', 'maybe'].includes(point.label) ? 'caution' : 'unknown';
    if (!bands.has(point.time) || rank[tone] > rank[bands.get(point.time)]) bands.set(point.time, tone);
  }
  const tones = [...bands].sort((a, b) => a[0] - b[0]).map(([, tone]) => tone);
  if (!tones.length) tones.push('unknown');
  return '<span class="jump-bands" aria-hidden="true" style="grid-template-rows:repeat(' + tones.length + ',minmax(0,1fr))">' +
    tones.map(tone => '<span class="jump-band jump-band--' + tone + '"></span>').join('') + '</span>';
}

export function skydivingPod() {
  const days = App.skydivingDays();
  return '<div class="jump-head"><span class="label">Skydiving</span><span>' + LOCATION.station + '</span></div>' +
    '<div class="jump-days">' +
    days.map(day => {
      const label = App.skydivingStatus === 'loading' && day.label === 'unavailable' ? 'loading' : day.label;
      return '<button class="jump-day" data-jump="' + day.date + '" aria-label="' + day.name + ': ' + label + '">' +
        '<span class="jump-date"><b>' + day.name.slice(0, 3) + '</b><span>' + dayNumber(day.date) + '</span></span>' +
        dayBands(day) +
        '<strong class="jump-rating jump-rating--' + label + '">' + label + '</strong></button>';
    }).join('') + '</div>';
}

export function skydivingSheet(date) {
  const day = App.skydivingDays().find(day => day.date === date);
  if (!day) return;
  const rows = day.points.map(point => {
    const spread = Number.isFinite(point.windGustMph) && Number.isFinite(point.windSpeedMph)
      && point.windGustMph >= point.windSpeedMph ? point.windGustMph - point.windSpeedMph : null;
    const details = point.source === 'aviation'
      ? App.esc(point.flightCategory || 'Unknown category') + ' · ' + App.esc(point.cloudCover || 'Unknown cloud cover') +
        ' · Base ' + (point.unlimitedBase ? 'unlimited' : value(point.lowestCloudBaseFt, ' ft')) +
        ' · Wind ' + value(point.windSpeedMph, ' mph') + ' · Gusts ' + value(point.windGustMph, ' mph') + ' · Spread ' + value(spread, ' mph')
      : 'Rain chance ' + value(point.precipProbability === null ? null : point.precipProbability * 100, '%') +
        ' · Clouds ' + value(point.cloudCover === null ? null : point.cloudCover * 100, '%') + ' · Wind ' + value(point.windSpeedMph, ' mph');
    return '<li><div class="jump-point-head"><b>' + time(point.time) + '</b><span>' + (point.source === 'aviation' ? 'USAirNet' : 'Pirate Weather') + '</span>' +
      '<strong class="jump-rating jump-rating--' + point.label + '">' + point.label + '</strong></div>' +
      '<p>' + details + '</p><small>' + App.esc(point.reasons.join(' · ')) + '</small></li>';
  }).join('');
  App.sheet('<div class="sheet-pad jump-details"><div class="label">Skydiving · KMDT / Harrisburg</div>' +
    '<h2 class="serif sheet-h">' + day.name + ', ' + dateFormat.format(new Date(day.date + 'T12:00:00Z')) + '</h2>' +
    '<div class="jump-detail-rating"><strong class="jump-rating jump-rating--' + day.label + '">' + day.label + '</strong><span>' + sourceName(day.source) + '</span></div>' +
    '<p>' + (day.remaining ? 'Remaining jumping hours until ' : '9 AM–') + time(day.end) + ' sunset · Eastern time</p>' +
    '<p>' + App.esc(day.reasons.join(' · ')) + '</p>' +
    (day.incomplete ? '<p>Some required data or part of the day is unavailable.</p>' : '') +
    (day.points.length ? '<p>The day’s label uses the worst forecast point during the jumping window. It describes your selected weather limits.</p><ul class="jump-points">' + rows + '</ul>' : '') +
    (day.issuedAt ? '<p class="jump-meta">Aviation issued ' + dateFormat.format(new Date(day.issuedAt)) + ' at ' + time(day.issuedAt) + '.</p>' : '') +
    (day.fetchedAt ? '<p class="jump-meta">Fetched ' + dateFormat.format(new Date(day.fetchedAt)) + ' at ' + time(day.fetchedAt) + '.</p>' : '') +
    '<p class="jump-meta">USAirNet supplies the aviation forecast. Pirate Weather supplies the longer-range basic forecast; basic ratings cannot be “likely.”</p>' +
    '<a href="' + App.esc(LOCATION.url) + '" target="_blank" rel="noopener noreferrer">View USAirNet forecast</a></div>');
}
