import { addressQuery, travelBufferSeconds, travelRefreshMs, TRAVEL_HORIZON_MS, TRAVEL_RETRY_MS } from '../js/travel-model.js';

const GEOCODE_URL = 'https://api.tomtom.com/maps/orbis/places/geocode';
const ROUTE_URL = 'https://api.tomtom.com/maps/orbis/routing/routes/calculate';

// Everything in these caches is server-only and in memory. Never return addresses/coordinates/keys.
export function createTravelService({ apiKey, homeAddress, fetchImpl = fetch, now = Date.now } = {}) {
  const geocodes = new Map(), routes = new Map(), pending = new Map();
  const configured = !!apiKey && !!addressQuery(homeAddress);

  async function request(url, version, attributes, body) {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'TomTom-Api-Key': apiKey, 'TomTom-Api-Version': version, Attributes: attributes,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('Travel unavailable');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 128 * 1024) throw new Error('Travel unavailable');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function geocode(address, origin) {
    const cached = geocodes.get(address);
    if (cached && now() < cached.expires) {
      if (!cached.point) throw new Error('Address unresolved');
      return cached.point;
    }
    const url = new URL(GEOCODE_URL);
    url.search = new URLSearchParams({ query: address, types: 'address', maxResults: '2', countryCodesIso2: 'US',
      ...(origin ? { position: origin.join(',') } : {}) });
    try {
      const result = await request(url, '2', 'results(type,position,address)');
      const postal = address.match(/\b(\d{5})(?:-\d{4})?(?:,?\s*(?:USA|United States))?$/i)?.[1];
      const matches = result.results?.filter(item => item.type === 'address'
        && String(item.address?.houseNumber).toLowerCase() === address.match(/^\S+/)?.[0].toLowerCase()
        && (!postal || item.address?.postalCode?.slice(0, 5) === postal)
        && item.address?.street && item.position?.type === 'Point'
        && item.position.coordinates?.length === 2
        && item.position.coordinates.every((v, i) => Number.isFinite(v) && Math.abs(v) <= (i ? 90 : 180)));
      if (!matches?.length) throw new Error('Address unresolved');
      const point = matches[0].position.coordinates;
      const identity = item => JSON.stringify(['houseNumber', 'street', 'municipality', 'countrySubdivision', 'postalCode'].map(field => String(item.address[field] || '').toLowerCase()));
      // Reject multiple distinct address matches instead of guessing the destination.
      // Several entrances/buildings at the same full street address are one destination.
      if (matches.slice(1).some(item => identity(item) !== identity(matches[0]) && Math.hypot(...item.position.coordinates.map((v, i) => v - point[i])) > 0.002)) throw new Error('Address ambiguous');
      if (geocodes.size >= 256) geocodes.delete(geocodes.keys().next().value);
      geocodes.set(address, { point, expires: now() + 86400000 });
      return point;
    } catch {
      geocodes.set(address, { expires: now() + TRAVEL_RETRY_MS });
      throw new Error('Travel unavailable');
    }
  }

  async function lookup(destination, eventStart, key) {
    const previous = routes.get(key);
    try {
      const origin = await geocode(addressQuery(homeAddress));
      const end = await geocode(destination, origin);
      const arrival = eventStart - (previous?.value?.bufferSeconds || 0) * 1000;
      const body = { routePlanningLocations: { origin: { type: 'Point', coordinates: origin }, destination: { type: 'Point', coordinates: end } },
        travelMode: 'car', routeType: 'fast', traffic: 'live',
        ...(arrival > now() ? { arrivalDateTime: new Date(arrival).toISOString() } : { departureDateTime: 'now' }) };
      const raw = await request(ROUTE_URL, '3', 'routes.summary', body);
      const driveSeconds = raw.routes?.[0]?.summary?.travelDurationInSeconds;
      if (!Number.isFinite(driveSeconds) || driveSeconds < 0 || driveSeconds > 86400) throw new Error('Travel unavailable');
      const fetchedAt = now();
      const value = { status: 'ok', source: 'TomTom', driveSeconds, bufferSeconds: travelBufferSeconds(driveSeconds), fetchedAt };
      const nextCheckAt = fetchedAt + travelRefreshMs(eventStart, driveSeconds, fetchedAt);
      const result = { ...value, nextCheckAt };
      if (routes.size >= 64) routes.delete(routes.keys().next().value);
      routes.set(key, { value: result, nextCheckAt });
      return result;
    } catch {
      const result = { status: 'unavailable', nextCheckAt: now() + TRAVEL_RETRY_MS };
      routes.set(key, { value: result, nextCheckAt: result.nextCheckAt });
      return result;
    }
  }

  return { snapshot(destination, eventStart) {
    const address = addressQuery(destination);
    if (!configured) return Promise.resolve({ status: 'unconfigured' });
    if (!address || !Number.isFinite(eventStart) || eventStart <= now() || eventStart > now() + TRAVEL_HORIZON_MS) return Promise.resolve({ status: 'skipped' });
    const key = JSON.stringify([address, eventStart]);
    const saved = routes.get(key);
    const nextCheck = saved?.value.status === 'ok' ? Math.min(saved.nextCheckAt, saved.value.fetchedAt + travelRefreshMs(eventStart, saved.value.driveSeconds, now())) : saved?.nextCheckAt;
    if (saved && now() < nextCheck) return Promise.resolve({ ...saved.value, nextCheckAt: nextCheck });
    if (!pending.has(key)) pending.set(key, lookup(address, eventStart, key).finally(() => pending.delete(key)));
    return pending.get(key);
  } };
}

export async function travelResponse(request, service) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET') return new Response('{}', { status: 405, headers });
  try {
    const url = new URL(request.url);
    return new Response(JSON.stringify(await service.snapshot(url.searchParams.get('destination'), Number(url.searchParams.get('eventStart')))), { headers });
  } catch { return new Response('{"status":"unavailable"}', { status: 503, headers }); }
}
