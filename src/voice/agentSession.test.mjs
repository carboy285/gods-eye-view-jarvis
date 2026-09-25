import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSession,
  isStandDown,
  safeConnectLink,
  speakableText,
  summarizeViewState,
  trimAgentHistory,
} from './agentSession.js';

function fakeListener() {
  return {
    callbacks: null,
    muted: [],
    started: 0,
    stopped: 0,
    async start(callbacks) {
      this.started++;
      this.callbacks = callbacks;
    },
    stop() {
      this.stopped++;
    },
    setMuted(value) {
      this.muted.push(value);
    },
  };
}

function fakeUi() {
  const kicker = { textContent: 'AI AGENT' };
  return {
    kicker,
    root: {
      dataset: {},
      querySelector: (selector) =>
        selector === '.gev-voice-kicker' ? kicker : null,
      querySelectorAll: () => [],
    },
    detail: { textContent: '' },
    helpDetail: { textContent: '' },
  };
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}

function jsonResponse(payload, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (callback, ms) => {
      pending.set(next, { callback, ms });
      return next++;
    },
    clearTimer: (id) => pending.delete(id),
    fire() {
      for (const [id, { callback }] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

function harness({
  replies = [],
  runAction = async () => ({ ok: true }),
  fetchImpl,
  agentProvider = 'nvidia',
  neuralSpeaker = null,
  createWakeWord = null,
  chime = null,
  timers = fakeTimers(),
  createEventSource = null,
} = {}) {
  const events = [];
  const listener = fakeListener();
  const spoken = [];
  const speech = {
    cancelled: 0,
    speak: (utterance) => spoken.push(utterance),
    cancel() {
      this.cancelled++;
    },
  };
  const requests = [];
  const ui = fakeUi();
  const session = createAgentSession({
    agentProvider,
    emit: (event) => events.push(event),
    runAction,
    ui,
    speech,
    neuralSpeaker,
    Utterance: FakeUtterance,
    createListener: () => listener,
    fetchImpl:
      fetchImpl ||
      ((url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return jsonResponse(replies.shift());
      }),
    requestFrame: () => 1,
    cancelFrame: () => {},
    createWakeWord,
    chime,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    createEventSource,
    clientId: 'page-test-0001',
  });
  return { session, events, listener, spoken, speech, requests, ui, timers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a heard request runs agent tool calls, then speaks the reply', async () => {
  const actions = [];
  const h = harness({
    replies: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'fly_to_location',
                arguments: '{"query":"Tokyo"}',
              },
            },
          ],
        },
      },
      { message: { content: 'Flying to Tokyo.', tool_calls: [] } },
    ],
    runAction: async (name, args) => {
      if (name === 'get_current_view_state')
        return {
          ok: true,
          camera: { latitude: 35.68, longitude: 139.69, heightM: 250_000 },
          style: 'normal',
          layers: [
            { id: 'flights', name: 'Flights', enabled: true, count: 42 },
          ],
          tracked: [],
        };
      actions.push([name, args]);
      return { ok: true, arrived: true };
    },
  });
  h.session.bindControls();
  await h.session.start();
  assert.equal(h.ui.kicker.textContent, 'JARVIS');
  assert.deepEqual(h.events.at(-1), {
    type: 'state',
    state: 'listening',
    detail: 'Jarvis is listening',
  });

  h.listener.callbacks.onPartial('take me to');
  assert.equal(h.ui.detail.textContent, '“take me to”');
  h.listener.callbacks.onFinal('take me to Tokyo');
  await settle();

  assert.deepEqual(actions, [['fly_to_location', { query: 'Tokyo' }]]);
  assert.equal(h.requests[0].url, '/api/agent/chat');
  assert.equal(
    h.requests[0].body.context,
    'camera over 35.68, 139.69 at 250 km; style normal; layers on: Flights (42)',
  );
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].body.messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call-1',
    content: '{"ok":true,"arrived":true}',
  });
  assert.equal(h.spoken.at(-1).text, 'Flying to Tokyo.');
  assert.deepEqual(
    h.listener.muted,
    [true],
    'listening pauses while it speaks',
  );
  assert.equal(h.ui.root.dataset.speaker, 'ai');
  assert.equal(h.events.at(-1).state, 'listening');
});

