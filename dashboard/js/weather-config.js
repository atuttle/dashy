// Generic defaults only. The private configuration supplies the actual location.
export const WEATHER_LOCATION = {
  name: 'Local weather',
  postalCode: '',
  latitude: null,
  longitude: null,
  timezone: 'America/New_York',
};

export function weatherLocation(settings = {}) {
  const location = {};
  for (const key of Object.keys(WEATHER_LOCATION)) location[key] = settings[key] ?? WEATHER_LOCATION[key];
  for (const [key, limit] of [['latitude', 90], ['longitude', 180]]) {
    if (location[key] !== null && (typeof location[key] !== 'number' || !Number.isFinite(location[key])
      || Math.abs(location[key]) > limit)) throw new Error('Invalid weather location');
  }
  for (const key of ['name', 'postalCode', 'timezone']) {
    if (typeof location[key] !== 'string' || location[key].length > 100 || /[\x00-\x1f]/.test(location[key])) {
      throw new Error('Invalid weather location');
    }
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: location.timezone }); }
  catch { throw new Error('Invalid weather timezone'); }
  return location;
}

export const WEATHER_REFRESH_MS = 15 * 60 * 1000;
export const WEATHER_MAX_AGE_MS = 2 * 60 * 60 * 1000;
