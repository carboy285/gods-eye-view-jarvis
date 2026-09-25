import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createPhoneNotifier } from '../../server/providers/voice-agent/notify.js';
import {
  createAnnouncer,
  isValidClientId,
} from '../../server/providers/voice-agent/announcer.js';
import {
  PERSONAL_TOOL_NAMES,
  PUBLIC_TOOL_NAMES,
  runServerTool,
} from '../../server/providers/voice-agent/tools.js';

test('phone pushes go to the ntfy topic as JSON', async () => {
  const calls = [];
  const notifier = createPhoneNotifier({
    env: { NTFY_TOPIC: 'gev-jarvis-abc123', NTFY_TOKEN: 'tk_secret' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(notifier.configured(), true);
  assert.deepEqual(
    await notifier.push({
      title: 'Timer',
      message: '  Tea is ready.  ',
      priority: 'high',
    }),
    { ok: true, sent: 'Tea is ready.' },
  );
  assert.equal(calls[0].url, 'https://ntfy.sh/');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tk_secret');
  assert.deepEqual(calls[0].body, {
    topic: 'gev-jarvis-abc123',
    title: 'Timer',
    message: 'Tea is ready.',
    priority: 4,
    tags: ['robot'],
  });
});

test('phone pushes fail softly without a valid topic or on errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const none = createPhoneNotifier({ env: {} });
  assert.equal(none.configured(), false);
  assert.equal((await none.push({ message: 'hi' })).ok, false);
  const bad = createPhoneNotifier({ env: { NTFY_TOPIC: 'has spaces/../x' } });
  assert.equal(bad.configured(), false);
  const down = createPhoneNotifier({
    env: { NTFY_TOPIC: 'gev-jarvis', NTFY_SERVER: 'https://push.example/' },
    fetchImpl: async (url) => {
      assert.equal(url, 'https://push.example/');
      return new Response('', { status: 500 });
    },
  });
  assert.deepEqual(await down.push({ message: 'hi' }), {
    ok: false,
    error: 'The phone notification failed',
  });
});

function fakeClient() {
  const req = new EventEmitter();
  const res = {
    writes: [],
    ended: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    write(chunk) {
      this.writes.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
  return { req, res };
}

const announcements = (res) =>
  res.writes
    .filter((chunk) => chunk.startsWith('event: announcement'))
    .map((chunk) => JSON.parse(chunk.split('data: ')[1]));

test('announcements reach every page; only the active one speaks', () => {
  const announcer = createAnnouncer({
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  const pc = fakeClient();
  const mac = fakeClient();
  announcer.connect('pc-00000001', pc.req, pc.res);
  announcer.connect('mac-0000001', mac.req, mac.res);
  assert.equal(
    pc.res.headers['Content-Type'],
    'text/event-stream; charset=utf-8',
  );

  announcer.announce({ kind: 'reminder', text: 'Reminder: stretch' });
  assert.equal(announcements(pc.res)[0].speak, false);
  assert.equal(
    announcements(mac.res)[0].speak,
    true,
    'the newest page speaks by default',
  );

  assert.equal(announcer.claimSpeaker('pc-00000001'), true);
  announcer.announce({ kind: 'timer', text: 'Your timer is done.' });
  assert.equal(announcements(pc.res)[1].speak, true);
  assert.equal(announcements(mac.res)[1].speak, false);

  pc.req.emit('close');
  assert.equal(announcer.clientCount(), 1);
  announcer.announce({ text: 'Again' });
  assert.equal(
    announcements(mac.res)[2].speak,
    true,
    'falls back when the speaker leaves',
  );
  assert.equal(announcer.claimSpeaker('ghost-000001'), false);
  assert.equal(isValidClientId('abc'), false);
  assert.equal(isValidClientId('3f2b8c1e-8f0e-4c3a-9a55-1a2b3c4d5e6f'), true);
});

function fakeScheduler() {
  const jobs = [];
  return {
    jobs,
    async add(job) {
      jobs.push(job);
      return { ok: true, job };
    },
    async list() {
      return [
        { kind: 'timer', text: 'pasta', nextAt: '2026-09-23T20:09:00.000Z' },
        {
          kind: 'reminder',
          text: 'meds',
          nextAt: '2026-09-24T15:00:00.000Z',
          repeat: {},
        },
      ];
    },
    async cancel(match) {
      return {
        ok: true,
        cancelled: match === 'pasta' ? [{ kind: 'timer', text: 'pasta' }] : [],
      };
    },
  };
}

const LA = 'America/Los_Angeles';
const NOW = new Date('2026-09-23T20:00:00Z'); // Wednesday 1 PM PDT

test('reminders accept relative minutes or local clock times', async () => {
  const scheduler = fakeScheduler();
  const deps = { scheduler, now: NOW, timeZone: LA };
  assert.deepEqual(
    await runServerTool(
      'set_reminder',
      { text: 'stretch', in_minutes: 20 },
      deps,
    ),
    {
      ok: true,
      reminder: 'stretch',
      when: 'at 1:20 PM',
    },
  );
  assert.deepEqual(
    await runServerTool(
      'set_reminder',
      { text: 'call Sam', at: '2026-09-24 09:00' },
      deps,
    ),
    { ok: true, reminder: 'call Sam', when: 'tomorrow at 9:00 AM' },
  );
  assert.equal(scheduler.jobs[1].at.toISOString(), '2026-09-24T16:00:00.000Z');
  assert.equal(
    (await runServerTool('set_reminder', { text: 'x', at: 'soonish' }, deps))
      .ok,
    false,
  );
  assert.equal(
    (await runServerTool('set_reminder', { in_minutes: 5 }, deps)).ok,
    false,
  );
});

test('timers, listing and cancelling', async () => {
  const scheduler = fakeScheduler();
  const deps = { scheduler, now: NOW, timeZone: LA };
  assert.deepEqual(
    await runServerTool('set_timer', { minutes: 9, label: 'pasta' }, deps),
    {
      ok: true,
      timer: 'pasta',
      minutes: 9,
      ends: 'at 1:09 PM',
    },
  );
  assert.equal(scheduler.jobs[0].kind, 'timer');
  assert.equal(
    (await runServerTool('set_timer', { minutes: 5000 }, deps)).ok,
    false,
  );
  const listed = await runServerTool('list_scheduled', {}, deps);
  assert.deepEqual(listed.items, [
    { kind: 'timer', text: 'pasta', when: 'at 1:09 PM' },
    {
      kind: 'reminder',
      text: 'meds',
      when: 'tomorrow at 8:00 AM',
      repeats: true,
    },
  ]);
  assert.deepEqual(
    await runServerTool('cancel_scheduled', { match: 'pasta' }, deps),
    {
      ok: true,
      cancelled: 1,
      items: ['timer: pasta'],
    },
  );
});

test('home is geocoded and saved; phone notes go out', async () => {
  let saved = null;
  const settings = { setHome: async (home) => (saved = home) };
  const geocode = async (query) => {
    assert.equal(query, 'Austin');
    return {
      status: 'OK',
      results: [
        {
          geometry: { location: { lat: 30.2711, lng: -97.7437 } },
          formatted_address: 'Austin, Travis County, Texas, United States',
        },
      ],
    };
  };
  assert.deepEqual(
    await runServerTool('set_home', { place: 'Austin' }, { settings, geocode }),
    {
      ok: true,
      home: 'Austin',
      address: 'Austin, Travis County, Texas, United States',
    },
  );
  assert.deepEqual(saved, {
    name: 'Austin',
    address: 'Austin, Travis County, Texas, United States',
    lat: 30.2711,
    lon: -97.7437,
  });
  const nowhere = await runServerTool(
    'set_home',
    { place: 'Atlantis' },
    {
      settings,
      geocode: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    },
  );
  assert.equal(nowhere.ok, false);

  const pushed = [];
  const notifier = { push: async (note) => (pushed.push(note), { ok: true }) };
  await runServerTool('send_to_phone', { message: 'Buy milk' }, { notifier });
  assert.deepEqual(pushed, [{ message: 'Buy milk' }]);
});

test('news stays public; everything personal is marked personal', () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ['search_news']);
  assert.deepEqual(
    [...PERSONAL_TOOL_NAMES],
    [
      'remember_fact',
      'forget_fact',
      'set_reminder',
      'set_timer',
      'list_scheduled',
      'cancel_scheduled',
      'set_home',
      'send_to_phone',
      'brief_me',
      'schedule_briefing',
      'watch',
    ],
  );
});

test('"text me at 6:47" schedules the text instead of sending it now', async () => {
  const scheduler = fakeScheduler();
  const pushed = [];
  const notifier = { push: async (note) => (pushed.push(note), { ok: true }) };
  const deps = { scheduler, notifier, now: NOW, timeZone: LA };
  assert.deepEqual(
    await runServerTool(
      'send_to_phone',
      { message: 'Time to practice', at: '6:47 PM' },
      deps,
    ),
    { ok: true, scheduled: 'Time to practice', when: 'at 6:47 PM' },
  );
  assert.equal(pushed.length, 0, 'nothing goes out now');
  assert.equal(scheduler.jobs[0].kind, 'text');
  assert.equal(scheduler.jobs[0].at.toISOString(), '2026-09-24T01:47:00.000Z');
  await runServerTool(
    'send_to_phone',
    { message: 'Stretch', in_minutes: 20 },
    deps,
  );
  assert.equal(scheduler.jobs[1].at.toISOString(), '2026-09-23T20:20:00.000Z');
  assert.equal(
    (await runServerTool('send_to_phone', { message: 'x', at: 'later' }, deps))
      .ok,
    false,
  );
  await runServerTool('send_to_phone', { message: 'Now please' }, deps);
  assert.deepEqual(pushed, [{ message: 'Now please' }]);
});
