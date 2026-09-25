import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeWhen,
  localTimeZone,
  nextDailyOccurrence,
  parseDays,
  parseLocalDateTime,
  zonedParts,
  zonedTimeToDate,
} from '../../server/providers/voice-agent/time.js';
import { createScheduler } from '../../server/providers/voice-agent/scheduler.js';

const LA = 'America/Los_Angeles';

test('local wall times convert to instants, across daylight saving', () => {
  // PDT (UTC-7) in September, PST (UTC-8) in December.
  assert.equal(
    zonedTimeToDate(
      { year: 2026, month: 9, day: 23, hour: 19, minute: 0 },
      LA,
    ).toISOString(),
    '2026-09-24T02:00:00.000Z',
  );
  assert.equal(
    zonedTimeToDate(
      { year: 2026, month: 12, day: 1, hour: 7, minute: 30 },
      LA,
    ).toISOString(),
    '2026-12-01T15:30:00.000Z',
  );
  // 2:30 AM does not exist on the spring-forward day; it rolls forward.
  const gap = zonedTimeToDate(
    { year: 2027, month: 3, day: 14, hour: 2, minute: 30 },
    LA,
  );
  assert.equal(zonedParts(gap, LA).hour, 3);
  assert.equal(
    zonedParts(new Date('2026-09-24T02:00:00Z'), LA).weekday,
    3,
    'Wednesday',
  );
});

test("model times are always the user's local wall time", () => {
  const seven = '2026-09-24T02:00:00.000Z'; // 7:00 PM PDT on the 23rd
  for (const given of [
    '2026-09-23 19:00',
    '2026-09-23T19:00',
    '2026-09-23T19:00:00',
    '2026-09-23 7:00 PM',
    // A zone the model attached is ignored: it moved reminders by hours.
    '2026-09-23T19:00:00Z',
    '2026-09-23T19:00:00-05:00',
    '2026-09-23 19:00 CDT',
  ])
    assert.equal(parseLocalDateTime(given, LA).toISOString(), seven, given);
  for (const bad of [
    'tomorrow',
    '2026-13-01 10:00',
    '2026-09-23 25:00',
    '7',
    '13 pm',
    '',
  ])
    assert.equal(parseLocalDateTime(bad, LA), null, bad);
});

test('a bare clock time means the next time it comes around', () => {
  const afternoon = new Date('2026-09-23T20:00:00Z'); // 1 PM PDT
  const at = (text) => parseLocalDateTime(text, LA, afternoon).toISOString();
  assert.equal(at('6:47 PM'), '2026-09-24T01:47:00.000Z', 'later today');
  assert.equal(at('18:47'), '2026-09-24T01:47:00.000Z');
  assert.equal(at('6pm'), '2026-09-24T01:00:00.000Z');
  assert.equal(at('7:30 a.m.'), '2026-09-24T14:30:00.000Z', 'tomorrow');
  assert.equal(at('12 am'), '2026-09-24T07:00:00.000Z', 'midnight');
  assert.equal(
    at('12:15 pm'),
    '2026-09-24T19:15:00.000Z',
    'passed, so tomorrow',
  );
});

