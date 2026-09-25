import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIMessageBridge,
  phoneKey,
} from '../../server/providers/voice-agent/imessage.js';
import {
  combinePhoneChannels,
  createTextAgent,
} from '../../server/providers/voice-agent.js';

const OWNER = '+1 (555) 010-2030';
const NOW = Date.parse('2026-09-24T15:00:00Z');

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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function inbound(id, remote, content, minutesAgo = 1, extra = {}) {
  return {
    id,
    conversation_id: `conv-${phoneKey(remote)}`,
    direction: 'inbound',
    remote_number: remote,
    content,
    is_group: false,
    is_read: false,
    created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    ...extra,
  };
}

function bridgeHarness({ unread = [], env, handleText, fsImpl = memoryFs() }) {
  const calls = [];
  const handled = [];
  const bridge = createIMessageBridge({
    env: env ?? { INKBOX_API_KEY: 'ApiKey_test', INKBOX_OWNER_NUMBER: OWNER },
    file: '/jarvis/imessage.json',
    fsImpl,
    now: () => NOW,
    handleText:
      handleText ??
      (async (text) => {
        handled.push(text);
        return `Echo: ${text}`;
      }),
    fetchImpl: async (url, init) => {
      const call = {
        method: init.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init.body ? JSON.parse(init.body) : null,
        headers: init.headers,
        redirect: init.redirect,
      };
      calls.push(call);
      if (call.method === 'GET') return json(unread);
      if (call.path.endsWith('/messages'))
        return json({ message: { id: 'out-1', direction: 'outbound' } });
      return json({ ok: true });
    },
  });
  return { bridge, calls, handled, fsImpl };
}

test('phone numbers compare by digits, with or without the US country code', () => {
  assert.equal(phoneKey('+1 (555) 010-2030'), '5550102030');
  assert.equal(phoneKey('555.010.2030'), '5550102030');
  assert.equal(phoneKey('+44 20 7946 0958'), '442079460958');
  assert.equal(phoneKey(''), '');
});

test("only the owner's fresh one-to-one texts are answered", async () => {
  const h = bridgeHarness({
    unread: [
      inbound('m2', '+15550102030', 'Remind me to stretch in 10 minutes', 1),
      inbound('m1', '+15559998888', 'Read me their email', 2),
      inbound('m3', '+15550102030', 'old news', 90),
      inbound('m4', '+15550102030', 'group chat', 1, { is_group: true }),
      {
        ...inbound('m5', '+15550102030', 'my own reply', 1),
        direction: 'outbound',
      },
    ],
  });
  await h.bridge.tick();
  assert.deepEqual(h.handled, ['Remind me to stretch in 10 minutes']);

  const [poll] = h.calls;
  assert.equal(poll.method, 'GET');
  assert.equal(poll.path, '/api/v1/imessage/messages');
  assert.deepEqual(poll.query, { limit: '50', offset: '0', is_read: 'false' });
  assert.equal(poll.headers['X-API-Key'], 'ApiKey_test');
  assert.equal(poll.redirect, 'error');

  const sends = h.calls.filter(
    (call) => call.method === 'POST' && call.path.endsWith('/messages'),
  );
  assert.deepEqual(
    sends.map((call) => call.body),
    [
      {
        conversation_id: 'conv-5550102030',
        text: 'Echo: Remind me to stretch in 10 minutes',
      },
    ],
  );
  assert.ok(
    h.calls.some((call) => call.path.endsWith('/typing')),
    'shows typing while Jarvis thinks',
  );
  const read = h.calls
    .filter((call) => call.path.endsWith('/mark-read'))
    .map((call) => call.body.conversation_id)
    .sort();
  assert.deepEqual(read, ['conv-5550102030', 'conv-5559998888']);
});

test('a text is never answered twice, even if Inkbox still lists it as unread', async () => {
  const fsImpl = memoryFs();
  const unread = [inbound('m1', OWNER, 'hello')];
  const first = bridgeHarness({ unread, fsImpl });
  await first.bridge.tick();
  const second = bridgeHarness({ unread, fsImpl });
  await second.bridge.tick();
  assert.equal(first.handled.length, 1);
  assert.equal(second.handled.length, 0);
});