test('listening resumes when speech ends, and a click interrupts speech', async () => {
  const h = harness({
    replies: [
      { message: { content: 'One.' } },
      { message: { content: 'Two.' } },
    ],
  });
  await h.session.start();
  h.listener.callbacks.onFinal('first');
  await settle();
  h.spoken.at(-1).onend();
  assert.deepEqual(h.listener.muted, [true, false]);
  assert.equal(h.ui.root.dataset.speaker, 'idle');
  assert.equal(
    h.session.ignoreButtonClick(),
    false,
    'a click when quiet toggles voice off',
  );

  h.listener.callbacks.onFinal('second');
  await settle();
  assert.equal(h.session.ignoreButtonClick(), true);
  assert.deepEqual(h.listener.muted, [true, false, true, false]);
  assert.equal(h.events.at(-1).type, 'interruption');
});

test('tool failures go back to the agent instead of ending the turn', async () => {
  const h = harness({
    replies: [
      {
        message: {
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'track_entity', arguments: 'not json' },
            },
          ],
        },
      },
      { message: { content: 'I could not find that.' } },
    ],
    runAction: async (name, args) => {
      assert.deepEqual(args, {});
      throw new Error('Nothing matched');
    },
  });
  await h.session.start();
  h.listener.callbacks.onFinal('track that plane');
  await settle();
  assert.equal(
    h.requests[1].body.messages.at(-1).content,
    '{"ok":false,"error":"Nothing matched"}',
  );
  assert.equal(h.spoken.at(-1).text, 'I could not find that.');
});

test('an agent failure is reported without ending the session', async () => {
  const fail = {
    error: 'no_key',
    detail: 'Add an NVIDIA or Meta Model API key in POWER UP',
  };
  const h = harness({ fetchImpl: () => jsonResponse(fail, 503) });
  await h.session.start();
  await h.session.sendText('hello');
  assert.deepEqual(h.events.at(-1), {
    type: 'state',
    state: 'listening',
    detail: 'Add an NVIDIA or Meta Model API key in POWER UP',
  });
});

test('a listener error stops listening and shows the error', async () => {
  const h = harness();
  await h.session.start();
  h.listener.callbacks.onError('Microphone permission was denied');
  assert.equal(h.listener.stopped, 1);
  assert.deepEqual(h.events.at(-1), {
    type: 'state',
    state: 'error',
    detail: 'Microphone permission was denied',
  });
});

test('stop ends listening and ignores late replies', async () => {
  const h = harness({ replies: [{ message: { content: 'Too late.' } }] });
  await h.session.start();
  h.listener.callbacks.onFinal('hello');
  h.session.stop();
  await settle();
  assert.equal(h.listener.stopped, 1);
  assert.equal(h.spoken.length, 0);
});

test('the panel is labelled JARVIS for every provider', async () => {
  const h = harness({ agentProvider: 'muse' });
  h.session.bindControls();
  assert.equal(h.ui.kicker.textContent, 'JARVIS');
});

test('history trimming drops whole turns so tool calls keep their results', () => {
  const turn = (n) => [
    { role: 'user', content: `q${n}` },
    { role: 'assistant', content: null, tool_calls: [{ id: `c${n}` }] },
    { role: 'tool', tool_call_id: `c${n}`, content: '{}' },
    { role: 'assistant', content: `a${n}` },
  ];
  const history = [...turn(1), ...turn(2), ...turn(3)];
  const trimmed = trimAgentHistory(history, 6);
  assert.equal(trimmed[0].role, 'user');
  assert.equal(trimmed[0].content, 'q3');
  assert.equal(trimAgentHistory(history, 40), history);
});

function fakeDocument(t) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      listeners: {},
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      remove() {
        this.removed = true;
      },
    }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
}

