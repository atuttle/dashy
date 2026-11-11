import { createPlaceholderSkydivingLog, jumpSummary, lastTwelveMonths, logDateLabel, reserveDaysLeft } from '../skydiving-log-model.js';

const App = window.App;
window.DATA.skydivingLog = window.DATA.skydivingLog || createPlaceholderSkydivingLog();
let element;

function number(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—'; }

function metric(value, label, accent = '') {
  return '<div class="sd-metric' + (accent ? ' sd-metric--' + accent : '') + '"><strong class="num">' + number(value) + '</strong><span class="label">' + App.esc(label) + '</span></div>';
}

function rigCard(rig, now) {
  const days = reserveDaysLeft(rig.reserveRepackExpiresOn, now);
  const label = days === null ? 'Expiration not recorded' : days < 0 ? 'Expired ' + Math.abs(days) + (days === -1 ? ' day ago' : ' days ago')
    : days === 0 ? 'Expires today' : days + (days === 1 ? ' day left' : ' days left');
  const tone = days !== null && days < 0 ? 'expired' : days !== null && days <= 30 ? 'soon' : '';
  return '<article class="sd-rig"><h3>' + App.esc(rig.name) + '</h3><span class="sd-caption">Reserve repack expires</span>' +
    '<b class="sd-rig-date">' + logDateLabel(rig.reserveRepackExpiresOn) + '</b><span class="sd-repack' + (tone ? ' sd-repack--' + tone : '') + '">' + App.esc(label) + '</span></article>';
}

function instructorPanel(data) {
  if (!data.isInstructor) return '';
  const instructor = data.instructor || {};
  return '<section class="sd-panel"><header class="sd-panel-head"><h2>Instruction</h2><span class="sd-caption">Last instructor jumps</span></header><div class="sd-instructor">' +
    [['TI', 'lastTIJumpOn'], ['AFF', 'lastAFFJumpOn'], ['IAD', 'lastIADJumpOn']].map(([label, field]) =>
      '<div><b class="num">' + label + '</b><span>' + logDateLabel(instructor[field]) + '</span></div>').join('') + '</div></section>';
}

function monthLabel(month) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(new Date(month + '-01T12:00:00Z'));
}

function chart(records, monthly) {
  if (!records.length) return '<div class="sd-empty">No jump counts recorded.</div>';
  const max = Math.max(1, ...records.map(record => record.count || 0));
  const width = records.length * 48;
  const description = records.map(record => (monthly ? record.month : record.year) + ': ' + number(record.count)).join('; ');
  return '<svg class="sd-chart" role="img" aria-label="' + (monthly ? 'Jump counts for the last twelve months' : 'Jump counts by year') + '" viewBox="0 0 ' + width + ' 200">' +
    '<desc>' + App.esc(description) + '</desc><path class="sd-axis" d="M4 150H' + (width - 4) + '"/>' +
    records.map((record, index) => {
      const height = record.count == null ? 0 : record.count / max * 110;
      const center = index * 48 + 24, label = monthly ? monthLabel(record.month) : String(record.year);
      const year = monthly && (index === 0 || record.month.endsWith('-01')) ? record.month.slice(0, 4) : '';
      return '<g class="sd-chart-bar' + (index === records.length - 1 ? ' is-latest' : '') + '"><title>' + App.esc((monthly ? record.month : record.year) + ': ' + number(record.count) + ' jumps') + '</title>' +
        '<rect x="' + (center - 13) + '" y="' + (150 - Math.max(height, record.count === 0 ? 1 : 0)) + '" width="26" height="' + Math.max(height, record.count === 0 ? 1 : 0) + '" rx="3"/>' +
        '<text class="sd-chart-value" x="' + center + '" y="' + (150 - height - 9) + '">' + number(record.count) + '</text>' +
        '<text class="sd-chart-label" x="' + center + '" y="174">' + App.esc(label) + '</text>' +
        (year ? '<text class="sd-chart-year" x="' + center + '" y="191">' + year + '</text>' : '') + '</g>';
    }).join('') + '</svg>';
}

function render() {
  if (!element) return;
  const data = window.DATA.skydivingLog;
  if (!data) { element.innerHTML = '<div class="sd-empty">Skydiving data unavailable.</div>'; return; }
  const now = +App.now(), summary = jumpSummary(data, now);
  const monthly = lastTwelveMonths(data.jumpCountsByMonth, now);
  const years = (data.jumpCountsByYear || []).slice().sort((a, b) => a.year - b.year);
  const scroll = element.querySelector('.sd-scroll')?.scrollTop || 0;
  element.innerHTML = (data.placeholder ? '<div class="sd-placeholder"><span>Placeholder data</span></div>' : '') +
    '<div class="skydiving-log"><header class="sd-header"><h1 class="serif">Skydiving</h1><div class="label">Logbook</div></header><div class="sd-scroll">' +
    '<section class="sd-summary" aria-label="Jump totals">' + metric(summary.total, 'Total jumps') + metric(summary.thisYear, 'Jumps in ' + summary.year, 'green') + metric(summary.last12Months, 'Last 12 months', 'purple') + '</section>' +
    '<div class="sd-info-grid' + (data.isInstructor ? '' : ' sd-info-grid--solo') + '"><section class="sd-panel"><header class="sd-panel-head"><h2>Rigs</h2><span class="sd-caption">Reserve repacks</span></header><div class="sd-rigs">' +
    ((data.rigs || []).map(rig => rigCard(rig, now)).join('') || '<div class="sd-empty">No rigs recorded.</div>') + '</div></section>' + instructorPanel(data) + '</div>' +
    '<div class="sd-charts"><section class="sd-panel"><header class="sd-panel-head"><h2>Jumps by year</h2></header>' + chart(years, false) + '</section>' +
    '<section class="sd-panel"><header class="sd-panel-head"><h2>Last 12 months</h2><span class="sd-caption">Includes this month</span></header>' + chart(monthly, true) + '</section></div></div></div>';
  element.querySelector('.sd-scroll').scrollTop = scroll;
}

App.register('skydiving', { minutely: true, show(el) { element = el; render(); } });
App.on('data', function () { if (App.current === 'skydiving') render(); });
App.on('minute', function () { if (App.current === 'skydiving') render(); });