test('daily schedules find their next run on the right days', () => {
  const wednesdayEvening = new Date('2026-09-24T02:00:00Z'); // Wed 7 PM PDT
  const weekdays = { time: '07:30', days: parseDays('weekdays') };
  assert.equal(
    nextDailyOccurrence(weekdays, wednesdayEvening, LA).toISOString(),
    '2026-09-24T14:30:00.000Z',
    'Thursday 7:30 AM PDT',
  );
  const fridayEvening = new Date('2026-09-26T02:00:00Z');
  assert.equal(
    nextDailyOccurrence(weekdays, fridayEvening, LA).toISOString(),
    '2026-09-28T14:30:00.000Z',
    'skips the weekend to Monday',
  );
  assert.deepEqual(parseDays('mon, wed friday'), [1, 3, 5]);
  assert.deepEqual(parseDays(undefined), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(parseDays('someday'), null);
});

test('times read naturally', () => {
  const now = new Date('2026-09-23T20:00:00Z'); // Wed 1 PM PDT
  assert.equal(
    describeWhen(new Date('2026-09-23T22:00:00Z'), now, LA),
    'at 3:00 PM',
  );
  assert.equal(
    describeWhen(new Date('2026-09-24T15:00:00Z'), now, LA),
    'tomorrow at 8:00 AM',
  );
  assert.equal(
    describeWhen(new Date('2026-09-26T16:00:00Z'), now, LA),
    'on Saturday, September 26 at 9:00 AM',
  );
  assert.equal(localTimeZone({ GEV_TIMEZONE: 'Not/AZone' }), 'UTC');
  assert.equal(
    localTimeZone({ GEV_TIMEZONE: 'Europe/London' }),
    'Europe/London',
  );
});

function memoryFs() {
  const files = new Map();
  return {
    files,
    async readFile(file) {
      if (!files.has(file))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    async mkdir() {},
    async writeFile(file, text) {
      files.set(file, text);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function schedulerAt(start, fsImpl = memoryFs()) {
  let clock = new Date(start);
  const delivered = [];
  const scheduler = createScheduler({
    file: '/jarvis/jobs.json',
    fsImpl,
    now: () => clock,
    timeZone: () => LA,
    deliver: async (job) => delivered.push(job.text),
  });
  return {
    scheduler,
    delivered,
    fsImpl,
    advanceTo: (iso) => {
      clock = new Date(iso);
    },
  };
}

test('one-off jobs fire once when due and survive a restart', async () => {
  const h = schedulerAt('2026-09-23T20:00:00Z');
  assert.equal(
    (
      await h.scheduler.add({
        kind: 'reminder',
        text: 'stretch',
        at: new Date('2026-09-23T20:10:00Z'),
      })
    ).ok,
    true,
  );
  await h.scheduler.tick();
  assert.deepEqual(h.delivered, []);

  const restarted = schedulerAt('2026-09-23T20:10:05Z', h.fsImpl);
  assert.equal(
    (await restarted.scheduler.list()).length,
    1,
    'jobs are on disk',
  );
  await restarted.scheduler.tick();
  await restarted.scheduler.tick();
  assert.deepEqual(restarted.delivered, ['stretch'], 'delivered exactly once');
  assert.deepEqual(await restarted.scheduler.list(), []);
});

test('jobs missed by more than an hour are dropped, not fired late', async () => {
  const h = schedulerAt('2026-09-23T20:00:00Z');
  await h.scheduler.add({
    kind: 'reminder',
    text: 'old',
    at: new Date('2026-09-23T20:05:00Z'),
  });
  h.advanceTo('2026-09-23T22:00:00Z');
  await h.scheduler.tick();
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(await h.scheduler.list(), []);
});

test('daily jobs fire and move to their next day', async () => {
  const h = schedulerAt('2026-09-23T20:00:00Z');
  const added = await h.scheduler.add({
    kind: 'reminder',
    text: 'meds',
    repeat: { time: '14:00', days: [0, 1, 2, 3, 4, 5, 6] },
  });
  assert.equal(added.job.nextAt, '2026-09-23T21:00:00.000Z');
  h.advanceTo('2026-09-23T21:00:30Z');
  await h.scheduler.tick();
  assert.deepEqual(h.delivered, ['meds']);
  assert.equal(
    (await h.scheduler.list())[0].nextAt,
    '2026-09-24T21:00:00.000Z',
  );
});

test('past times are refused, and cancelling matches by words', async () => {
  const h = schedulerAt('2026-09-23T20:00:00Z');
  assert.deepEqual(
    await h.scheduler.add({
      kind: 'reminder',
      text: 'late',
      at: new Date('2026-09-23T19:00:00Z'),
    }),
    { ok: false, error: 'That time has already passed' },
  );
  await h.scheduler.add({
    kind: 'timer',
    text: 'pasta',
    at: new Date('2026-09-23T20:09:00Z'),
  });
  await h.scheduler.add({
    kind: 'reminder',
    text: 'call Sam',
    at: new Date('2026-09-23T21:00:00Z'),
  });
  const pasta = await h.scheduler.cancel('PASTA');
  assert.deepEqual(
    pasta.cancelled.map((job) => job.text),
    ['pasta'],
  );
  assert.equal((await h.scheduler.cancel('all')).cancelled.length, 1);
  assert.deepEqual(await h.scheduler.cancel(' '), {
    ok: false,
    error: 'Say what to cancel',
  });
});

test('a failing delivery does not wedge the queue', async () => {
  const fsImpl = memoryFs();
  const scheduler = createScheduler({
    file: '/jarvis/jobs.json',
    fsImpl,
    now: () => new Date('2026-09-23T20:10:00Z'),
    timeZone: () => LA,
    deliver: async () => {
      throw new Error('phone offline');
    },
  });
  await createScheduler({
    file: '/jarvis/jobs.json',
    fsImpl,
    now: () => new Date('2026-09-23T20:00:00Z'),
  }).add({ kind: 'timer', text: 'tea', at: new Date('2026-09-23T20:05:00Z') });
  await scheduler.tick();
  assert.deepEqual(await scheduler.list(), []);
});