test('server-side tool calls go to /api/agent/tool and surface connect links', async (t) => {
  fakeDocument(t);
  const calls = [];
  const replies = [
    {
      message: {
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            runOn: 'server',
            function: {
              name: 'COMPOSIO_MANAGE_CONNECTIONS',
              arguments: '{"toolkits":["gmail"]}',
            },
          },
        ],
      },
    },
    { message: { content: "I've put a link in the panel." } },
  ];
  const h = harness({
    runAction: async (name) => {
      assert.equal(
        name,
        'get_current_view_state',
        'app tools never run in the browser',
      );
      return { ok: false };
    },
    fetchImpl: (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url === '/api/agent/tool')
        return jsonResponse({
          ok: true,
          connectLinks: [
            'https://evil.example/login',
            'https://connect.composio.dev/link/abc',
          ],
          data: {},
        });
      return jsonResponse(replies.shift());
    },
  });
  const appended = [];
  h.ui.root.appendChild = (node) => appended.push(node);
  await h.session.start();
  h.listener.callbacks.onFinal('check my email');
  await settle();

  assert.deepEqual(calls[1], {
    url: '/api/agent/tool',
    body: {
      name: 'COMPOSIO_MANAGE_CONNECTIONS',
      arguments: { toolkits: ['gmail'] },
    },
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].href, 'https://connect.composio.dev/link/abc');
  assert.equal(appended[0].rel, 'noopener noreferrer');
  assert.equal(h.spoken.at(-1).text, "I've put a link in the panel.");
});

test('NVIDIA voice speaks replies and falls back to browser speech on failure', async () => {
  let fail = false;
  const neural = {
    spoken: [],
    cancelled: 0,
    prepared: 0,
    prepare() {
      this.prepared++;
    },
    speak(text) {
      this.spoken.push(text);
      return fail ? Promise.reject(new Error('down')) : Promise.resolve();
    },
    cancel() {
      this.cancelled++;
    },
    level: () => 0.5,
  };
  const h = harness({
    replies: [
      { message: { content: 'First.' } },
      { message: { content: 'Second.' } },
    ],
    neuralSpeaker: neural,
  });
  await h.session.start();
  assert.equal(
    neural.prepared,
    1,
    'audio is unlocked by the click that starts voice',
  );

  h.listener.callbacks.onFinal('one');
  await settle();
  assert.deepEqual(neural.spoken, ['First.']);
  assert.equal(h.spoken.length, 0);
  assert.deepEqual(
    h.listener.muted,
    [true, false],
    'listening resumes after the voice',
  );

  fail = true;
  h.listener.callbacks.onFinal('two');
  await settle();
  assert.equal(h.spoken.at(-1).text, 'Second.', 'browser speech takes over');
  assert.equal(h.session.ignoreButtonClick(), true);
  assert.equal(neural.cancelled, 1);
});

test('the conversation survives turning the mic off and on', async () => {
  const h = harness({
    replies: [
      { message: { content: 'Noted.' } },
      { message: { content: 'Austin.' } },
    ],
  });
  await h.session.start();
  h.listener.callbacks.onFinal('my home is Austin');
  await settle();
  h.session.stop();
  await h.session.start();
  h.listener.callbacks.onFinal('where is home?');
  await settle();
  assert.deepEqual(
    h.requests[1].body.messages.map((m) => m.content),
    ['my home is Austin', 'Noted.', 'where is home?'],
  );
});

test('replies are cleaned into plain spoken sentences', () => {
  assert.equal(
    speakableText(
      'Tokyo headlines:\n\n- **Typhoon** batters Japan\n- New [inn](https://x.example) opens\n\nThat is all',
    ),
    'Tokyo headlines: Typhoon batters Japan. New inn opens. That is all.',
  );
  assert.equal(speakableText('See https://example.com now.'), 'See now.');
  assert.equal(speakableText(''), '');
});

