import SunCalc from 'suncalc';
import { SKYDIVING_LOCATION as LOCATION, SKYDIVING_LIMITS as LIMITS, SKYDIVING_MAX_AGE_MS } from './skydiving-config.js';

const HOUR = 3600000;
const number = value => typeof value === 'number' && Number.isFinite(value);
const goodSkies = new Set(['clear', 'mostly clear', 'partly cloudy']);
const cloudySkies = new Set(['mostly cloudy', 'cloudy', 'overcast']);
const categories = new Set(['VFR', 'MVFR', 'IFR', 'LIFR']);
const unique = values => [...new Set(values)];

export function rateAviation(point) {
  const reasons = [], missing = [], cautions = [];
  const category = point.flightCategory;
  const wind = point.windSpeedMph;
  const spread = number(wind) && number(point.windGustMph) && point.windGustMph >= wind
    ? point.windGustMph - wind : null;
  const baseKnown = point.unlimitedBase === true || number(point.lowestCloudBaseFt);
  const sky = (point.cloudCover || '').toLowerCase();
  const base = point.unlimitedBase ? Infinity : point.lowestCloudBaseFt;

  // LIFR is more restrictive than IFR and cannot qualify as a favorable forecast.
  if (['MVFR', 'IFR', 'LIFR'].includes(category)) reasons.push(category + ' flight category');
  if (number(wind) && wind >= LIMITS.highWindMph) reasons.push('Wind ≥24 mph');
  if (number(spread) && spread > LIMITS.noGoGustSpreadMph) reasons.push('Gust spread >15 mph');
  if (baseKnown && base < LIMITS.noGoCloudBaseFt && cloudySkies.has(sky)) reasons.push('Cloud base <3,000 ft with mostly cloudy skies or worse');

  if (!categories.has(category)) missing.push('flight category');
  if (!number(wind)) missing.push('wind speed');
  if (!number(spread)) missing.push('gust spread');
  if (!baseKnown) missing.push('cloud base');
  if (!goodSkies.has(sky) && !cloudySkies.has(sky)) missing.push('cloud cover');
  if (reasons.length) return { label: 'no-go', reasons, incomplete: !!missing.length };

  if (!goodSkies.has(sky) && !missing.includes('cloud cover')) cautions.push('More than partly cloudy');
  if (number(wind) && wind > LIMITS.lowWindMph) cautions.push('Wind >18 mph');
  if (number(spread) && spread >= LIMITS.likelyGustSpreadMph) cautions.push('Gust spread ≥12 mph');
  if (baseKnown && base < LIMITS.likelyCloudBaseFt) cautions.push('Cloud base <5,000 ft');
  if (missing.length) cautions.push('Missing ' + missing.join(', '));
  return cautions.length ? { label: 'questionable', reasons: cautions, incomplete: !!missing.length }
    : { label: 'likely', reasons: ['All selected limits met'], incomplete: false };
}

export function rateBasic(point) {
  const reasons = [], missing = [], cautions = [];
  if (['rain', 'snow', 'sleet', 'hail'].includes(point.icon)) reasons.push('Rain or snow forecast');
  if (number(point.windSpeedMph) && point.windSpeedMph >= LIMITS.highWindMph) reasons.push('Wind ≥24 mph');
  if (!number(point.windSpeedMph)) missing.push('wind speed');
  if (!number(point.precipProbability)) missing.push('rain probability');
  if (!number(point.cloudCover)) missing.push('cloud cover');
  if (reasons.length) return { label: 'no-go', reasons, incomplete: !!missing.length };
  if (number(point.windSpeedMph) && point.windSpeedMph > LIMITS.lowWindMph) cautions.push('Wind >18 mph');
  if (number(point.precipProbability) && point.precipProbability > LIMITS.fallbackRainProbability) cautions.push('Rain chance >20%');
  if (number(point.cloudCover) && point.cloudCover > LIMITS.fallbackPartlyCloudyMax) cautions.push('More than partly cloudy');
  if (missing.length) cautions.push('Missing ' + missing.join(', '));
  return cautions.length ? { label: 'maybe', reasons: cautions, incomplete: !!missing.length }
    : { label: 'probable', reasons: ['Low rain chance, partly cloudy or better, low wind'], incomplete: false };
}

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: LOCATION.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
export const localDate = value => dateFormat.format(new Date(value));
function addDate(date, days) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function localHour(date, hour) {
  // Noon's offset is also correct at 9 AM on DST transition days in Pennsylvania.
  const noon = Date.parse(date + 'T12:00:00Z');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: LOCATION.timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(noon);
  const p = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - noon;
  return Date.parse(date + 'T00:00:00Z') + hour * HOUR - offset;
}

