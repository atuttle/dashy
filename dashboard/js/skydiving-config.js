export const SKYDIVING_LOCATION = {
  station: 'KMDT', name: 'Harrisburg', latitude: 40.20, longitude: -76.77,
  timezone: 'America/New_York',
  url: 'https://www.usairnet.com/cgi-bin/launch/code.cgi?state=PA&sta=KMDT',
};
export const SKYDIVING_REFRESH_MS = 60 * 60 * 1000;
export const SKYDIVING_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const SKYDIVING_LIMITS = {
  startHour: 9,
  fallbackRainProbability: 0.20,
  lowWindMph: 18,
  highWindMph: 24,
  likelyGustSpreadMph: 12,
  noGoGustSpreadMph: 15,
  likelyCloudBaseFt: 5000,
  noGoCloudBaseFt: 3000,
  fallbackPartlyCloudyMax: 0.60,
};
