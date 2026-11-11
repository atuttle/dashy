import { createWeatherService, weatherResponse } from './weather.js';

let service;
let configuredKey;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/weather') {
      if (!service || configuredKey !== env.PIRATE_WEATHER_API_KEY) {
        configuredKey = env.PIRATE_WEATHER_API_KEY;
        service = createWeatherService({ apiKey: configuredKey });
      }
      return weatherResponse(request, service);
    }
    if (path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
