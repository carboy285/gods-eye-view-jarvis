import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';
import { usesImperial } from './briefing.js';
import { createJsonFile, jarvisHome } from './store.js';
import { describeWhen } from './time.js';

const USGS_DAY_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
const ADSB_CALLSIGN_URL = 'https://api.adsb.lol/v2/callsign/';
const USER_AGENT = 'GodsEyeView-Jarvis/0.1 (personal assistant)';

const TICK_MS = 2 * 60_000;
const HAZARD_EVERY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
// A quake older than this when first seen is news, not an alert.
const QUAKE_FRESH_MS = 60 * 60_000;
const MAX_SEEN = 300;
const MAX_FLIGHTS = 10;
const FLIGHT_MAX_AGE_MS = 24 * 3_600_000;
// Aircraft often drop out of coverage on final approach.
const LOST_ON_APPROACH_MS = 10 * 60_000;
const APPROACH_ALTITUDE_FT = 5_000;
// Nothing airborne moves this slowly; below it the aircraft is on the ground.
const GROUND_SPEED_KT = 40;
const KM_PER_MILE = 1.609344;
const DEFAULT_ALERTS = Object.freeze({
  quakes: Object.freeze({ on: true, minMagnitude: 4, radiusKm: 300 }),
  weather: Object.freeze({ on: true }),
});

export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const COMPASS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
];