test('the view summary names position, layers, feed trouble and tracking', () => {
  assert.equal(summarizeViewState({ ok: false }), '');
  assert.equal(
    summarizeViewState({
      ok: true,
      camera: { latitude: 30.27, longitude: -97.74, heightM: 1_500 },
      style: 'surveillance',
      layers: [
        {
          id: 'flights',
          name: 'Flights',
          enabled: true,
          count: 12,
          feedState: 'stale',
        },
        { id: 'ships', name: 'Ships', enabled: false, count: 0 },
      ],
      tracked: [{ kind: 'aircraft', callsign: 'UAL123' }],
    }),
    'camera over 30.27, -97.74 at 1500 m; style surveillance; layers on: Flights (12, stale); tracking aircraft UAL123',
  );
});

test('only Composio https pages are offered as connect links', () => {
  assert.equal(
    safeConnectLink('https://connect.composio.dev/x'),
    'https://connect.composio.dev/x',
  );
  assert.equal(safeConnectLink('http://connect.composio.dev/x'), null);
  assert.equal(safeConnectLink('https://composio.dev.evil.example/x'), null);
  assert.equal(safeConnectLink('javascript:alert(1)'), null);
});

function fakeDetector({ fail } = {}) {
  return {
    options: null,
    started: 0,
    stopped: 0,
    create(options) {
      this.options = options;
      return this;
    },
    async start() {
      this.started++;
      if (fail) throw fail;
    },
    stop() {
      this.stopped++;
    },
    wake() {
      this.options.onWake(0.99);
    },
  };
}

function wakeHarness(options = {}) {
  const detector = fakeDetector(options);
  const chimes = [];
  const h = harness({
    createWakeWord: (opts) => detector.create(opts),
    chime: { prepare() {}, play: () => chimes.push(Date.now()) },
    ...options,
  });
  const states = () =>
    h.events.filter((e) => e.type === 'state').map((e) => [e.state, e.detail]);
  return { ...h, detector, chimes, states };
}

test('wake mode waits in standby and only listens after "Hey Jarvis"', async () => {
  const h = wakeHarness({
    replies: [{ message: { content: 'Flying to Tokyo.' } }],
  });
  await h.session.start();
  assert.deepEqual(h.states().at(-1), ['standby', 'Say "Hey Jarvis"']);
  assert.equal(
    h.listener.started,
    0,
    'no speech recognition before the wake word',
  );

  h.detector.wake();
  await settle();
  assert.equal(h.chimes.length, 1);
  assert.equal(h.listener.started, 1);
  assert.deepEqual(h.states().at(-1), ['listening', 'Listening']);

  h.listener.callbacks.onFinal('take me to Tokyo');
  await settle();
  assert.equal(
    h.listener.stopped >= 1,
    true,
    'recognition stops once it has the request',
  );
  assert.deepEqual(h.states().at(-1), ['speaking', 'Flying to Tokyo.']);
  assert.equal(h.spoken.at(-1).text, 'Flying to Tokyo.');
});

test('after answering, a follow-up window listens without the wake word, then times out', async () => {
  const h = wakeHarness({
    replies: [
      { message: { content: 'Done.' } },
      { message: { content: 'Also done.' } },
    ],
  });
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('turn on flights');
  await settle();
  h.spoken.at(-1).onend();
  await settle();
  assert.deepEqual(h.states().at(-1), ['listening', 'Go ahead']);
  assert.equal([...h.timers.pending.values()][0].ms, 8_000);

  h.listener.callbacks.onSpeechStart();
  assert.equal(h.timers.pending.size, 0, 'speaking keeps the window open');
  h.listener.callbacks.onFinal('and thermal');
  await settle();
  h.spoken.at(-1).onend();
  await settle();
  h.timers.fire();
  assert.deepEqual(h.states().at(-1), ['standby', 'Say "Hey Jarvis"']);
  assert.equal(h.requests.length, 2);
});

