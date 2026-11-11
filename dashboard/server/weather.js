import { WEATHER_LOCATION, WEATHER_REFRESH_MS, WEATHER_MAX_AGE_MS } from '../js/weather-config.js';

function requiredNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid forecast');
  return value;
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Expose only display data, never provider credentials, headers, or error bodies.
export function normalizeForecast(data, fetchedAt) {
  if (data.flags?.units !== 'us' || data.timezone !== WEATHER_LOCATION.timezone) {
    throw new Error('Unexpected forecast units or location');
  }
  const current = data.currently;
  const today = data.daily?.data?.[0];
  const hourly = data.hourly?.data;
  if (!current || !today || !Array.isArray(hourly) || !hourly.length) throw new Error('Incomplete forecast');
  const normalizePoint = (point) => ({
    time: requiredNumber(point.time) * 1000,
    temperature: requiredNumber(point.temperature),
    icon: typeof point.icon === 'string' ? point.icon : 'cloudy',
    precipProbability: optionalNumber(point.precipProbability),
  });
  return {
    source: 'Pirate Weather',
    location: WEATHER_LOCATION,
    units: { temperature: 'F', wind: 'mph' },
    fetchedAt,
    current: {
      ...normalizePoint(current),
      summary: typeof current.summary === 'string' ? current.summary : 'Current conditions',
      feelsLike: optionalNumber(current.apparentTemperature),
      windSpeed: optionalNumber(current.windSpeed),
      humidity: optionalNumber(current.humidity),
    },
    summary: typeof data.hourly.summary === 'string' ? data.hourly.summary : current.summary,
    high: requiredNumber(today.temperatureMax ?? today.temperatureHigh),
    low: requiredNumber(today.temperatureMin ?? today.temperatureLow),
    hourly: hourly.map(normalizePoint).sort((a, b) => a.time - b.time),
  };
}

export function createWeatherService({ apiKey, fetchImpl = fetch, now = Date.now,
  origin = 'https://api.pirateweather.net', timeoutMs = 8000 } = {}) {
  let cached = null;
  let pending = null;
  let retryAfter = 0;

  function fallback() {
    if (cached && now() - cached.fetchedAt < WEATHER_MAX_AGE_MS) return { ...cached, stale: true };
    throw new Error('Weather unavailable');
  }

  async function refresh() {
    try {
      // Pirate supports header authentication with a dummy URL key, keeping secrets out of URLs.
      const url = new URL(`${origin}/forecast/dashy/${WEATHER_LOCATION.latitude},${WEATHER_LOCATION.longitude}`);
      url.searchParams.set('units', 'us');
      url.searchParams.set('exclude', 'minutely,alerts');
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, { headers: { apikey: apiKey }, signal });
      if (!response.ok) throw new Error('Weather provider unavailable');
      // Keep the timeout active while reading/parsing the response body too.
      cached = normalizeForecast(await response.json(), now());
      retryAfter = 0;
      return { ...cached, stale: false };
    } catch {
      retryAfter = now() + 60_000;
      return fallback();
    }
  }

  return {
    async forecast() {
      if (!apiKey) throw new Error('Weather not configured');
      if (cached && now() - cached.fetchedAt < WEATHER_REFRESH_MS && !retryAfter) {
        return { ...cached, stale: false };
      }
      if (now() < retryAfter) return fallback();
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}

export async function weatherResponse(request, service) {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  }
  try {
    return Response.json(await service.forecast(), { headers });
  } catch {
    return Response.json({ error: 'Weather unavailable. Retrying shortly.' }, { status: 503, headers });
  }
}