export function compassFrom(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.cos((b.lon - a.lon) * rad);
  const bearing = (Math.atan2(y, x) / rad + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
}

export function normalizeCallsign(value) {
  const callsign = String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  return /^[A-Z0-9]{2,8}$/.test(callsign) ? callsign : null;
}

function spokenDistance(km, home) {
  return usesImperial(home)
    ? `${Math.round(km / KM_PER_MILE)} miles`
    : `${Math.round(km)} kilometers`;
}

/** One ADS-B position: on the ground, or airborne with altitude and speed. */
export function flightStatus(aircraft) {
  if (!aircraft) return null;
  const speed = Number(aircraft.gs);
  const altitude = Number(aircraft.alt_baro);
  const onGround =
    aircraft.alt_baro === 'ground' ||
    (Number.isFinite(speed) && speed < GROUND_SPEED_KT);
  return {
    onGround,
    altitudeFt: Number.isFinite(altitude) ? altitude : null,
    speedKt: Number.isFinite(speed) ? Math.round(speed) : null,
  };
}

function describeFlight(callsign, status) {
  if (!status) return `${callsign} isn't showing on radar right now`;
  if (status.onGround) return `${callsign} is on the ground, not yet departed`;
  return `${callsign} is airborne${status.altitudeFt ? ` at ${Math.round(status.altitudeFt / 100) * 100} feet` : ''}`;
}

const remember = (list, id) =>
  [...list.filter((seen) => seen !== id), id].slice(-MAX_SEEN);

/**
 * Jarvis's alerts, with no AI in the loop: earthquakes and severe weather near
 * home, and "tell me when this flight lands". Each alert is sent once.
 */
export function createWatchers({
  file = path.join(jarvisHome(), 'jarvis-watches.json'),
  fsImpl,
  fetchImpl = fetch,
  settings,
  now = () => new Date(),
  timeZone = () => 'UTC',
  deliver = async () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const store = createJsonFile({
    file,
    fsImpl,
    empty: {
      alerts: DEFAULT_ALERTS,
      flights: [],
      seen: { quakes: [], weather: [] },
    },
  });
  let timer = null;
  let running = null;
  let lastHazardCheck = 0;

  async function state() {
    const data = (await store.read()) || {};
    return {
      alerts: {
        quakes: { ...DEFAULT_ALERTS.quakes, ...data.alerts?.quakes },
        weather: { ...DEFAULT_ALERTS.weather, ...data.alerts?.weather },
      },
      flights: Array.isArray(data.flights) ? data.flights : [],
      seen: {
        quakes: Array.isArray(data.seen?.quakes) ? data.seen.quakes : [],
        weather: Array.isArray(data.seen?.weather) ? data.seen.weather : [],
      },
    };
  }

  async function getJson(url, headers = {}) {
    const response = await fetchImpl(url, {
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readResponseJsonCapped(response, 8 * 1024 * 1024);
  }

  async function lookupFlight(callsign) {
    const data = await getJson(
      `${ADSB_CALLSIGN_URL}${encodeURIComponent(callsign)}`,
    );
    const aircraft = (Array.isArray(data?.ac) ? data.ac : []).find(
      (entry) => normalizeCallsign(entry?.flight) === callsign,
    );
    return flightStatus(aircraft);
  }

  async function checkQuakes(current, home, alerts) {
    const settingsNow = current.alerts.quakes;
    if (!settingsNow.on) return;
    const data = await getJson(USGS_DAY_URL);
    const since = Math.max(
      now().getTime() - QUAKE_FRESH_MS,
      Date.parse(settingsNow.since || 0) || 0,
    );
    for (const feature of Array.isArray(data?.features) ? data.features : []) {
      const magnitude = Number(feature?.properties?.mag);
      const [lon, lat] = feature?.geometry?.coordinates || [];
      const id = String(feature?.id || '');
      if (
        !id ||
        current.seen.quakes.includes(id) ||
        !(magnitude >= settingsNow.minMagnitude) ||
        !(Number(feature.properties.time) >= since) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      )
        continue;
      const km = distanceKm(home, { lat, lon });
      if (km > settingsNow.radiusKm) continue;
      current.seen.quakes = remember(current.seen.quakes, id);
      const place = String(feature.properties.place || '').slice(0, 100);
      alerts.push({
        kind: 'earthquake',
        title: 'Earthquake',
        text: `Magnitude ${magnitude.toFixed(1)} earthquake, ${spokenDistance(km, home)} ${compassFrom(home, { lat, lon })} of home${place ? `, ${place}` : ''}.`,
        priority: magnitude >= 6 ? 'high' : 'default',
      });
    }
  }

  async function checkWeather(current, home, alerts) {
    if (!current.alerts.weather.on || !usesImperial(home)) return;
    const params = new URLSearchParams({
      point: `${home.lat.toFixed(4)},${home.lon.toFixed(4)}`,
    });
    const data = await getJson(`${NWS_ALERTS_URL}?${params}`, {
      Accept: 'application/geo+json',
    });
    for (const feature of Array.isArray(data?.features) ? data.features : []) {
      const alert = feature?.properties || {};
      const id = String(alert.id || feature?.id || '');
      const event = String(alert.event || '').slice(0, 80);
      const serious =
        ['Severe', 'Extreme'].includes(alert.severity) ||
        /Warning$/.test(event);
      if (!id || !event || !serious || current.seen.weather.includes(id))
        continue;
      current.seen.weather = remember(current.seen.weather, id);
      const ends = new Date(alert.ends || alert.expires);
      const until = Number.isNaN(ends.getTime())
        ? ''
        : ` until ${describeWhen(ends, now(), timeZone()).replace(/^at /, '')}`;
      alerts.push({
        kind: 'weather',
        title: 'Weather alert',
        text: `Weather alert for home: ${event}${until}.`,
        priority:
          alert.severity === 'Extreme' || /Warning$/.test(event)
            ? 'high'
            : 'default',
      });
    }
  }

  async function checkFlights(current, alerts) {
    const kept = [];
    for (const flight of current.flights) {
      const moment = now().getTime();
      if (moment - Date.parse(flight.addedAt) > FLIGHT_MAX_AGE_MS) {
        alerts.push({
          kind: 'flight',
          title: 'Flight watch',
          text: `I've stopped watching ${flight.callsign}; it didn't land within a day.`,
          priority: 'default',
        });
        continue;
      }
      let status;
      try {
        status = await lookupFlight(flight.callsign);
      } catch {
        kept.push(flight);
        continue;
      }
      if (status && !status.onGround) {
        kept.push({
          ...flight,
          airborne: true,
          lastSeenAt: new Date(moment).toISOString(),
          lastAltitudeFt: status.altitudeFt,
        });
      } else if (status?.onGround && flight.airborne) {
        alerts.push({
          kind: 'flight',
          title: 'Flight landed',
          text: `Flight ${flight.callsign} has landed.`,
          priority: 'high',
        });
      } else if (
        !status &&
        flight.airborne &&
        flight.lastAltitudeFt != null &&
        flight.lastAltitudeFt < APPROACH_ALTITUDE_FT &&
        moment - Date.parse(flight.lastSeenAt) > LOST_ON_APPROACH_MS
      ) {
        alerts.push({
          kind: 'flight',
          title: 'Flight landed',
          text: `Flight ${flight.callsign} has most likely landed; it dropped off radar on approach.`,
          priority: 'high',
        });
      } else kept.push(flight);
    }
    current.flights = kept;
  }

  async function runChecks({ force = false } = {}) {
    const current = await state();
    const before = JSON.stringify(current);
    const alerts = [];
    const home = await settings?.home?.().catch(() => null);
    const hazardsDue =
      force || now().getTime() - lastHazardCheck >= HAZARD_EVERY_MS;
    if (home && hazardsDue) {
      lastHazardCheck = now().getTime();
      await checkQuakes(current, home, alerts).catch(() => {});
      await checkWeather(current, home, alerts).catch(() => {});
    }
    if (current.flights.length) await checkFlights(current, alerts);
    if (JSON.stringify(current) !== before) await store.write(current);
    for (const alert of alerts) {
      try {
        await deliver(alert);
      } catch {
        // One failed delivery must not stop the rest.
      }
    }
    return alerts;
  }

  /** Overlapping checks share one run. */
  function check(options) {
    running ??= runChecks(options).finally(() => {
      running = null;
    });
    return running;
  }

  async function watchFlight(value) {
    const callsign = normalizeCallsign(value);
    if (!callsign)
      return {
        ok: false,
        error: 'Give a flight callsign like UAL123 or BAW283',
      };
    const current = await state();
    if (current.flights.some((flight) => flight.callsign === callsign))
      return { ok: true, watching: callsign, note: 'Already watching it' };
    if (current.flights.length >= MAX_FLIGHTS)
      return { ok: false, error: 'Already watching too many flights' };
    let status = null;
    try {
      status = await lookupFlight(callsign);
    } catch {
      status = null;
    }
    const moment = now().toISOString();
    current.flights.push({
      callsign,
      addedAt: moment,
      airborne: Boolean(status && !status.onGround),
      ...(status && !status.onGround
        ? { lastSeenAt: moment, lastAltitudeFt: status.altitudeFt }
        : {}),
    });
    await store.write(current);
    return {
      ok: true,
      watching: callsign,
      status: describeFlight(callsign, status),
      note: "I'll say so when it lands.",
    };
  }

  async function configure({ type, enabled, minMagnitude, radiusKm }) {
    const current = await state();
    const on = enabled !== false;
    if (type === 'earthquakes') {
      const magnitude = Number(minMagnitude);
      const radius = Number(radiusKm);
      current.alerts.quakes = {
        ...current.alerts.quakes,
        on,
        ...(Number.isFinite(magnitude)
          ? { minMagnitude: Math.min(9, Math.max(1, magnitude)) }
          : {}),
        ...(Number.isFinite(radius)
          ? { radiusKm: Math.min(5000, Math.max(10, radius)) }
          : {}),
        since: now().toISOString(),
      };
      await store.write(current);
      const { minMagnitude: min, radiusKm: km } = current.alerts.quakes;
      return {
        ok: true,
        earthquakeAlerts: on,
        minMagnitude: min,
        radiusKm: km,
      };
    }
    if (type === 'severe_weather') {
      current.alerts.weather = { on };
      await store.write(current);
      return {
        ok: true,
        severeWeatherAlerts: on,
        note: 'US National Weather Service alerts for home',
      };
    }
    return { ok: false, error: 'Unknown alert type' };
  }

  return {
    check,
    watchFlight,
    configure,
    /** Active watches; home alerts count only once there is a home to watch. */
    async list() {
      const current = await state();
      const home = await settings?.home?.().catch(() => null);
      return {
        flights: current.flights.map((flight) => flight.callsign),
        ...(home ? {} : { needsHome: true }),
        earthquakes:
          home && current.alerts.quakes.on
            ? {
                minMagnitude: current.alerts.quakes.minMagnitude,
                radiusKm: current.alerts.quakes.radiusKm,
              }
            : null,
        // NWS alerts cover the United States only.
        severeWeather: Boolean(
          home && usesImperial(home) && current.alerts.weather.on,
        ),
      };
    },
    /** Stop watching flights whose callsign matches ("all" stops every flight). */
    async cancel(match) {
      const needle = String(match || '')
        .trim()
        .toUpperCase()
        .replace(/\s/g, '');
      if (!needle) return [];
      const current = await state();
      const removed = current.flights.filter(
        (flight) =>
          needle === 'ALL' ||
          flight.callsign.includes(needle) ||
          /^FLIGHTS?$/.test(needle),
      );
      if (!removed.length) return [];
      current.flights = current.flights.filter(
        (flight) => !removed.includes(flight),
      );
      await store.write(current);
      return removed.map((flight) => flight.callsign);
    },
    start() {
      if (timer) return;
      void check().catch(() => {});
      timer = setIntervalImpl(() => void check().catch(() => {}), TICK_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
  };
}
