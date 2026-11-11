function escape(value) {
  return String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}

export function countdownBanner(event, { compact = false, stale = false } = {}) {
  const tag = compact ? 'button' : 'article';
  return '<' + tag + ' class="cd-banner cd-banner--' + event.tone + (compact ? ' h-countdown' : '') + '"' +
    (compact ? ' type="button" data-go="countdowns"' : '') + '>' +
    (compact ? '<span class="h-countdown-kicker">Next up</span>' : '') +
    '<div class="cd-count"><strong class="num">' + escape(event.amount) + '</strong>' +
    '<span class="cd-unit">' + escape(event.unit) + (event.lead ? '<small>' + escape(event.lead) + '</small>' : '') + '</span></div>' +
    '<h2 class="serif">' + escape(event.title) + '</h2>' +
    '<div class="cd-date">' + escape(event.dateLabel) + (compact && stale ? '<span class="h-countdown-stale">Saved dates</span>' : '') + '</div></' + tag + '>';
}
