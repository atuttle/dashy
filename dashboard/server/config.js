import { weatherLocation } from '../js/weather-config.js';

export const DEFAULT_NAMES = Object.freeze({ dad: 'Dad', mom: 'Mom', kiddo: 'Kiddo', family: 'Family' });

// Explicit allowlist: never send the private configuration itself to the browser.
export function displayConfig(config = {}) {
  const people = {};
  for (const [id, fallback] of Object.entries(DEFAULT_NAMES)) {
    const name = config.people?.[id] ?? fallback;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f<>"&]/.test(name)) {
      throw new Error('Invalid household name');
    }
    people[id] = name.trim();
  }
  return { people, weather: weatherLocation(config.weather) };
}

export function runtimeConfig(config = {}, env = {}) {
  const numeric = key => env[key] === undefined || env[key] === '' ? undefined : Number(env[key]);
  const names = Object.fromEntries(Object.keys(DEFAULT_NAMES).map(id => [id, env[`DASHY_${id.toUpperCase()}_NAME`]]));
  const value = {
    ...config,
    people: { ...names, ...config.people },
    weather: { apiKey: env.PIRATE_WEATHER_API_KEY, name: env.DASHY_WEATHER_NAME || undefined,
      postalCode: env.DASHY_WEATHER_POSTAL_CODE || undefined, latitude: numeric('DASHY_WEATHER_LATITUDE'),
      longitude: numeric('DASHY_WEATHER_LONGITUDE'), timezone: env.DASHY_WEATHER_TIMEZONE || undefined,
      ...config.weather },
    calendars: config.calendars ?? [
      ['dad-personal', 'dad', 'ICAL_DAD_PERSONAL_URL'], ['dad-work', 'dad', 'ICAL_DAD_WORK_URL'],
      ['mom', 'mom', 'ICAL_MOM_URL'], ['kiddo', 'kiddo', 'ICAL_KIDDO_URL'], ['family', 'family', 'ICAL_FAMILY_URL'],
    ].filter(([, , key]) => env[key]).map(([id, calendar, key]) => ({ id, calendar, name: id, url: env[key] })),
    photos: config.photos ?? { albumUrl: env.GOOGLE_PHOTOS_ALBUM_URL },
    travel: config.travel ?? { apiKey: env.TOMTOM_API_KEY, homeAddress: env.DASHY_HOME_ADDRESS },
    countdowns: config.countdowns ?? { url: env.ICAL_COUNTDOWNS_URL },
  };
  displayConfig(value);
  return value;
}

export function configResponse(request, config) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' },
    { status: 405, headers: { ...headers, Allow: 'GET' } });
  return Response.json(displayConfig(config), { headers });
}
