import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchRegionalNews } from '../regional/news.js';
import { fetchNominatimSearch } from '../regional/place.js';
import { createJsonFile, jarvisHome } from './store.js';
import { describeWhen, parseDays, parseLocalDateTime } from './time.js';

const MAX_FACTS = 100;
const MAX_FACT_CHARS = 300;
const MAX_REMINDER_MINUTES = 60 * 24 * 60;

function toolDefinition(name, description, properties, required) {
  return Object.freeze({
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required,
      },
    },
  });
}

/** Server tools anyone on the network may use. */
export const PUBLIC_TOOL_DEFINITIONS = Object.freeze([
  toolDefinition(
    'search_news',
    'Latest news headlines about a place, person, company or topic. Use for current events and "what is happening" questions, then summarize the top stories in a sentence or two.',
    { query: { type: 'string', description: 'Place or topic to search' } },
    ['query'],
  ),
]);

/** Server tools that touch the user's own data: trusted devices only. */
export const PERSONAL_TOOL_DEFINITIONS = Object.freeze([
  toolDefinition(
    'remember_fact',
    'Save a lasting fact about the user (home city, preferences, names). Only when the user asks you to remember something or states a lasting preference.',
    {
      fact: { type: 'string', description: 'The fact, in one short sentence' },
    },
    ['fact'],
  ),
  toolDefinition(
    'forget_fact',
    'Delete saved facts that contain the given words, when the user asks you to forget something.',
    { match: { type: 'string', description: 'Words the fact contains' } },
    ['match'],
  ),
  toolDefinition(
    'set_reminder',
    'Remind the user of something later: spoken on their open Jarvis page and pushed to their phone. Give in_minutes for relative times ("in 20 minutes"), or at for clock times.',
    {
      text: { type: 'string', description: 'What to remind them about' },
      in_minutes: { type: 'number', minimum: 1 },
      at: {
        type: 'string',
        description:
          'The user\'s local clock time exactly as they said it, like "6:47 PM" (next time it comes around) or "2026-09-25 07:30" for another day. Never add a timezone.',
      },
    },
    ['text'],
  ),
  toolDefinition(
    'set_timer',
    'Start a countdown timer that announces itself when done.',
    {
      minutes: { type: 'number', minimum: 0.1, maximum: 1440 },
      label: { type: 'string', description: 'Optional name, e.g. "pasta"' },
    },
    ['minutes'],
  ),
  toolDefinition(
    'list_scheduled',
    'List upcoming reminders, timers and scheduled items.',
    {},
    [],
  ),
  toolDefinition(
    'cancel_scheduled',
    'Cancel reminders or timers whose text contains the given words, or "all".',
    { match: { type: 'string' } },
    ['match'],
  ),
  toolDefinition(
    'set_home',
    'Save the user\'s home location (a city or address) for briefings, alerts and "take me home".',
    { place: { type: 'string' } },
    ['place'],
  ),
  toolDefinition(
    'send_to_phone',
    'Text the user (iMessage and push notification). Sends now, or later when given at or in_minutes, like "text me at 7 PM to practice". The message is sent word for word.',
    {
      message: { type: 'string' },
      in_minutes: { type: 'number', minimum: 1 },
      at: {
        type: 'string',
        description:
          'Local clock time as the user said it, like "7 PM" or "2026-09-25 07:30". Never add a timezone.',
      },
    },
    ['message'],
  ),
  toolDefinition(
    'brief_me',
    "Give the user their briefing now: weather at home, today's calendar, important email, reminders and news. Speak the returned briefing as your reply.",
    {},
    [],
  ),
  toolDefinition(
    'schedule_briefing',
    'Deliver the briefing automatically every day at a local time (replaces any earlier briefing schedule). Cancel it with cancel_scheduled "briefing".',
    {
      time: { type: 'string', description: 'Local 24-hour "HH:MM"' },
      days: {
        type: 'string',
        description:
          '"daily", "weekdays", "weekends" or days like "mon,wed,fri"',
      },
    },
    ['time'],
  ),
  toolDefinition(
    'watch',
    'Set up an alert. type "flight" with a callsign (like UAL123) tells the user when that flight lands. type "earthquakes" or "severe_weather" turns alerts near home on or off (enabled), with optional min_magnitude and radius_km for earthquakes.',
    {
      type: {
        type: 'string',
        enum: ['flight', 'earthquakes', 'severe_weather'],
      },
      callsign: { type: 'string' },
      enabled: { type: 'boolean' },
      min_magnitude: { type: 'number', minimum: 1, maximum: 9 },
      radius_km: { type: 'number', minimum: 10, maximum: 5000 },
    },
    ['type'],
  ),
]);

