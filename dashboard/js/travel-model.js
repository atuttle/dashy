export const TRAVEL_HORIZON_MS = 24 * 60 * 60 * 1000;
export const TRAVEL_RETRY_MS = 5 * 60 * 1000;

// Physical US street addresses only. Meeting links and vague place names are skipped.
export function addressQuery(value) {
  if (typeof value !== 'string' || value.length > 1024 || /https?:\/\/|\b(?:zoom|teams|meet\.google|p\.?\s*o\.?\s+box)\b/i.test(value)) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  const match = text.match(/\b\d+[A-Za-z]?(?:-\d+)?\s+(?:[A-Za-z0-9.'’\-]+\s+){1,8}(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|way|pike|highway|hwy|parkway|pkwy|terrace|ter|trail|trl|place|pl)\b\.?/i);
  return match ? text.slice(match.index) : null;
}

export function travelBufferSeconds(driveSeconds) {
  return 5 * 60 + Math.min(15 * 60, driveSeconds / 6);
}

export function travelRefreshMs(eventStart, driveSeconds, now) {
  const leaveAt = eventStart - (driveSeconds + travelBufferSeconds(driveSeconds)) * 1000;
  return leaveAt - now <= 2 * 60 * 60 * 1000 ? TRAVEL_RETRY_MS : 30 * 60 * 1000;
}

export function travelKey(event) { return JSON.stringify([addressQuery(event.loc), +event.start]); }

export function usableTravel(value, now = Date.now(), eventStart) {
  const maxAge = Number.isFinite(eventStart) ? Math.min(60 * 60000, 3 * travelRefreshMs(eventStart, value?.driveSeconds, now)) : 15 * 60000;
  return value?.status === 'ok' && value.source === 'TomTom'
    && Number.isFinite(value.driveSeconds) && value.driveSeconds > 0 && value.driveSeconds <= 86400
    && Number.isFinite(value.fetchedAt) && value.fetchedAt <= now + 60000
    && now - value.fetchedAt < maxAge;
}