test('"Hey Jarvis" interrupts a reply and listens straight away', async () => {
  const h = wakeHarness({
    replies: [{ message: { content: 'A long answer.' } }],
  });
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('tell me everything');
  await settle();
  const cancelledBefore = h.speech.cancelled;

  h.detector.wake();
  await settle();
  assert.ok(h.speech.cancelled > cancelledBefore, 'speech is cut off');
  assert.equal(
    h.events.some((e) => e.type === 'interruption' && e.reason === 'wake-word'),
    true,
  );
  assert.deepEqual(h.states().at(-1), ['listening', 'Listening']);
  assert.equal(
    h.timers.pending.size,
    0,
    'no follow-up timer after a wake-word interrupt',
  );
});

test('"Hey Jarvis" while thinking cancels the pending request', async () => {
  let release;
  const h = wakeHarness({
    fetchImpl: () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            new Response(JSON.stringify({ message: { content: 'Too late.' } })),
          );
      }),
  });
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('slow question');
  await settle();
  h.detector.wake();
  release();
  await settle();
  assert.equal(h.spoken.length, 0, 'the cancelled answer is never spoken');
  assert.deepEqual(h.states().at(-1), ['listening', 'Listening']);
});

test('"stand down" cancels without asking the agent', async () => {
  const h = wakeHarness();
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('Stand down.');
  await settle();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.states().at(-1), ['standby', 'Standing by']);
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('Jarvis, stand by.');
  await settle();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.states().at(-1), ['standby', 'Standing by']);
  for (const phrase of [
    'never mind',
    'Jarvis, cancel that',
    "that's all",
    'forget it',
    'Jarvis stand by',
    'Jarvis, standby.',
    'stand-by',
    'go to standby mode',
    'Hey Jarvis, go into stand by',
    'Stand by, please.',
  ])
    assert.equal(isStandDown(phrase), true, phrase);
  for (const phrase of [
    'stand by me',
    'what does standby power mean',
    'stop the camera',
    'cancel my 3pm meeting',
    'stand down the fleet now',
  ])
    assert.equal(isStandDown(phrase), false, phrase);
});

test('if the wake word cannot load, Jarvis falls back to always listening', async () => {
  const h = wakeHarness({
    fail: new Error('Wake-word model hey_jarvis_v0.1.onnx is missing'),
  });
  await h.session.start();
  assert.equal(h.detector.stopped, 1);
  assert.equal(h.listener.started, 1);
  assert.deepEqual(h.states().at(-1), ['listening', 'Jarvis is listening']);
});

test('a blocked microphone fails the start with a clear message', async () => {
  const h = wakeHarness({
    fail: Object.assign(new Error('Permission denied'), {
      name: 'NotAllowedError',
    }),
  });
  await assert.rejects(h.session.start(), /Microphone access was blocked/);
  assert.equal(h.listener.started, 0);
});

test('turning Jarvis off stops the wake word and any follow-up', async () => {
  const h = wakeHarness({ replies: [{ message: { content: 'Done.' } }] });
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('hello');
  await settle();
  h.spoken.at(-1).onend();
  await settle();
  h.session.stop();
  assert.equal(h.detector.stopped, 1);
  assert.equal(h.timers.pending.size, 0);
});

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.closed = false;
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
  send(event) {
    this.dispatchEvent(
      new MessageEvent('announcement', { data: JSON.stringify(event) }),
    );
  }
}

function announcementHarness({ chatReplies = [], fetchImpl } = {}) {
  const posts = [];
  const h = wakeHarness({
    createEventSource: (url) => new FakeEventSource(url),
    fetchImpl:
      fetchImpl ||
      ((url, init) => {
        const body = JSON.parse(init.body);
        posts.push({ url, body });
        if (url === '/api/jarvis/speaker') return jsonResponse({ ok: true });
        return jsonResponse(chatReplies.shift());
      }),
  });
  return { ...h, posts, source: () => FakeEventSource.last };
}

test('Jarvis subscribes to announcements and claims the speaker role', async () => {
  const h = announcementHarness();
  await h.session.start();
  assert.equal(h.source().url, '/api/jarvis/events?client=page-test-0001');
  h.source().dispatchEvent(new Event('open'));
  await settle();
  assert.deepEqual(h.posts, [
    { url: '/api/jarvis/speaker', body: { client: 'page-test-0001' } },
  ]);
  h.session.stop();
  assert.equal(h.source().closed, true);
});

