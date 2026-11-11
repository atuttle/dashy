export const SKYDIVING_LOG_TIME_ZONE = 'America/New_York';
const DAY_MS = 86400000;

function todayParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: SKYDIVING_LOG_TIME_ZONE,
    year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(now))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function sum(records) {
  return records.every(record => count(record.count) !== null) ? records.reduce((total, record) => total + record.count, 0) : null;
}

function dateNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export function logDateLabel(value) {
  const time = dateNumber(value);
  return time === null ? 'Not recorded' : new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(time);
}

export function reserveDaysLeft(value, now = Date.now()) {
  const date = dateNumber(value);
  if (date === null) return null;
  const today = todayParts(now);
  return Math.round((date - Date.UTC(today.year, today.month - 1, today.day)) / DAY_MS);
}

export function lastTwelveMonths(records, now = Date.now()) {
  const today = todayParts(now);
  const counts = new Map((records || []).map(record => [record.month, count(record.count)]));
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(today.year, today.month - 12 + index, 1));
    const month = date.toISOString().slice(0, 7);
    return { month, count: counts.get(month) ?? null };
  });
}

export function jumpSummary(log, now = Date.now()) {
  const year = todayParts(now).year;
  const annual = (log.jumpCountsByYear || []).find(record => record.year === year);
  return { year, total: count(log.totalJumps), thisYear: count(annual?.count), last12Months: sum(lastTwelveMonths(log.jumpCountsByMonth, now)) };
}

// Deliberately fake and self-contained. A future provider can replace DATA.skydivingLog.
export function createPlaceholderSkydivingLog(now = Date.now()) {
  const today = todayParts(now);
  const sampleMonths = [0, 0, 4, 12, 26, 34, 42, 38, 31, 18, 7, 2];
  const jumpCountsByMonth = lastTwelveMonths([], now).map(record => ({
    month: record.month, count: sampleMonths[Number(record.month.slice(5)) - 1],
  }));
  const jumpCountsByYear = [118, 143, 172, 204, 226, 238].map((value, index) => ({ year: today.year - 6 + index, count: value }));
  jumpCountsByYear.push({ year: today.year, count: sampleMonths.slice(0, today.month).reduce((total, value) => total + value, 0) });
  const dateOffset = days => new Date(Date.UTC(today.year, today.month - 1, today.day + days)).toISOString().slice(0, 10);
  return {
    placeholder: true,
    totalJumps: sum(jumpCountsByYear),
    rigs: [
      { name: 'Primary rig', reserveRepackExpiresOn: dateOffset(68) },
      { name: 'Backup rig', reserveRepackExpiresOn: dateOffset(19) },
    ],
    jumpCountsByYear,
    jumpCountsByMonth,
    isInstructor: true,
    instructor: { lastTIJumpOn: dateOffset(-6), lastAFFJumpOn: dateOffset(-22), lastIADJumpOn: dateOffset(-83) },
  };
}
