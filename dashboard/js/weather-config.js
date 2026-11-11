// Public display settings. Keep the Pirate Weather key in .env.local on the server.
export const WEATHER_LOCATION = {
  name: 'New York, NY',
  postalCode: '10001',
  latitude: 40.7128,
  longitude: -74.006,
  timezone: 'America/New_York',
};

export const WEATHER_REFRESH_MS = 15 * 60 * 1000;
export const WEATHER_MAX_AGE_MS = 2 * 60 * 60 * 1000;
