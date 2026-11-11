import { defineConfig, loadEnv } from 'vite';
import { createWeatherService, weatherResponse } from './server/weather.js';
import { createCalendarService, calendarResponse } from './server/calendars.js';
import { createSkydivingService, skydivingResponse } from './server/skydiving.js';
import { createPhotoService, photoResponse } from './server/photos.js';
import { createTravelService, travelResponse } from './server/travel.js';
import { createCountdownService, countdownResponse } from './server/countdowns.js';

function weatherApi(env) {
  const service = createWeatherService({ apiKey: env.PIRATE_WEATHER_API_KEY });
  const feeds = [['dad-personal', 'dad', 'ICAL_DAD_PERSONAL_URL'], ['dad-work', 'dad', 'ICAL_DAD_WORK_URL'], ['mom', 'mom', 'ICAL_MOM_URL'], ['kiddo', 'kiddo', 'ICAL_KIDDO_URL'], ['family', 'family', 'ICAL_FAMILY_URL']]
    .filter(([, , key]) => env[key]).map(([id, calendar, key]) => ({ id, name: id, calendar, url: env[key] }));
  const calendars = createCalendarService(feeds);
  const skydiving = createSkydivingService({ apiKey: env.PIRATE_WEATHER_API_KEY });
  const photos = createPhotoService({ albumUrl: env.GOOGLE_PHOTOS_ALBUM_URL, cacheDir: new URL('./.cache/photos', import.meta.url).pathname });
  const travel = createTravelService({ apiKey: env.TOMTOM_API_KEY, homeAddress: env.DASHY_HOME_ADDRESS });
  const countdowns = createCountdownService({ url: env.ICAL_COUNTDOWNS_URL, cacheDir: new URL('./.cache/countdowns', import.meta.url).pathname });
  const install = server => {
    server.middlewares.use(async (req, res, next) => {
      const path = req.url.split('?')[0];
      if (path === '/api/countdowns') {
        const response = await countdownResponse(new Request('http://' + req.headers.host + '/api/countdowns', { method: req.method,
          headers: { ...(req.headers.origin ? { Origin: req.headers.origin } : {}), ...(req.headers['sec-fetch-site'] ? { 'Sec-Fetch-Site': req.headers['sec-fetch-site'] } : {}) } }), countdowns);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }
      if (path === '/api/travel') {
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
          res.writeHead(403); res.end(); return;
        }
        const response = await travelResponse(new Request('http://localhost' + req.url, { method: req.method }), travel);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }
      if (path === '/api/photos' || path.startsWith('/api/photos/')) {
        const response = await photoResponse(new Request('http://localhost' + req.url, { method: req.method }), photos);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (path === '/api/skydiving') {
        const response = await skydivingResponse(new Request('http://localhost/api/skydiving', { method: req.method }), skydiving);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }
      if (path === '/api/calendars') {
        const response = await calendarResponse(new Request('http://' + req.headers.host + '/api/calendars', { method: req.method,
          headers: { ...(req.headers.origin ? { Origin: req.headers.origin } : {}), ...(req.headers['sec-fetch-site'] ? { 'Sec-Fetch-Site': req.headers['sec-fetch-site'] } : {}) } }), calendars);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }
      if (path !== '/api/weather') return next();
      const response = await weatherResponse(new Request('http://localhost/api/weather', {
        method: req.method,
      }), service);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
  };
  return { name: 'dashy-weather', configureServer: install, configurePreviewServer: install };
}

// The wall tablet runs Android WebView 106 — keep JS output within Chromium 106.
// CSS targets chrome61 on purpose: the tablet's WebView rejects 4/8-digit hex colours (#0000,
// #ffffffbf) even though Chrome 106 should support them, and a newer target lets the minifier
// rewrite transparent/rgba() into that form. Verified on-device with CSS.supports().
export default defineConfig(({ mode }) => ({
  plugins: [weatherApi(loadEnv(mode, process.cwd(), ''))],
  build: {
    target: 'chrome106',
    cssTarget: 'chrome61',
  },
  server: {
    host: 'localhost',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/config.local.json', '**/.cache/**'] },
  },
}));
