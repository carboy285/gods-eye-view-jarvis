import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  createMemoryStore,
  runServerTool,
  SERVER_TOOL_NAMES,
} from '../../server/providers/voice-agent/tools.js';
import {
  createComposioBridge,
  extractConnectLinks,
  isAllowedAgentClient,
} from '../../server/providers/voice-agent/composio.js';
import {
  createMagpieSynthesizer,
  trimForSpeech,
} from '../../server/providers/voice-agent/tts.js';

function memoryFs(initial) {
  const files = new Map(initial ? [['/home/u/.gev/memory.json', initial]] : []);
  return {
    files,
    writes: [],
    async readFile(file) {
      if (!files.has(file))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    async mkdir() {},
    async writeFile(file, text, options) {
      this.writes.push({ file, options });
      files.set(file, text);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

test('memory remembers, deduplicates and forgets facts with atomic writes', async () => {
  const fsImpl = memoryFs();
  const memory = createMemoryStore({
    file: '/home/u/.gev/memory.json',
    fsImpl,
  });
  assert.deepEqual(await memory.list(), []);
  assert.deepEqual(await memory.remember('  Home   city is Austin. '), {
    ok: true,
    remembered: 'Home city is Austin.',
  });
  await memory.remember('home city is austin.');
  await memory.remember('Prefers metric units.');
  assert.deepEqual(await memory.list(), [
    'Home city is Austin.',
    'Prefers metric units.',
  ]);
  assert.ok(
    fsImpl.writes.every(({ file }) => file.endsWith('.tmp')),
    'writes go to a temp file first',
  );
  assert.equal(fsImpl.writes[0].options.mode, 0o600);

  assert.deepEqual(await memory.forget('AUSTIN'), { ok: true, forgotten: 1 });
  assert.deepEqual(await memory.forget('   '), {
    ok: false,
    error: 'Say what to forget',
  });
  assert.deepEqual(await memory.remember(''), {
    ok: false,
    error: 'Nothing to remember',
  });

  const reloaded = createMemoryStore({
    file: '/home/u/.gev/memory.json',
    fsImpl,
  });
  assert.deepEqual(await reloaded.list(), ['Prefers metric units.']);
});

test('memory keeps the newest 100 facts and survives a corrupt file', async () => {
  const memory = createMemoryStore({
    file: '/home/u/.gev/memory.json',
    fsImpl: memoryFs('{not json'),
  });
  assert.deepEqual(await memory.list(), []);
  for (let index = 0; index < 105; index++)
    await memory.remember(`Fact ${index}.`);
  const facts = await memory.list();
  assert.equal(facts.length, 100);
  assert.equal(facts[0], 'Fact 5.');
});

test('server tools refuse unknown names', async () => {
  assert.deepEqual([...SERVER_TOOL_NAMES].slice(0, 3), [
    'search_news',
    'remember_fact',
    'forget_fact',
  ]);
  assert.equal(SERVER_TOOL_NAMES.size, 12);
  assert.deepEqual(await runServerTool('rm_rf', {}, {}), {
    ok: false,
    error: 'Unknown server tool rm_rf',
  });
  assert.deepEqual(await runServerTool('search_news', { query: ' ' }, {}), {
    ok: false,
    error: 'No search query',
  });
});

test('only loopback and listed addresses may use app tools', () => {
  const req = (remoteAddress) => ({ socket: { remoteAddress } });
  const env = { GEV_TRUSTED_IPS: '192.168.1.20, 10.0.0.8' };
  for (const address of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '192.168.1.20',
    '::ffff:10.0.0.8',
  ])
    assert.equal(isAllowedAgentClient(req(address), env), true, address);
  for (const address of ['192.168.1.21', '10.0.0.80', '', undefined])
    assert.equal(
      isAllowedAgentClient(req(address), env),
      false,
      String(address),
    );
  assert.equal(isAllowedAgentClient(req('192.168.1.20'), {}), false);
});

test('connect links are Composio https pages found anywhere in a result', () => {
  assert.deepEqual(
    extractConnectLinks({
      results: [
        { redirect_url: 'https://connect.composio.dev/link/1' },
        { other: 'https://evil.example/composio.dev' },
        { nested: { url: 'http://connect.composio.dev/insecure' } },
        'https://composio.dev/auth',
      ],
    }),
    ['https://connect.composio.dev/link/1', 'https://composio.dev/auth'],
  );
});

test('the Composio bridge makes one session and reuses it', async () => {
  const created = [];
  const executed = [];
  const session = {
    tools: async () => [
      {
        type: 'function',
        function: { name: 'COMPOSIO_SEARCH_TOOLS', parameters: {} },
      },
      { type: 'nope' },
    ],
    execute: async (name, args) => {
      executed.push([name, args]);
      return {
        data: { redirect_url: 'https://connect.composio.dev/link/9' },
        error: null,
        logId: 'l1',
      };
    },
  };
  const bridge = createComposioBridge({
    env: { COMPOSIO_API_KEY: 'c-key' },
    createClient: (apiKey) => ({
      sessions: {
        create: async (userId, config) => {
          created.push({ apiKey, userId, config });
          return session;
        },
      },
    }),
  });
  assert.equal(bridge.configured(), true);
  assert.deepEqual(
    (await bridge.tools()).map((tool) => tool.function.name),
    ['COMPOSIO_SEARCH_TOOLS'],
  );
  const result = await bridge.execute('COMPOSIO_MANAGE_CONNECTIONS', {
    toolkits: ['gmail'],
  });
  assert.deepEqual(
    Object.keys(result),
    ['ok', 'connectLinks', 'data'],
    'links come before data',
  );
  assert.deepEqual(result.connectLinks, [
    'https://connect.composio.dev/link/9',
  ]);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    apiKey: 'c-key',
    userId: 'gev-owner',
    config: {
      manageConnections: { enable: true, waitForConnections: false },
      sandbox: { enable: false },
    },
  });
});

test('the Composio bridge recovers after a failure', async () => {
  let attempts = 0;
  const bridge = createComposioBridge({
    env: { COMPOSIO_API_KEY: 'c-key' },
    createClient: () => ({
      sessions: {
        create: async () => {
          attempts++;
          if (attempts === 1) throw new Error('network');
          return {
            tools: async () => [],
            execute: async () => ({ data: {}, error: null }),
          };
        },
      },
    }),
  });
  await assert.rejects(bridge.tools());
  assert.deepEqual(await bridge.tools(), []);
  assert.equal(attempts, 2);
  assert.deepEqual(await createComposioBridge({ env: {} }).execute('X', {}), {
    ok: false,
    error: 'Composio is not configured',
  });
});

test('speech is trimmed to whole sentences within the limit', () => {
  assert.equal(trimForSpeech('  One.   Two. '), 'One. Two.');
  assert.equal(
    trimForSpeech('First part. Second part runs long', 20),
    'First part.',
  );
  assert.equal(trimForSpeech('no sentence break at all', 8), 'no sente');
});

test('the Magpie client sends one request and streams audio back', async () => {
  const metadata = [];
  const requests = [];
  class FakeCall extends EventEmitter {
    write(request) {
      requests.push(request);
    }
    end() {
      queueMicrotask(() => {
        this.emit('data', { audio: Buffer.from([1, 2]) });
        this.emit('data', { audio: Buffer.alloc(0) });
        this.emit('end');
      });
    }
    cancel() {}
  }
  const service = {
    grpc: {
      credentials: { createSsl: () => 'ssl' },
      Metadata: class {
        set(key, value) {
          metadata.push([key, value]);
        }
      },
    },
    Service: class {
      constructor(host, credentials) {
        this.target = [host, credentials];
      }
      SynthesizeOnline() {
        return new FakeCall();
      }
      close() {}
    },
  };
  const synthesizer = createMagpieSynthesizer({
    env: {
      NVIDIA_API_KEY: 'nvapi-test',
      NVIDIA_TTS_VOICE: 'Magpie-Multilingual.EN-US.Leo',
    },
    loadService: () => service,
  });
  const chunks = [];
  await synthesizer.stream('Hello there.', {
    onAudio: (chunk) => chunks.push(chunk),
  });
  assert.deepEqual(chunks, [Buffer.from([1, 2])]);
  assert.deepEqual(metadata, [
    ['function-id', '877104f7-e885-42b9-8de8-f6e4c6303969'],
    ['authorization', 'Bearer nvapi-test'],
  ]);
  assert.deepEqual(requests, [
    {
      text: 'Hello there.',
      language_code: 'en-US',
      encoding: 'LINEAR_PCM',
      sample_rate_hz: 22050,
      voice_name: 'Magpie-Multilingual.EN-US.Leo',
    },
  ]);
  await assert.rejects(
    createMagpieSynthesizer({ env: {}, loadService: () => service }).stream(
      'Hi.',
      {
        onAudio() {},
      },
    ),
    /NVIDIA voice is off/,
  );
});
