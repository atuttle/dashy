import { WEATHER_LOCATION, WEATHER_REFRESH_MS } from '../weather-config.js';
import { freshnessRemaining } from '../weather-model.js';
import { skydivingPod, skydivingSheet } from '../skydiving-view.js';
import { nextCountdown } from '../countdown-model.js';
import { countdownBanner } from '../countdown-view.js';

// Home / Today: the glanceable overview. Never scrolls.
(function () {
  'use strict';
  var V = {};

  function clock() {
    var n = App.now();
    return '<div class="h-time num">' + App.fmt.time(n, false) + '<span class="h-ampm">' + App.fmt.ampm(n) + '</span></div>' +
      '<div class="h-date"><b>' + App.fmt.day(n) + '</b> ' + App.fmt.month(n) + ' ' + n.getDate() + '</div>';
  }

  function weather() {
    var w = App.weatherNow();
    var heading = '<div class="h-wx-location">' + App.esc(w.location) + '</div>';
    if (!w.available) {
      return heading + '<div class="h-wx-empty"><span class="num">—</span><b>' + App.esc(w.label) + '</b>' +
        '<small>' + (App.weatherStatus === 'loading' ? 'Fetching your local forecast' : 'Trying again shortly') + '</small></div>';
    }
    var hours = App.hourly(7);
    var updated = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: WEATHER_LOCATION.timezone }).format(w.fetchedAt);
    var elapsed = WEATHER_REFRESH_MS * (1 - freshnessRemaining({ fetchedAt: w.fetchedAt, stale: w.stale }));
    var freshness = w.stale ? '' : '<span class="h-wx-freshness" aria-hidden="true" style="animation-delay:-' +
      (elapsed / 1000) + 's;animation-duration:' + (WEATHER_REFRESH_MS / 1000) + 's"></span>';
    return heading + '<div class="h-wx-top">' +
      '<span class="h-wx-icon">' + App.icon(w.cond, 60) + '</span>' +
      '<span class="h-wx-temp num">' + w.temp + '°<small>F</small></span>' +
      '<span class="h-wx-meta"><b>' + App.esc(w.label) + '</b><span>H ' + w.hi + '°  L ' + w.lo + '°</span></span>' +
      '</div>' +
      '<div class="h-wx-details">Feels ' + w.feels + '°F · Wind ' + w.wind + ' mph · Humidity ' + w.humidity + '%</div>' +
      '<div class="h-wx-say" title="' + App.esc(w.summary) + '">' + App.esc(w.summary) + '</div>' +
      '<div class="h-wx-hours">' + hours.map(function (h) {
        return '<div class="h-hr' + (h.p >= 50 ? ' is-wet' : '') + '"><span class="h-hr-l">' + h.label + '</span>' +
          '<span class="h-hr-i">' + App.icon(h.c, 22) + '</span><b>' + h.t + '°</b></div>';
      }).join('') + '</div>' +
      '<div class="h-wx-note' + (w.stale ? ' is-stale' : '') + '" title="Updated ' + updated + '">' +
      (w.stale ? 'Last update ' + updated + ' · reconnecting' : '') + '</div>' + freshness;
  }

  function hero() {
    var e = App.nextEvent(), now = App.now();
    if (!e) {
      var message = App.calendarMessage && App.calendarMessage();
      if (message) return '<div class="h-hero h-hero--empty" data-go="calendar"><div class="label label--light">Calendar</div><div class="h-hero-title serif">' + App.esc(message) + '</div></div>';
      var tomorrow = App.timedOn(App.addDays(now, 1))[0];
      return '<div class="h-hero h-hero--empty" data-go="calendar">' +
        '<div class="label label--light">Rest of today</div>' +
        '<div class="h-hero-title serif">Nothing else scheduled.<br><i>Enjoy the quiet.</i></div>' +
        (tomorrow ? '<div class="h-hero-meta">Tomorrow starts with <b>' + App.esc(tomorrow.title) + '</b> at ' + App.fmt.time(tomorrow.start) + '</div>' : '') +
        '</div>';
    }
    var p = App.evColor(e);
    var mins = (e.start - now) / 60000;
    var leave = (App.leaveBy(e) - now) / 60000;
    var who = e.people.map(function (id) { return App.person(id).name; });
    var whoText = App.isFamily(e) ? 'Family' : who.join(' + ');
    var big = mins < 100
      ? '<div class="h-hero-count num">' + Math.round(mins) + '<small>min</small></div>'
      : '<div class="h-hero-count num">' + App.fmt.time(e.start, false) + '<small>' + App.fmt.ampm(e.start) + '</small></div>';
    var leavePill = '';
    if (e.travel) {
      leavePill = leave <= 0
        ? '<span class="pill pill--alert"><i class="pulse"></i>Leave now</span>'
        : '<span class="pill' + (leave <= 15 ? ' pill--soon' : '') + '">' + App.icon('car', 20) + 'Leave in ' + App.fmt.mins(leave) + '</span>';
    }
    return '<button class="h-hero" style="' + App.pstyle(p) + '" data-ev="' + e.id + '">' +
      '<div class="h-hero-main">' +
      '  <div class="label label--on">Next up · ' + App.esc(whoText) + '</div>' +
      '  <div class="h-hero-title serif">' + App.esc(e.title) + '</div>' +
      '  <div class="h-hero-meta">' + App.fmt.range(e.start, e.end) + (e.loc ? ' · ' + App.esc(e.loc) : '') + '</div>' +
      '  <div class="h-hero-foot">' + (e.people.length > 1 ? App.dots(e.people, 22) : '') + leavePill + '</div>' +
      '</div>' + big + '</button>';
  }

  function lanes() {
    var now = App.now();
    return App.calendars().map(function (p) {
      var list = App.allDayOn(now, p.id).concat(App.timedOn(now, p.id).filter(function (e) { return e.end > now; }));
      var message = App.calendarMessage && App.calendarMessage(p.id);
      var shown = list.slice(0, 3), more = list.length - shown.length;
      return '<div class="h-lane" style="' + App.pstyle(p) + '">' +
        '<div class="h-lane-head">' + App.avatar(p, 30) + '<b>' + p.name + '</b></div>' +
        (message ? '<small>' + App.esc(message) + '</small>' : '') +
        (list.length ? shown.map(function (e) {
          var cur = e.start <= now;
          return '<button class="h-ev' + (cur ? ' is-now' : '') + '" data-ev="' + e.id + '">' +
            '<span class="h-ev-t">' + (e.allDay ? 'All day' : cur ? 'Now' : App.fmt.time(e.start, false)) + '</span>' +
            '<span class="h-ev-n">' + App.esc(e.title) + '</span></button>';
        }).join('') : message ? '' : '<div class="h-free serif"><i>Free</i> the rest of the day</div>') +
        (more > 0 ? '<button class="h-more" data-go="calendar">+' + more + ' more</button>' : '') +
        '</div>';
    }).join('');
  }

  function ring(done, total, size) {
    var r = size / 2 - 5, c = 2 * Math.PI * r, f = total ? done / total : 0;
    return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="ring-bg"/>' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="ring-fg" stroke-dasharray="' + (c * f) + ' ' + c + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"/></svg>';
  }
  App.ring = ring;

  function paintCountdown() {
    if (!V.el || !V.el.firstChild) return;
    var state = App.countdownState || {};
    var next = nextCountdown(state.events || [], +App.now());
    var slot = V.el.querySelector('.h-countdown-slot');
    slot.innerHTML = next ? countdownBanner(next, { compact: true, stale: state.error || state.stale }) : '';
    slot.hidden = !next;
    V.el.querySelector('.h-left').classList.toggle('has-countdown', !!next);
  }

  function paint() {
    var el = V.el;
    el.querySelector('.h-clock').innerHTML = clock();
    el.querySelector('.h-weather').innerHTML = weather();
    el.querySelector('.h-hero-slot').innerHTML = hero();
    el.querySelector('.h-lanes').innerHTML = lanes();
    el.querySelector('.h-skydiving').innerHTML = skydivingPod();
    paintCountdown();
  }

  function photoCaption(s) {
    var caption = V.el.querySelector('.h-photo-cap');
    if (!s) { caption.innerHTML = ''; caption.hidden = true; return; }
    var m = App.photoMeta(s.photos[0]);
    caption.hidden = !m.kicker && !m.place;
    caption.innerHTML = '<b>' + (m.onThisDay ? 'On this day · ' : '') + App.esc(m.kicker) + '</b><span>' + App.esc(m.place) + '</span>';
  }

  App.register('home', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) {
        el.innerHTML = '<div class="home">' +
          '<div class="h-left">' +
          '  <div class="h-clock" data-go="calendar"></div>' +
          '  <div class="h-countdown-slot" hidden></div>' +
          '  <button class="h-photo" data-go="photos"><div class="h-photo-stage"></div><div class="h-photo-cap"></div></button>' +
          '</div>' +
          '<div class="h-right">' +
          '  <div class="h-top-row"><div class="h-weather"></div><section class="h-skydiving card" aria-label="Weekend skydiving forecast"></section></div>' +
          '  <div class="h-main"><div class="h-hero-slot"></div><div class="h-lanes" style="grid-template-columns:repeat(' + App.calendars().length + ',1fr)"></div></div>' +
          '</div></div>';
        el.addEventListener('click', function (e) {
          var jump = e.target.closest('[data-jump]');
          if (jump) { skydivingSheet(jump.dataset.jump); return; }
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          var g = e.target.closest('[data-go]');
          if (g) App.go(g.dataset.go);
        });
        V.slides = new App.Slideshow(el.querySelector('.h-photo-stage'), { layout: 'cover', captions: false, interval: 12000, onChange: photoCaption });
      }
      paint();
      V.slides.start();
    },
    resume: function () { V.slides.start(); },
    hide: function () { if (V.slides) V.slides.stop(); }
  });
  // Every minute: just the clock and next-up countdown (cheap, even while hidden). Weather on the hour.
  App.on('minute', function (n) {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-clock').innerHTML = clock();
    V.el.querySelector('.h-hero-slot').innerHTML = hero();
    V.el.querySelector('.h-lanes').innerHTML = lanes();
    V.el.querySelector('.h-skydiving').innerHTML = skydivingPod();
    paintCountdown();
    if (n.getMinutes() === 0) V.el.querySelector('.h-weather').innerHTML = weather();
  });
  App.on('data', function () { if (App.current === 'home') paint(); });
  App.on('weather', function () {
    if (V.el && V.el.firstChild) V.el.querySelector('.h-weather').innerHTML = weather();
  });
  App.on('skydiving', function () {
    if (V.el && V.el.firstChild) V.el.querySelector('.h-skydiving').innerHTML = skydivingPod();
  });
  App.on('countdowns', paintCountdown);
})();