export const SERVER_TOOL_DEFINITIONS = Object.freeze([
  ...PUBLIC_TOOL_DEFINITIONS,
  ...PERSONAL_TOOL_DEFINITIONS,
]);

const names = (tools) => new Set(tools.map((tool) => tool.function.name));
export const PUBLIC_TOOL_NAMES = names(PUBLIC_TOOL_DEFINITIONS);
export const PERSONAL_TOOL_NAMES = names(PERSONAL_TOOL_DEFINITIONS);
export const SERVER_TOOL_NAMES = names(SERVER_TOOL_DEFINITIONS);

/** Jarvis's settings (home location). */
export function createSettingsStore({
  file = path.join(jarvisHome(), 'jarvis-settings.json'),
  fsImpl,
} = {}) {
  const store = createJsonFile({ file, fsImpl, empty: {} });
  return {
    async home() {
      const home = (await store.read())?.home;
      return home && Number.isFinite(home.lat) && Number.isFinite(home.lon)
        ? home
        : null;
    },
    async setHome(home) {
      await store.write({ ...(await store.read()), home });
    },
  };
}

export function defaultMemoryFile() {
  return path.join(os.homedir(), '.gods-eye-view', 'agent-memory.json');
}

function cleanText(value, limit) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Facts the agent keeps about the user, outside the repo and Vite's served root. */
export function createMemoryStore({
  file = defaultMemoryFile(),
  fsImpl = fs,
} = {}) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(await fsImpl.readFile(file, 'utf8'));
      cache = (Array.isArray(data?.facts) ? data.facts : []).filter(
        (fact) => typeof fact?.text === 'string' && fact.text,
      );
    } catch {
      cache = [];
    }
    return cache;
  }

  async function save(facts) {
    await fsImpl.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsImpl.writeFile(temporary, JSON.stringify({ facts }, null, 2), {
      mode: 0o600,
    });
    await fsImpl.rename(temporary, file);
    cache = facts;
  }

  return {
    async list() {
      return (await load()).map((fact) => fact.text);
    },
    async remember(value) {
      const text = cleanText(value, MAX_FACT_CHARS);
      if (!text) return { ok: false, error: 'Nothing to remember' };
      const facts = await load();
      if (facts.some((fact) => fact.text.toLowerCase() === text.toLowerCase()))
        return { ok: true, remembered: text };
      await save(
        [...facts, { text, savedAt: new Date().toISOString() }].slice(
          -MAX_FACTS,
        ),
      );
      return { ok: true, remembered: text };
    },
    async forget(value) {
      const needle = cleanText(value, MAX_FACT_CHARS).toLowerCase();
      if (!needle) return { ok: false, error: 'Say what to forget' };
      const facts = await load();
      const kept = facts.filter(
        (fact) => !fact.text.toLowerCase().includes(needle),
      );
      if (kept.length !== facts.length) await save(kept);
      return { ok: true, forgotten: facts.length - kept.length };
    },
  };
}

async function searchNews(args, { fetchNews = fetchRegionalNews } = {}) {
  const query = cleanText(args?.query, 120);
  if (!query) return { ok: false, error: 'No search query' };
  const news = await fetchNews({ locality: query });
  return {
    ok: news.status === 'ready',
    query,
    status: news.status,
    source: news.source,
    articles: (news.articles || []).slice(0, 5).map((article) => ({
      title: article.title,
      source: article.domain || null,
      published: article.publishedAt || null,
    })),
  };
}

function reminderTime(args, now, timeZone) {
  const minutes = Number(args?.in_minutes);
  if (Number.isFinite(minutes) && minutes > 0)
    return minutes <= MAX_REMINDER_MINUTES
      ? new Date(now.getTime() + minutes * 60_000)
      : null;
  return args?.at ? parseLocalDateTime(args.at, timeZone, now) : null;
}

async function setReminder(args, { scheduler, now, timeZone }) {
  const text = cleanText(args?.text, 200);
  if (!text) return { ok: false, error: 'What should I remind you about?' };
  const at = reminderTime(args, now, timeZone);
  if (!at) return { ok: false, error: 'That time could not be understood' };
  const result = await scheduler.add({ kind: 'reminder', text, at });
  return result.ok
    ? { ok: true, reminder: text, when: describeWhen(at, now, timeZone) }
    : result;
}

/** Text the user now, or schedule the text for a time they gave. */
async function sendToPhone(args, { notifier, scheduler, now, timeZone }) {
  const message = cleanText(args?.message, 500);
  if (!message) return { ok: false, error: 'What should the text say?' };
  if (args?.at == null && args?.in_minutes == null)
    return notifier.push({ message });
  const at = reminderTime(args, now, timeZone);
  if (!at) return { ok: false, error: 'That time could not be understood' };
  const result = await scheduler.add({ kind: 'text', text: message, at });
  return result.ok
    ? { ok: true, scheduled: message, when: describeWhen(at, now, timeZone) }
    : result;
}

