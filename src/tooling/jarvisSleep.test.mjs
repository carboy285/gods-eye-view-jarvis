import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { isSleepCommand, isWakeCommand } from '../voice/sleepCommands.js';
import {
  createScreenControl,
  createSleepMode,
} from '../../server/providers/voice-agent/sleep.js';
import {
  createJarvisSleepHandler,
  createTextAgent,
} from '../../server/providers/voice-agent.js';

const CHICAGO = 'America/Chicago';
// Thursday 10:30 PM in Chicago.
const NIGHT = new Date('2026-09-25T03:30:00Z');

function memoryFs() {
  const files = new Map();
  return {
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

function sleepHarness({ env = {}, start = NIGHT } = {}) {
  let clock = start;
  const broadcasts = [];
  const screenOffs = [];
  const sleepMode = createSleepMode({
    file: '/jarvis/sleep.json',
    fsImpl: memoryFs(),
    env,
    now: () => clock,
    timeZone: () => CHICAGO,
    announcer: {
      broadcast: (event, data) => broadcasts.push([event, data]),
    },
    screen: { turnOff: () => (screenOffs.push(true), true) },
  });
  return {
    sleepMode,
    broadcasts,
    screenOffs,
    advanceTo: (iso) => {
      clock = new Date(iso);
    },
  };
}

test('goodnight and good morning phrases', () => {
  for (const phrase of [
    'Goodnight, Jarvis.',
    'good night',
    'Jarvis goodnight',
    "I'm going to bed",
    'I’m going to sleep',
    'go to sleep',
    'Sleep mode',
    'time for bed',
    'Hey Jarvis, night night!',
  ])
    assert.equal(isSleepCommand(phrase), true, phrase);
  for (const phrase of [
    'goodnight moon lyrics',
    'how do I go to sleep faster',
    'sleep',
    'stand by',
  ])
    assert.equal(isSleepCommand(phrase), false, phrase);
  for (const phrase of [
    'Good morning, Jarvis',
    'wake up',
    "I'm up",
    'I am awake',
  ])
    assert.equal(isWakeCommand(phrase), true, phrase);
  assert.equal(isWakeCommand('good morning in Spanish'), false);
});

test('sleep lasts until 7 AM local, blacks out pages and turns the screen off', async () => {
  const h = sleepHarness();
  const { until, screenOff } = await h.sleepMode.sleep();
  // 7:00 AM CDT Friday.
  assert.equal(until.toISOString(), '2026-09-25T12:00:00.000Z');
  assert.equal(screenOff, true);
  assert.deepEqual(h.broadcasts, [
    ['sleep', { until: '2026-09-25T12:00:00.000Z' }],
  ]);
  assert.equal(await h.sleepMode.isAsleep(), true);

  h.advanceTo('2026-09-25T12:00:01Z');
  assert.equal(await h.sleepMode.isAsleep(), false, 'awake at 7 on its own');

  const custom = sleepHarness({ env: { GEV_WAKE_TIME: '6:15' } });
  assert.equal(
    (await custom.sleepMode.sleep()).until.toISOString(),
    '2026-09-25T11:15:00.000Z',
  );
});

test('asleep, only what you scheduled and real emergencies get through', async () => {
  const h = sleepHarness();
  assert.equal(await h.sleepMode.allows('earthquake', 'default'), true);
  await h.sleepMode.sleep();
  assert.equal(await h.sleepMode.allows('reminder', 'default'), true);
  assert.equal(await h.sleepMode.allows('timer', 'high'), true);
  assert.equal(await h.sleepMode.allows('briefing'), true);
  assert.equal(await h.sleepMode.allows('weather', 'high'), true);
  assert.equal(await h.sleepMode.allows('earthquake', 'high'), true);
  assert.equal(await h.sleepMode.allows('earthquake', 'default'), false);
  assert.equal(await h.sleepMode.allows('flight', 'high'), false);

  assert.deepEqual(await h.sleepMode.wake(), { ok: true, wasAsleep: true });
  assert.deepEqual(h.broadcasts.at(-1), ['wake', {}]);
  assert.equal(await h.sleepMode.allows('flight', 'high'), true);
  await h.sleepMode.wake();
  assert.equal(h.broadcasts.length, 2, 'no wake broadcast when already up');
});

test('the screen turns off through PowerShell on Windows only, after a pause', () => {
  const spawned = [];
  const timers = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  };
  const setTimeoutImpl = (callback, ms) => {
    timers.push(ms);
    callback();
    return { unref() {} };
  };
  const windows = createScreenControl({
    env: {},
    platform: 'win32',
    spawnImpl,
    setTimeoutImpl,
  });
  assert.equal(windows.turnOff(), true);
  assert.deepEqual(timers, [4_000]);
  assert.equal(spawned[0].command, 'powershell.exe');
  assert.equal(spawned[0].options.windowsHide, true);
  assert.match(
    spawned[0].args.at(-1),
    /PostMessage\(0xffff, 0x0112, 0xF170, 2\)/,
  );

  for (const control of [
    createScreenControl({ env: {}, platform: 'darwin', spawnImpl }),
    createScreenControl({
      env: { GEV_SCREEN_OFF: '0' },
      platform: 'win32',
      spawnImpl,
    }),
  ])
    assert.equal(control.turnOff(), false);
  assert.equal(spawned.length, 1);
});

test('texting goodnight and good morning works instantly, without the AI', async () => {
  const h = sleepHarness();
  const agent = createTextAgent({
    fetchImpl: async () => {
      throw new Error('the AI must not be called');
    },
    memory: { list: async () => [] },
    settings: { home: async () => null },
    composio: { configured: () => false },
    sleepMode: h.sleepMode,
  });
  assert.match(
    await agent('Goodnight Jarvis'),
    /^Goodnight\. Screen's off and I'm going quiet until \d{1,2}:00 [AP]M\./,
  );
  assert.equal(h.screenOffs.length, 1);
  assert.match(await agent('good morning'), /^Good morning\. I'm back on\./);
  assert.equal(await h.sleepMode.isAsleep(), false);
});

test('the sleep route is for your own devices only', async () => {
  const h = sleepHarness();
  const call = async (remoteAddress, body) => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', socket: { remoteAddress } });
    const res = {
      setHeader() {},
      end(text) {
        this.body = JSON.parse(text);
      },
    };
    const done = createJarvisSleepHandler({ sleepMode: h.sleepMode })(req, res);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    await done;
    return res;
  };
  assert.equal(
    (await call('192.168.1.77', { action: 'sleep' })).statusCode,
    403,
  );
  assert.equal(await h.sleepMode.isAsleep(), false);
  const slept = await call('127.0.0.1', { action: 'sleep' });
  assert.equal(slept.statusCode, 200);
  assert.equal(slept.body.sleeping, true);
  assert.equal((await call('::1', { action: 'status' })).body.sleeping, true);
  assert.equal(
    (await call('127.0.0.1', { action: 'wake' })).body.sleeping,
    false,
  );
  assert.equal((await call('127.0.0.1', { action: 'dance' })).statusCode, 400);
});