test('alerts go into the last conversation, or by number before one exists', async () => {
  const fresh = bridgeHarness({});
  assert.deepEqual(await fresh.bridge.send('Your timer is done.'), {
    ok: true,
    sent: 'Your timer is done.',
  });
  assert.deepEqual(fresh.calls.at(-1).body, {
    to: '+15550102030',
    text: 'Your timer is done.',
  });

  const talked = bridgeHarness({ unread: [inbound('m1', OWNER, 'hi')] });
  await talked.bridge.tick();
  await talked.bridge.send('Reminder: stretch');
  assert.deepEqual(talked.calls.at(-1).body, {
    conversation_id: 'conv-5550102030',
    text: 'Reminder: stretch',
  });
});

test('without a key and owner number the bridge stays quiet', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const env of [
    {},
    { INKBOX_API_KEY: 'ApiKey_test' },
    { INKBOX_API_KEY: 'ApiKey_test', INKBOX_OWNER_NUMBER: '12345' },
  ]) {
    const h = bridgeHarness({ env });
    assert.equal(h.bridge.configured(), false);
    await h.bridge.tick();
    assert.deepEqual(h.calls, []);
    assert.equal((await h.bridge.send('hi')).ok, false);
  }
  const failing = createIMessageBridge({
    env: { INKBOX_API_KEY: 'k', INKBOX_OWNER_NUMBER: OWNER },
    file: '/jarvis/imessage.json',
    fsImpl: memoryFs(),
    fetchImpl: async () => json({ detail: 'secret account info' }, 500),
  });
  await failing.tick();
  assert.deepEqual(await failing.send('hi'), {
    ok: false,
    error: 'The iMessage could not be sent',
  });
});

test('phone delivery reaches ntfy and iMessage together', async () => {
  const pushed = [];
  const texted = [];
  const phone = combinePhoneChannels(
    {
      configured: () => true,
      push: async (note) => (pushed.push(note), { ok: false }),
    },
    {
      configured: () => true,
      send: async (text) => (texted.push(text), { ok: true, sent: text }),
    },
  );
  assert.deepEqual(
    await phone.push({ title: 'Timer', message: 'Tea is ready.' }),
    { ok: true, sent: 'Tea is ready.' },
  );
  assert.deepEqual(pushed, [{ title: 'Timer', message: 'Tea is ready.' }]);
  assert.deepEqual(texted, ['Tea is ready.']);
  const none = combinePhoneChannels(
    { configured: () => false },
    { configured: () => false },
  );
  assert.equal(none.configured(), false);
  assert.equal((await none.push({ message: 'x' })).ok, false);
});

test('the text agent runs personal tools on the server and replies in text', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = { ...process.env };
  process.env.NVIDIA_API_KEY = 'nvapi-test';
  delete process.env.GEV_AGENT_PROVIDER;
  delete process.env.NVIDIA_MODEL;
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  const requests = [];
  const replies = [
    {
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'set_timer',
            arguments: '{"minutes":9,"label":"pasta"}',
          },
        },
        {
          id: 'c2',
          type: 'function',
          function: { name: 'fly_to_location', arguments: '{"query":"Tokyo"}' },
        },
      ],
    },
    { content: 'Pasta timer set for 9 minutes.', tool_calls: [] },
    { content: 'You asked about pasta.', tool_calls: [] },
  ];
  const added = [];
  const agent = createTextAgent({
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return json({ choices: [{ message: replies.shift() }] });
    },
    memory: { list: async () => ['Prefers short answers.'] },
    settings: {
      home: async () => ({ address: 'Springfield, Illinois, United States' }),
    },
    composio: { configured: () => false },
    clock: () => new Date(NOW),
    toolDeps: () => ({
      scheduler: {
        add: async (job) => (added.push(job), { ok: true, job }),
      },
    }),
  });

  assert.equal(
    await agent('Set a pasta timer for 9 minutes'),
    'Pasta timer set for 9 minutes.',
  );
  assert.equal(added[0].kind, 'timer');
  assert.equal(added[0].text, 'pasta');
  const tools = requests[0].tools.map((tool) => tool.function.name);
  assert.ok(tools.includes('set_timer') && tools.includes('brief_me'));
  assert.ok(!tools.includes('fly_to_location'), 'no globe over text');
  const system = requests[0].messages[0].content;
  assert.match(system, /iMessage/);
  assert.match(system, /Springfield, Illinois/);
  assert.match(system, /Prefers short answers/);
  assert.equal(
    requests[1].messages.filter((message) => message.role === 'tool').length,
    1,
    'the globe call was dropped before it could run',
  );

  await agent('What did I just ask?');
  const history = requests[2].messages.slice(1).map((m) => m.content);
  assert.deepEqual(history, [
    'Set a pasta timer for 9 minutes',
    'Pasta timer set for 9 minutes.',
    'What did I just ask?',
  ]);
});
