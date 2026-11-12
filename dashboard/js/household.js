import { WEATHER_LOCATION, weatherLocation } from './weather-config.js';

const App = window.App;

App.configReady = (async () => {
  try {
    const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Configuration unavailable');
    const config = await response.json();
    const location = weatherLocation(config.weather);
    const people = window.DATA.people.concat([window.DATA.family]);
    const names = people.map(person => config.people?.[person.id] ?? person.name);
    if (names.some(name => typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f<>"&]/.test(name))) {
      throw new Error('Invalid household names');
    }
    people.forEach((person, index) => { person.name = names[index].trim(); });
    Object.assign(WEATHER_LOCATION, location);
  } catch {
    // Generic labels remain usable offline; never display raw configuration errors.
  }
})();