async function setTimer(args, { scheduler, now, timeZone }) {
  const minutes = Number(args?.minutes);
  if (!Number.isFinite(minutes) || minutes < 0.1 || minutes > 1440)
    return { ok: false, error: 'Timers run from 6 seconds to 24 hours' };
  const label = cleanText(args?.label, 60);
  const at = new Date(now.getTime() + minutes * 60_000);
  const result = await scheduler.add({ kind: 'timer', text: label, at });
  return result.ok
    ? {
        ok: true,
        timer: label || null,
        minutes,
        ends: describeWhen(at, now, timeZone),
      }
    : result;
}

async function listScheduled({ scheduler, watchers, now, timeZone }) {
  const jobs = (await scheduler.list()).slice(0, 20);
  return {
    ok: true,
    count: jobs.length,
    items: jobs.map((job) => ({
      kind: job.kind,
      text: job.text || null,
      when: describeWhen(new Date(job.nextAt), now, timeZone),
      ...(job.repeat ? { repeats: true } : {}),
    })),
    ...(watchers ? { watches: await watchers.list() } : {}),
  };
}

async function cancelScheduled(args, { scheduler, watchers }) {
  const result = await scheduler.cancel(args?.match);
  if (!result.ok) return result;
  const flights = watchers ? await watchers.cancel(args?.match) : [];
  return {
    ok: true,
    cancelled: result.cancelled.length + flights.length,
    items: [
      ...result.cancelled.map(
        (job) => `${job.kind}${job.text ? `: ${job.text}` : ''}`,
      ),
      ...flights.map((callsign) => `flight watch: ${callsign}`),
    ],
  };
}

async function scheduleBriefing(args, { scheduler, now, timeZone }) {
  const time = String(args?.time || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    return { ok: false, error: 'Give the time as 24-hour HH:MM' };
  const days = parseDays(
    args?.days ? String(args.days).toLowerCase() : 'daily',
  );
  if (!days) return { ok: false, error: 'Those days could not be understood' };
  await scheduler.cancel('briefing', { kind: 'briefing' });
  const result = await scheduler.add({
    kind: 'briefing',
    text: 'Daily briefing',
    repeat: { time: `${match[1].padStart(2, '0')}:${match[2]}`, days },
  });
  return result.ok
    ? {
        ok: true,
        briefing: 'scheduled',
        next: describeWhen(new Date(result.job.nextAt), now, timeZone),
      }
    : result;
}

async function watch(args, { watchers }) {
  if (!watchers) return { ok: false, error: 'Alerts are not running' };
  if (args?.type === 'flight') return watchers.watchFlight(args?.callsign);
  return watchers.configure({
    type: args?.type,
    enabled: args?.enabled,
    minMagnitude: args?.min_magnitude,
    radiusKm: args?.radius_km,
  });
}

async function setHome(args, { settings, geocode = fetchNominatimSearch }) {
  const place = cleanText(args?.place, 120);
  if (!place) return { ok: false, error: 'Which place is home?' };
  let result;
  try {
    result = (await geocode(place))?.results?.[0];
  } catch {
    result = null;
  }
  const location = result?.geometry?.location;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng))
    return { ok: false, error: `I couldn't find ${place}` };
  const home = {
    name: place,
    address: String(result.formatted_address || place).slice(0, 200),
    lat: location.lat,
    lon: location.lng,
  };
  await settings.setHome(home);
  return { ok: true, home: home.name, address: home.address };
}

/** Run one server tool; unknown names are refused rather than guessed. */
export async function runServerTool(name, args, deps = {}) {
  const context = {
    now: new Date(),
    timeZone: 'UTC',
    ...deps,
  };
  if (name === 'search_news')
    return searchNews(args, { fetchNews: deps.fetchNews });
  if (name === 'remember_fact') return deps.memory.remember(args?.fact);
  if (name === 'forget_fact') return deps.memory.forget(args?.match);
  if (name === 'set_reminder') return setReminder(args, context);
  if (name === 'set_timer') return setTimer(args, context);
  if (name === 'list_scheduled') return listScheduled(context);
  if (name === 'cancel_scheduled') return cancelScheduled(args, context);
  if (name === 'set_home') return setHome(args, context);
  if (name === 'send_to_phone') return sendToPhone(args, context);
  if (name === 'brief_me') {
    if (!deps.briefing)
      return { ok: false, error: 'Briefings are not running' };
    const { text } = await deps.briefing.brief();
    return { ok: true, briefing: text };
  }
  if (name === 'schedule_briefing') return scheduleBriefing(args, context);
  if (name === 'watch') return watch(args, context);
  return { ok: false, error: `Unknown server tool ${name}` };
}