test('a reminder is chimed and spoken on the speaking page, then listens for a reply', async () => {
  const h = announcementHarness();
  await h.session.start();
  h.source().send({ kind: 'reminder', text: 'Reminder: stretch', speak: true });
  await settle();
  assert.equal(h.chimes.length, 1);
  assert.equal(h.spoken.at(-1).text, 'Reminder: stretch');
  assert.deepEqual(h.states().at(-1), ['speaking', 'Reminder: stretch']);
  h.spoken.at(-1).onend();
  await settle();
  assert.deepEqual(h.states().at(-1), ['listening', 'Go ahead']);
});

test('other pages only show the announcement', async () => {
  const h = announcementHarness();
  await h.session.start();
  h.source().send({
    kind: 'reminder',
    text: 'Reminder: stretch',
    speak: false,
  });
  await settle();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.ui.detail.textContent, 'Reminder: stretch');
  assert.equal(h.chimes.length, 0);
});

test('an announcement during an answer waits its turn', async () => {
  const h = announcementHarness({
    chatReplies: [{ message: { content: 'Flying to Tokyo.' } }],
  });
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('take me to Tokyo');
  h.source().send({
    kind: 'timer',
    text: 'Your tea timer is done.',
    speak: true,
  });
  await settle();
  assert.equal(h.spoken.at(-1).text, 'Flying to Tokyo.');
  h.spoken.at(-1).onend();
  await settle();
  assert.equal(h.spoken.at(-1).text, 'Your tea timer is done.');
});

test('"hide the panel" is handled locally without calling the agent', async () => {
  const h = harness();
  await h.session.start();
  h.listener.callbacks.onFinal('Hide the panel');
  await settle();
  assert.equal(h.requests.length, 0, 'no model round trip');
  assert.deepEqual(
    h.events.filter((event) => event.type === 'hud'),
    [{ type: 'hud', visible: false }],
  );
  assert.deepEqual(h.events.at(-1), {
    type: 'state',
    state: 'listening',
    detail: 'Panel hidden',
  });
});

test('"Goodnight, Jarvis" says goodnight, asks the server to sleep, then turns the mic off', async () => {
  const h = announcementHarness();
  await h.session.start();
  h.detector.wake();
  await settle();
  h.listener.callbacks.onFinal('Goodnight, Jarvis.');
  await settle();
  assert.equal(h.spoken.at(-1).text, 'Goodnight.');
  assert.deepEqual(
    h.posts.filter((post) => post.url === '/api/jarvis/sleep'),
    [{ url: '/api/jarvis/sleep', body: { action: 'sleep' } }],
  );
  assert.equal(
    h.posts.filter((post) => post.url === '/api/agent/chat').length,
    0,
    'no AI round trip',
  );
  // The server's broadcast arrives while "Goodnight" is still playing.
  h.source().dispatchEvent(
    new MessageEvent('sleep', {
      data: JSON.stringify({ until: '2026-09-25T12:00:00.000Z' }),
    }),
  );
  assert.equal(h.detector.stopped, 0, 'waits for the goodnight to finish');
  h.spoken.at(-1).onend();
  await settle();
  assert.equal(h.detector.stopped, 1, 'the wake word is off too');
  assert.equal(h.source().closed, true);
  assert.deepEqual(h.states().at(-1), ['idle', 'Jarvis is asleep']);
  assert.deepEqual(
    h.events.filter((event) => event.type === 'sleep'),
    [{ type: 'sleep', until: '2026-09-25T12:00:00.000Z' }],
  );
});

test('a sleep broadcast from another device turns this page off too', async () => {
  const h = announcementHarness();
  await h.session.start();
  h.source().dispatchEvent(
    new MessageEvent('sleep', { data: '{"until":null}' }),
  );
  assert.deepEqual(h.states().at(-1), ['idle', 'Jarvis is asleep']);
  assert.equal(h.detector.stopped, 1);
});
