import { parseCalendarFeed } from './calendar-model.js';

export const COUNTDOWN_TIME_ZONE = 'America/New_York';
export const COUNTDOWN_RETRY_MS = 5 * 60 * 1000;
const DAY = 86400000;
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: COUNTDOWN_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function parts(time) {
  return Object.fromEntries(formatter.formatToParts(new Date(time)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

function easternTime(year, month, day, hour = 0) {
  const target = Date.UTC(year, month - 1, day, hour);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(result);
    result = target - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - result);
  }
  return result;
}

export function countdownSchedule(now = Date.now()) {
  const p = parts(now), slots = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    for (const hour of [6, 12, 17]) slots.push(easternTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour));
  }
  return { lastRefreshAt: Math.max(...slots.filter(time => time <= now)), nextRefreshAt: Math.min(...slots.filter(time => time > now)) };
}

export function expandCountdowns(ics, now = Date.now()) {
  return parseCalendarFeed({ ics, id: 'countdowns', calendar: 'family' }, { now, beforeDays: 1, afterDays: 400 });
}

function eventParts(event, edge) {
  const date = event[edge];
  // iCal DATE values are floating dates, converted to the browser's local midnight.
  // Read those date components directly; applying an Eastern offset would shift them.
  return event.allDay ? { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() } : parts(+date);
}
function dayNumber(p) { return Date.UTC(p.year, p.month - 1, p.day) / DAY; }

export function countdownTheme(title) {
  const text = String(title).toLowerCase().replace(/[’‘]/g, "'");
  if (/\bbirthdays?\b|\bb-?day\b|🎂/.test(text)) return { tone: 'birthday' };
  if (/thanksgiving|🦃/.test(text)) return { tone: 'autumn' };
  if (/halloween|🎃/.test(text)) return { tone: 'halloween' };
  if (/christmas|xmas|🎄/.test(text)) return { tone: 'christmas' };
  if (/new[\s-]*year|\bnye\b|🎆|🎇/.test(text)) return { tone: 'newyear' };
  if (/valentine|💘|💝/.test(text)) return { tone: 'valentine' };
  if (/easter|🐰|🐣/.test(text)) return { tone: 'easter' };
  if (/independence\s+day|july\s*4(?:th)?|4th\s+of\s+july|🇺🇸/.test(text)) return { tone: 'independence' };
  if (/\b(?:st\.?|saint)\s*patrick(?:'s|s'?)?(?:\s+day)?\b|☘|🍀/.test(text)) return { tone: 'stpatrick' };
  if (/\bmother(?:'s|s'?)?\s+day\b/.test(text)) return { tone: 'mothers' };
  if (/\bfather(?:'s|s'?)?\s+day\b/.test(text)) return { tone: 'fathers' };
  if (/\bmemorial\s+day\b/.test(text)) return { tone: 'memorial' };
  if (/\bveteran(?:'s|s'?)?\s+day\b/.test(text)) return { tone: 'veterans' };
  if (/\blabou?r\s+day\b/.test(text)) return { tone: 'labor' };
  if (/\bwedding\b|\bmarriage\b|💍/.test(text)) return { tone: 'wedding' };
  if (/anniver(?:sary|ary)|❤️/.test(text)) return { tone: 'anniversary' };
  if (/hanukkah|chanukah|kwanzaa|🎁/.test(text)) return { tone: 'green' };
  if (/vacation|holiday trip|travel|flight|cruise|beach|disney|trip|✈|🏖/.test(text)) return { tone: 'green' };
  if (/concert|festival|show|🎵|🎶/.test(text)) return { tone: 'purple' };
  if (/holiday|🎉/.test(text)) return { tone: 'purple' };
  if (/jump|skydive|skydiving|boogie/.test(text)) return { tone: 'green' };
  return { tone: 'ink' };
}

export function countdownItems(events, now = Date.now()) {
  const today = dayNumber(parts(now));
  const upcoming = events.filter(event => {
    if (!event.allDay) return +event.end > now || +event.start >= now;
    return dayNumber(eventParts(event, 'end')) > today;
  }).sort((a, b) => {
    const date = e => e.allDay ? easternTime(...['year', 'month', 'day'].map(key => eventParts(e, 'start')[key])) : +e.start;
    return date(a) - date(b) || a.title.localeCompare(b.title);
  });
  const unique = new Map();
  for (const event of upcoming) {
    if (unique.has(event.uid || event.id)) continue;
    const p = eventParts(event, 'start'), days = Math.max(0, dayNumber(p) - today);
    const started = event.allDay ? dayNumber(p) < today : +event.start <= now;
    let amount, unit, lead = 'until';
    if (started) { amount = 'Now'; unit = ''; lead = 'happening'; }
    else if (event.allDay && days === 0) { amount = 'Today'; unit = ''; lead = ''; }
    else if (!event.allDay && +event.start - now < DAY) {
      const hours = (+event.start - now) / 3600000;
      amount = hours < 1 ? '<1' : Math.floor(hours); unit = Number(amount) === 1 || amount === '<1' ? 'hour' : 'hours';
    } else if (days <= 14) { amount = days; unit = days === 1 ? 'day' : 'days'; }
    else if (days <= 8 * 7) { amount = Math.floor(days / 7); unit = 'weeks'; }
    else { amount = Math.max(2, Math.round(days / 30.4375)); unit = 'months'; }
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
    unique.set(event.uid || event.id, { ...event, amount, unit, lead, days, ...countdownTheme(event.title),
      dateLabel: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date) });
  }
  return [...unique.values()];
}

export function nextCountdown(events, now = Date.now()) {
  const today = dayNumber(parts(now));
  const upcoming = events.filter(event => event.allDay ? dayNumber(eventParts(event, 'start')) >= today : +event.start > now);
  return countdownItems(upcoming, now)[0] || null;
}
