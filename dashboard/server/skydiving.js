import { SKYDIVING_LOCATION as LOCATION, SKYDIVING_REFRESH_MS, SKYDIVING_MAX_AGE_MS } from '../js/skydiving-config.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0 ? value : null;
const fraction = value => finite(value) && value >= 0 && value <= 1 ? value : null;
const percent = value => finite(value) && value >= 0 && value <= 100 ? value : null;

export function parseAviationPage(html, fetchedAt) {
  const script = html.match(/<script\b[^>]*\bid=["']forecast-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script || !/KMDT\s+NBM\s+NBS GUIDANCE/.test(html)) throw new Error('Unexpected aviation page');
  const data = JSON.parse(script[1]);
  if (data.timezone !== LOCATION.timezone || data.windunit !== 'mph'
      || !Array.isArray(data.epochs) || !Array.isArray(data.weather) || data.weather.length !== data.epochs.length
      || !Array.isArray(data.sources) || data.sources.length !== data.epochs.length) throw new Error('Invalid aviation forecast');
  const charts = new Map(data.charts.map(chart => [chart.key, chart.values]));
  const labels = [...html.matchAll(/<span\b[^>]*class=["'][^"']*\bsky-name\b[^"']*["'][^>]*>([^<]*)<\/span>/gi)].map(match => match[1].trim());
  const displayValue = (key, index) => {
    const value = nonnegative(charts.get(key)?.[index]);
    return value === null ? null : Math.round(value);
  };
  const points = data.weather.map((row, i) => {
    const time = data.epochs[i] * 1000;
    const issuedAt = data.sources[i]?.issue * 1000;
    if (!finite(time) || !finite(issuedAt) || data.sources[i]?.product !== 'NBS') throw new Error('Invalid aviation times');
    return { time, issuedAt,
      // weather.WSP/GST are raw knots; charts hold converted display units.
      windSpeedMph: displayValue('WSP', i), windGustMph: displayValue('GST', i),
      lowestCloudBaseFt: displayValue('LCB', i), unlimitedBase: row.LCB === 'Unlimited',
      cloudCover: labels.length === data.epochs.length ? labels[i] : null,
      cloudCoverPercent: percent(row.SKY),
      flightCategory: ['VFR', 'MVFR', 'IFR', 'LIFR'].includes(row.CAT) ? row.CAT : null };
  }).sort((a, b) => a.time - b.time);
  if (!points.length || points.some((p, i) => i && p.time <= points[i - 1].time)) throw new Error('Invalid aviation timeline');
  return { source: 'USAirNet', fetchedAt, issuedAt: Math.min(...points.map(p => p.issuedAt)), points };
}

export function normalizeBasicForecast(raw, fetchedAt) {
  if (raw.timezone !== LOCATION.timezone || raw.flags?.units !== 'us' || !Array.isArray(raw.hourly?.data)) throw new Error('Unexpected basic forecast');
  const points = raw.hourly.data.map(row => ({
    time: finite(row.time) ? row.time * 1000 : null,
    windSpeedMph: nonnegative(row.windSpeed), windGustMph: nonnegative(row.windGust),
    cloudCover: fraction(row.cloudCover), precipProbability: fraction(row.precipProbability),
    icon: typeof row.icon === 'string' ? row.icon : null,
  })).filter(p => p.time !== null).sort((a, b) => a.time - b.time);
  if (!points.length) throw new Error('Empty basic forecast');
  return { source: 'Pirate Weather', fetchedAt, points };
}

async function readText(response) {
  if (!response.ok) throw new Error('Provider unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function createSkydivingService({ apiKey, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  let pending;
  async function getSource(name, address, headers, normalize) {
    let saved = cache.get(name);
    const clock = now();
    if (!saved || clock >= saved.retryAt) {
      try {
        const response = await fetchImpl(address, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
        const text = await readText(response);
        const value = normalize(text, now());
        // Old model runs must not be treated as newly issued merely because scraping succeeded.
        if (name === 'aviation' && (clock - value.issuedAt > 6 * 3600000 || value.issuedAt > clock + 3600000)) throw new Error('Old model run');
        saved = { value, retryAt: now() + SKYDIVING_REFRESH_MS, error: false };
      } catch {
        saved = { value: saved?.value, retryAt: now() + 5 * 60000, error: true };
      }
      cache.set(name, saved);
    }
    if (!saved.value || now() - saved.value.fetchedAt >= SKYDIVING_MAX_AGE_MS) return null;
    return { ...saved.value, stale: saved.error };
  }
  return { snapshot() {
    if (!pending) {
      const basicUrl = `https://api.pirateweather.net/forecast/dashy/${LOCATION.latitude},${LOCATION.longitude}?units=us&extend=hourly&exclude=currently,minutely,daily,alerts`;
      pending = Promise.all([
        getSource('aviation', LOCATION.url, {}, parseAviationPage),
        apiKey ? getSource('basic', basicUrl, { apikey: apiKey }, (text, at) => normalizeBasicForecast(JSON.parse(text), at)) : null,
      ]).then(([aviation, basic]) => ({ station: LOCATION.station, aviation, basic, checkedAt: now() }))
        .finally(() => { pending = null; });
    }
    return pending;
  } };
}

export async function skydivingResponse(request, service) {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  try { return Response.json(await service.snapshot(), { headers }); }
  catch { return Response.json({ error: 'Forecast unavailable' }, { status: 503, headers }); }
}