export function weekendDates(now) {
  const today = localDate(now);
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  // Keep the current weekend through Sunday; roll forward on Monday.
  const saturday = addDate(today, weekday === 0 ? -1 : 6 - weekday);
  return [saturday, addDate(saturday, 1)];
}

function usable(source, now) {
  return source && Array.isArray(source.points) && number(source.fetchedAt) && now - source.fetchedAt < SKYDIVING_MAX_AGE_MS
    && source.fetchedAt <= now + 60000 && !source.stale;
}
function covers(points, start, end, step) {
  if (!points?.length || points[0].time > start || points.at(-1).time + (step === HOUR ? HOUR : 0) < end) return false;
  const nearby = points.filter(p => p.time >= start - step && p.time <= end + step);
  return nearby.every((p, i) => !i || p.time - nearby[i - 1].time <= step + 1000);
}

export function buildWeekendForecast(snapshot, now = Date.now()) {
  const aviation = usable(snapshot?.aviation, now) ? snapshot.aviation : null;
  const basic = usable(snapshot?.basic, now) ? snapshot.basic : null;
  return weekendDates(now).map((date, index) => {
    const noon = new Date(date + 'T12:00:00Z');
    const end = +SunCalc.getTimes(noon, LOCATION.latitude, LOCATION.longitude).sunset;
    const start = localHour(date, LIMITS.startHour);
    const day = { date, name: index ? 'Sunday' : 'Saturday', start, end,
      label: 'unavailable', source: null, reasons: ['Forecast unavailable'], points: [], incomplete: true };
    if (now >= end) return { ...day, label: 'finished', reasons: ['Jumping hours have ended'], incomplete: false };
    // On the current day, rate the remaining jumping hours, not elapsed forecasts.
    const from = Math.max(start, Math.floor(now / HOUR) * HOUR);
    const detailed = (aviation?.points || []).filter(p => p.time >= from && p.time < end)
      .map(p => ({ ...p, source: 'aviation', ...rateAviation(p) }));
    if (detailed.length && covers(aviation.points, from, end, 3 * HOUR)) {
      const label = detailed.some(p => p.label === 'no-go') ? 'no-go'
        : detailed.some(p => p.label === 'questionable') ? 'questionable' : 'likely';
      return { ...day, label, source: 'aviation', issuedAt: aviation.issuedAt, fetchedAt: aviation.fetchedAt,
        points: detailed, reasons: unique(detailed.filter(p => p.label === label).flatMap(p => p.reasons)),
        incomplete: detailed.some(p => p.incomplete), remaining: from > start };
    }
    const fallback = (basic?.points || []).filter(p => p.time + HOUR > from && p.time < end)
      .map(p => ({ ...p, source: 'basic', ...rateBasic(p) }));
    if (fallback.length && covers(basic.points, from, end, HOUR)) {
      // Partial aviation data may downgrade a basic forecast, never silently disappear.
      const bad = [...detailed, ...fallback].filter(p => p.label === 'no-go');
      const uncertain = [...detailed, ...fallback].filter(p => ['questionable', 'maybe'].includes(p.label));
      const label = bad.length ? 'no-go' : uncertain.length ? 'maybe' : 'probable';
      return { ...day, label, source: detailed.length ? 'mixed' : 'basic', fetchedAt: basic.fetchedAt,
        issuedAt: detailed.length ? aviation.issuedAt : null,
        points: [...detailed, ...fallback].sort((a, b) => a.time - b.time),
        reasons: unique((bad.length ? bad : uncertain.length ? uncertain : fallback).flatMap(p => p.reasons)),
        incomplete: [...detailed, ...fallback].some(p => p.incomplete), remaining: from > start };
    }
    // Known bad conditions remain useful even when the complete day isn't covered.
    const bad = detailed.filter(p => p.label === 'no-go');
    if (bad.length) return { ...day, label: 'no-go', source: 'aviation', issuedAt: aviation.issuedAt,
      fetchedAt: aviation.fetchedAt, points: detailed, reasons: unique([...bad.flatMap(p => p.reasons), 'Only part of the day is covered']) };
    return day;
  });
}
