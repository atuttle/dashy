import { bounceNightAxis, hitsNightCorner } from '../night-motion.js';

// Ambient (idle photo frame) and Night (dim red clock) overlays.
(function () {
  'use strict';
  var $ = App.$;
  var amb = { show: null }, shiftTimer = null;
  var nightPosition = null, nightBounds, nightFrame = null, lastFrame = null;
  var dvdUntil = 0, dvdShowing = false;

  function placeNight() {
    $('#night .nt-inner').style.transform = 'translate3d(' + nightPosition.x.toFixed(2) + 'px,' +
      nightPosition.y.toFixed(2) + 'px,0)';
  }

  function measureNight() {
    var screen = $('#night'), content = $('#night .nt-inner');
    nightBounds = {
      x: Math.max(0, screen.clientWidth - content.offsetWidth),
      y: Math.max(0, screen.clientHeight - content.offsetHeight)
    };
    if (!nightPosition) nightPosition = { x: nightBounds.x / 2, y: nightBounds.y / 2, vx: 6, vy: 4 };
    nightPosition.x = Math.min(nightPosition.x, nightBounds.x);
    nightPosition.y = Math.min(nightPosition.y, nightBounds.y);
    placeNight();
  }

  function moveNight(time) {
    // Resume gently after backgrounding rather than jumping across the screen.
    var elapsed = lastFrame == null ? 0 : Math.min((time - lastFrame) / 1000, .25);
    lastFrame = time;
    if (hitsNightCorner(nightPosition, nightBounds, elapsed)) dvdUntil = time + 15000;
    var showDvd = time < dvdUntil;
    if (showDvd !== dvdShowing) {
      $('#night .nt-inner').classList.toggle('is-dvd', showDvd);
      dvdShowing = showDvd;
    }
    var x = bounceNightAxis(nightPosition.x, nightPosition.vx, elapsed, nightBounds.x);
    var y = bounceNightAxis(nightPosition.y, nightPosition.vy, elapsed, nightBounds.y);
    nightPosition = { x: x.position, y: y.position, vx: x.velocity, vy: y.velocity };
    placeNight();
    nightFrame = requestAnimationFrame(moveNight);
  }

  function stopNight() {
    if (nightFrame != null) cancelAnimationFrame(nightFrame);
    nightFrame = null;
    lastFrame = null;
    dvdUntil = 0;
    dvdShowing = false;
    $('#night .nt-inner').classList.remove('is-dvd');
  }

  function ambientInfo() {
    var n = App.now(), w = App.weatherNow(), next = App.nextEvent();
    return '<div class="amb-clock"><div class="amb-time num">' + App.fmt.time(n, false) + '</div>' +
      '<div class="amb-date">' + App.fmt.day(n) + '<br>' + App.fmt.month(n) + ' ' + n.getDate() + '</div></div>' +
      '<div class="amb-wx"><div class="amb-wx-current">' + App.icon(w.cond, 44) + '<span class="num">' + w.temp + '°F</span></div><small>' + App.esc(w.stale ? 'Last known weather · reconnecting' : w.summary) + '</small></div>' +
      '<div class="amb-right">' +
      (next ? '<div class="amb-next" style="' + App.pstyle(App.evColor(next)) + '"><i></i>' + App.esc(next.title) + ' · ' + App.fmt.time(next.start) + '</div>' : '') +
      '</div>';
  }
  function nightInfo() {
    var n = App.now(), tomorrow = App.addDays(n, n.getHours() < 6 ? 0 : 1);
    var first = App.timedOn(tomorrow)[0], w = App.weatherNow();
    return '<div class="nt-time num"><span class="nt-digits">' + App.fmt.time(n, false) + '</span>' +
      '<span class="nt-dvd" aria-hidden="true"><img src="/art/night-dvd.svg" alt=""></span></div>' +
      '<div class="nt-line">' + App.icon(w.cond, 26) + ' ' + w.temp + '°F' + (w.stale ? ' (last known)' : '') + ' · ' + (first ? 'First up ' + App.fmt.rel(first.start).toLowerCase() + ': <b>' + App.esc(first.title) + '</b> ' + App.fmt.time(first.start) + ' · ' + App.person(first.people[0]).name : 'Nothing early tomorrow') + '</div>';
  }

  function paint() {
    if (App.mode === 'ambient') $('#ambient .amb-info').innerHTML = ambientInfo();
    if (App.mode === 'night') {
      $('#night .nt-inner').innerHTML = nightInfo();
      measureNight();
    }
  }

  // The photo overlay still gets a small periodic nudge; the night clock drifts continuously.
  function pixelShift() {
    var x = Math.round(Math.random() * 8 - 4), y = Math.round(Math.random() * 8 - 4);
    $('#ambient .amb-info').style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  App.on('ready', function () {
    $('#ambient').innerHTML = '<div class="amb-stage"></div><div class="amb-scrim"></div><div class="amb-info"></div>';
    $('#night').innerHTML = '<div class="nt-inner"></div>';
    amb.show = new App.Slideshow($('#ambient .amb-stage'), { layout: 'cover', captions: false, interval: 14000 });
    $('#ambient').addEventListener('click', function () { App.setMode('day'); App.go('home'); });
    $('#night').addEventListener('click', function () { App.setMode('nightdash'); });
    window.addEventListener('resize', function () { if (App.mode === 'night') measureNight(); });
    if (document.fonts) document.fonts.ready.then(function () { if (App.mode === 'night') measureNight(); });
  });

  App.on('mode', function (m) {
    clearInterval(shiftTimer);
    stopNight();
    if (m === 'ambient') { amb.show.start(); paint(); shiftTimer = setInterval(pixelShift, 60000); }
    else amb.show.stop();
    if (m === 'night') { paint(); nightFrame = requestAnimationFrame(moveNight); }
    App.resetIdle();
  });
  App.demoNightCorner = function () {
    App.setMode('night');
    // Aim at the lower-right corner eight seconds away; use the real collision detector.
    var seconds = Math.min(8, nightBounds.x / 6, nightBounds.y / 4);
    nightPosition = { x: nightBounds.x - 6 * seconds, y: nightBounds.y - 4 * seconds, vx: 6, vy: 4 };
    lastFrame = null;
    placeNight();
  };
  App.on('minute', paint);
  App.on('weather', paint);
})();
