import { nextDeparture } from '../departure-model.js';
import { bounceNightAxis } from '../night-motion.js';

// Departure reminders sit above the screen savers and below doorbell/critical alerts.
(function () {
  'use strict';
  var screen, content, headline, title, active = null;
  var departures = new Map();
  var position = null, bounds, frame = null, lastFrame = null;

  function place() {
    content.style.transform = 'translate3d(' + position.x.toFixed(2) + 'px,' +
      position.y.toFixed(2) + 'px,0)';
  }

  function measure() {
    bounds = {
      x: Math.max(0, screen.clientWidth - content.offsetWidth),
      y: Math.max(0, screen.clientHeight - content.offsetHeight)
    };
    if (!position) position = { x: bounds.x / 2, y: bounds.y / 2, vx: 6, vy: 4 };
    position.x = Math.min(position.x, bounds.x);
    position.y = Math.min(position.y, bounds.y);
    place();
  }

  function move(time) {
    var elapsed = lastFrame == null ? 0 : Math.min((time - lastFrame) / 1000, .25);
    lastFrame = time;
    var x = bounceNightAxis(position.x, position.vx, elapsed, bounds.x);
    var y = bounceNightAxis(position.y, position.vy, elapsed, bounds.y);
    position = { x: x.position, y: y.position, vx: x.velocity, vy: y.velocity };
    place();
    frame = requestAnimationFrame(move);
  }

  function sync() {
    if (!screen) return;
    var now = +App.now();
    active = nextDeparture(App.events(), now, departures);
    screen.hidden = !active;
    if (!active) {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
      lastFrame = null;
      position = null;
      return;
    }
    var text = now >= active.leaveAt ? 'LEAVE NOW'
      : 'Leave in ' + App.fmt.mins(Math.ceil((active.leaveAt - now) / 60000));
    var changed = headline.textContent !== text || title.textContent !== active.event.title;
    if (changed) {
      headline.textContent = text;
      title.textContent = active.event.title;
    }
    if (changed || frame == null) measure();
    if (frame == null) frame = requestAnimationFrame(move);
  }

  App.on('ready', function () {
    screen = App.$('#departure');
    screen.innerHTML = '<div class="dep-inner"><div class="dep-time num"></div><div class="dep-title"></div></div>';
    content = App.$('.dep-inner', screen);
    headline = App.$('.dep-time', screen);
    title = App.$('.dep-title', screen);
    window.addEventListener('resize', function () { if (active) measure(); });
    if (document.fonts) document.fonts.ready.then(function () { if (active) measure(); });
    sync();
  });
  App.on('second', sync);
  App.on('data', sync);
  App.on('time', sync);
})();
