const MINUTE = 60000;

// Calendar ownership, rather than attendees, determines who gets a departure reminder.
export function nextDeparture(events, now, departures = new Map()) {
  const candidates = [];
  const eligible = new Set();
  for (const event of events) {
    if (event.allDay || !['dad', 'family'].includes(event.calendar)) continue;
    eligible.add(event.id);
    const start = +event.start;
    const saved = departures.get(event.id);
    let leaveAt;
    if (Number.isFinite(event.travel) && event.travel > 0) leaveAt = start - event.travel * MINUTE;
    else leaveAt = saved && saved.start === start ? saved.leaveAt : start;
    // Remember an activated reminder's deadline even after it expires, so a route
    // refresh cannot make it appear again at appointment time. Rescheduling resets it.
    if (saved && saved.start !== start) departures.delete(event.id);
    if (now >= leaveAt - 5 * MINUTE) departures.set(event.id, { start, leaveAt });
    if (now >= leaveAt - 5 * MINUTE && now < leaveAt + 5 * MINUTE) {
      candidates.push({ event, leaveAt });
    }
  }
  for (const id of departures.keys()) if (!eligible.has(id)) departures.delete(id);
  candidates.sort((a, b) => a.leaveAt - b.leaveAt || a.event.start - b.event.start);
  return candidates[0] || null;
}
