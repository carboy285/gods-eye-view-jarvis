/** Local-time helpers for a named IANA zone, using only Intl (no tz database copy). */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function localTimeZone(env = process.env) {
  const configured = String(env.GEV_TIMEZONE || '').trim();
  const zone =
    configured || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday.slice(0, 3).toLowerCase()),
  };
}

/** The instant a wall-clock time happens in a zone (DST gaps roll forward). */
export function zonedTimeToDate({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let pass = 0; pass < 3; pass++) {
    const seen = zonedParts(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
    );
    const drift = seenAsUtc - target;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/**
 * Parse a time the model gave. Strings with an offset or Z are absolute;
 * "YYYY-MM-DD HH:MM" (or with T) is local wall time in the zone.
 */
/** "18:47", "6:47 pm", "6pm" → 24-hour {hour, minute}, or null. */
function parseClock(text) {
  const match =
    /^(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*([ap])?\.?\s*m?\.?$/i.exec(
      text.trim(),
    );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3]?.toLowerCase();
  if (!half && match[2] === undefined) return null; // a bare "7" is not a time
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'p' ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

/**
 * A time the model gave, always as the user's local wall time. Any "Z" or
 * UTC offset is ignored: small models attach the wrong zone, which moved
 * reminders by hours. "YYYY-MM-DD HH:MM" is that day; a bare "6:47 PM" or
 * "18:47" is its next occurrence after `now`.
 */
export function parseLocalDateTime(value, timeZone, now = new Date()) {
  const text = String(value || '')
    .trim()
    .replace(/(?:Z|[+-]\d{2}:?\d{2}|\s*(?:UTC|GMT|[ECMP][SD]T))$/i, '');
  const dated = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/.exec(text);
  if (dated) {
    const [year, month, day] = dated.slice(1, 4).map(Number);
    const clock = dated[4] ? parseClock(dated[4]) : null;
    if (!clock || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return zonedTimeToDate({ year, month, day, ...clock }, timeZone);
  }
  const clock = parseClock(text);
  if (!clock) return null;
  const today = zonedParts(now, timeZone);
  const at = zonedTimeToDate(
    { year: today.year, month: today.month, day: today.day, ...clock },
    timeZone,
  );
  if (at > now) return at;
  const tomorrow = new Date(
    Date.UTC(today.year, today.month - 1, today.day + 1),
  );
  return zonedTimeToDate(
    {
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
      ...clock,
    },
    timeZone,
  );
}

export function parseDays(days) {
  if (days == null || days === 'daily' || days === 'every day')
    return [0, 1, 2, 3, 4, 5, 6];
  if (days === 'weekdays') return [1, 2, 3, 4, 5];
  if (days === 'weekends') return [0, 6];
  const list = (Array.isArray(days) ? days : String(days).split(/[\s,]+/))
    .map((day) => WEEKDAYS.indexOf(String(day).slice(0, 3).toLowerCase()))
    .filter((index) => index >= 0);
  return list.length ? [...new Set(list)].sort() : null;
}

/** Next instant after `after` when a daily "HH:MM" schedule on `days` fires. */
export function nextDailyOccurrence({ time, days }, after, timeZone) {
  const [hour, minute] = String(time).split(':').map(Number);
  const today = zonedParts(after, timeZone);
  for (let offset = 0; offset <= 7; offset++) {
    const calendar = new Date(
      Date.UTC(today.year, today.month - 1, today.day + offset),
    );
    if (!days.includes(calendar.getUTCDay())) continue;
    const candidate = zonedTimeToDate(
      {
        year: calendar.getUTCFullYear(),
        month: calendar.getUTCMonth() + 1,
        day: calendar.getUTCDate(),
        hour,
        minute,
      },
      timeZone,
    );
    if (candidate > after) return candidate;
  }
  return null;
}

/** "at 3:00 PM", "tomorrow at 7:30 AM", or "on Friday, September 25 at 9:00 AM". */
export function describeWhen(date, now, timeZone) {
  const clock = date.toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const day = (instant) => {
    const { year, month, day: dayOfMonth } = zonedParts(instant, timeZone);
    return Date.UTC(year, month - 1, dayOfMonth);
  };
  const days = Math.round((day(date) - day(now)) / 86_400_000);
  if (days === 0) return `at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  const longDate = date.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return `on ${longDate} at ${clock}`;
}
