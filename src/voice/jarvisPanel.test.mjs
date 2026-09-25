import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJarvisPanel,
  panelCommand,
  upcomingRows,
} from './jarvisPanel.js';
import { attachJarvisPanel } from './commands.js';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.parent = null;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  click() {
    for (const listener of this.listeners.click || []) listener({});
  }
  find(className) {
    if (this.className === className) return this;
    for (const child of this.children) {
      const found = child.find(className);
      if (found) return found;
    }
    return null;
  }
}

function fakeDocument() {
  const listeners = new Set();
  const body = new FakeElement('body');
  return {
    body,
    listeners,
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    press(key, extra = {}) {
      for (const listener of listeners) listener({ key, ...extra });
    },
  };
}

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const UPCOMING = {
  ok: true,
  items: [
    { kind: 'timer', text: 'pasta', when: 'at 8:09 PM' },
    {
      kind: 'briefing',
      text: 'Daily briefing',
      when: 'tomorrow at 7:30 AM',
      repeats: true,
    },
  ],
  watches: {
    flights: ['UAL123'],
    earthquakes: { minMagnitude: 4, radiusKm: 300 },
    severeWeather: false,
  },
};

function panelHarness({ storage = fakeStorage(), narrow = false, data } = {}) {
  const doc = fakeDocument();
  const intervals = new Map();
  const requests = [];
  const panel = createJarvisPanel({
    doc,
    storage,
    narrow: () => narrow,
    fetchImpl: async (url) => {
      requests.push(url);
      return data === null
        ? { ok: false, status: 403, json: async () => ({}) }
        : { ok: true, json: async () => data ?? UPCOMING };
    },
    setIntervalImpl: (callback, ms) => {
      const id = intervals.size + 1;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearIntervalImpl: (id) => intervals.delete(id),
  });
  const part = (name) => panel.root.find(`gev-jarvis-${name}`);
  return { panel, doc, storage, intervals, requests, part };
}

test('voice commands for the panel are recognised, nothing else', () => {
  assert.equal(panelCommand('Hide the panel'), false);
  assert.equal(panelCommand('show the HUD.'), true);
  assert.equal(panelCommand('Jarvis, open your panel'), true);
  assert.equal(panelCommand('close jarvis panel'), false);
  assert.equal(panelCommand('show me the panel discussion'), null);
  assert.equal(panelCommand('hide'), null);
});

test('upcoming rows cover scheduled items and watches', () => {
  assert.deepEqual(upcomingRows(UPCOMING), [
    { label: 'Timer', text: 'pasta', when: 'at 8:09 PM' },
    {
      label: 'Briefing',
      text: 'Daily briefing',
      when: 'tomorrow at 7:30 AM, repeats',
    },
    { label: 'Flight', text: 'UAL123', when: 'until it lands' },
    {
      label: 'Alerts',
      text: 'Earthquakes M4+',
      when: 'within 300 km of home',
    },
  ]);
  assert.deepEqual(upcomingRows(null), []);
});

test('the panel follows state and the last exchange as text only', async () => {
  const h = panelHarness();
  assert.equal(h.doc.body.children[0], h.panel.root);
  assert.equal(h.panel.root.getAttribute('aria-label'), 'Jarvis');
  h.panel.handle({ type: 'state', state: 'standby' });
  assert.equal(h.panel.root.dataset.state, 'standby');
  assert.equal(h.part('status').textContent, 'Standing by');
  h.panel.handle({
    type: 'transcript',
    role: 'user',
    text: '<img src=x onerror=alert(1)>',
    final: true,
  });
  assert.equal(h.part('you').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.part('reply').textContent, '…');
  h.panel.handle({
    type: 'transcript',
    role: 'assistant',
    text: 'x'.repeat(400),
    final: true,
  });
  assert.equal(h.part('reply').textContent.length, 280);
  assert.equal(h.part('reply').title, h.part('reply').textContent);
  h.panel.handle({ type: 'state', state: 'executing' });
  assert.equal(h.part('status').textContent, 'Thinking');
});

test('upcoming items load when voice starts and refresh on a timer', async () => {
  const h = panelHarness();
  h.panel.handle({ type: 'state', state: 'listening' });
  await h.panel.refresh();
  assert.deepEqual(h.requests, ['/api/jarvis/upcoming']);
  assert.equal(h.part('upcoming').hidden, false);
  assert.equal(
    h.part('summary').textContent,
    '2 upcoming · 8:09 PM · 2 watching',
  );
  const list = h.part('upcoming').children[1];
  assert.equal(list.hidden, true, 'collapsed by default');
  h.part('summary').click();
  assert.equal(list.hidden, false);
  assert.equal(h.part('summary').getAttribute('aria-expanded'), 'true');
  assert.equal(list.children.length, 4);
  assert.deepEqual(
    [...h.intervals.values()].map(({ ms }) => ms),
    [60_000],
  );

  h.panel.handle({ type: 'state', state: 'idle' });
  assert.equal(h.intervals.size, 0, 'no polling while voice is off');
});

test('devices without personal access show no upcoming section', async () => {
  const h = panelHarness({ data: null });
  h.panel.handle({ type: 'state', state: 'listening' });
  await h.panel.refresh();
  assert.equal(h.part('upcoming').hidden, true);
});

test('J, the close button and voice toggle the panel, remembered per browser', () => {
  const storage = fakeStorage();
  const h = panelHarness({ storage });
  assert.equal(h.panel.root.hidden, false);
  h.doc.press('j');
  assert.equal(h.panel.root.hidden, true);
  assert.equal(storage.values.get('gev.jarvis.panel'), 'hidden');
  h.doc.press('J');
  assert.equal(h.panel.root.hidden, false);
  for (const ignored of [
    { ctrlKey: true },
    { metaKey: true },
    { repeat: true },
    { defaultPrevented: true },
    { target: { closest: () => ({}) } },
  ])
    h.doc.press('j', ignored);
  assert.equal(h.panel.root.hidden, false, 'typing and shortcuts pass by');
  const tab = h.doc.body.children.find(
    (node) => node.className === 'gev-jarvis-tab',
  );
  assert.equal(tab.hidden, true, 'no tab while the panel is open');
  h.part('close').click();
  assert.equal(h.panel.root.hidden, true);
  assert.equal(tab.hidden, false, 'closing leaves a way back');
  h.panel.handle({ type: 'state', state: 'speaking' });
  assert.equal(tab.dataset.state, 'speaking');
  tab.click();
  assert.equal(h.panel.root.hidden, false);
  assert.equal(tab.hidden, true);
  h.part('close').click();
  h.panel.handle({ type: 'hud', visible: true });
  assert.equal(h.panel.root.hidden, false);

  assert.equal(
    panelHarness({ storage: fakeStorage({ 'gev.jarvis.panel': 'hidden' }) })
      .panel.root.hidden,
    true,
  );
  assert.equal(panelHarness({ narrow: true }).panel.root.hidden, true);
  assert.equal(
    panelHarness({
      narrow: true,
      storage: fakeStorage({ 'gev.jarvis.panel': 'shown' }),
    }).panel.root.hidden,
    false,
  );
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const blocked = panelHarness({ storage: throwing });
  assert.equal(blocked.panel.toggle(), false, 'works without storage');
});

test('connect links appear in the panel and it cleans up after itself', () => {
  const h = panelHarness();
  assert.equal(h.part('connect').hidden, true);
  h.panel.handle({
    type: 'connect-link',
    href: 'https://connect.composio.dev/link/1',
  });
  assert.equal(h.part('connect').hidden, false);
  assert.equal(h.part('connect').href, 'https://connect.composio.dev/link/1');
  assert.equal(h.part('connect').rel, 'noopener noreferrer');
  h.panel.destroy();
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.doc.listeners.size, 0);
  h.panel.handle({ type: 'state', state: 'listening' });
});

test('the panel is attached to a session and removed with it', () => {
  const controller = new AbortController();
  const handled = [];
  let listener;
  let destroyed = false;
  const session = {
    signal: controller.signal,
    disposed: false,
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
  };
  const previous = globalThis.document;
  globalThis.document = {};
  try {
    const panel = attachJarvisPanel(session, () => ({
      handle: (event) => handled.push(event.type),
      destroy: () => {
        destroyed = true;
      },
    }));
    assert.ok(panel);
    listener({ type: 'state' });
    controller.abort();
    assert.deepEqual(handled, ['state']);
    assert.equal(listener, null);
    assert.equal(destroyed, true);
  } finally {
    globalThis.document = previous;
  }
});

test('sleep blacks the page out until a click, the mic, or morning', () => {
  const h = panelHarness();
  const night = h.doc.body.children.find(
    (node) => node.className === 'gev-jarvis-night',
  );
  assert.equal(night.hidden, true);
  h.panel.handle({ type: 'sleep', until: '2026-09-25T12:00:00.000Z' });
  assert.equal(night.hidden, false);
  assert.match(
    night.find('gev-jarvis-night-detail').textContent,
    /^Back on at /,
  );
  night.click();
  assert.equal(night.hidden, true, 'a click shows the globe again');
  h.panel.handle({ type: 'sleep', until: null });
  assert.equal(
    night.find('gev-jarvis-night-detail').textContent,
    'Back on in the morning',
  );
  h.panel.handle({ type: 'state', state: 'standby' });
  assert.equal(night.hidden, true, 'turning the mic on wakes the screen');
  h.panel.handle({ type: 'sleep' });
  h.panel.handle({ type: 'wake' });
  assert.equal(night.hidden, true);
  h.panel.destroy();
  assert.equal(h.doc.body.children.length, 0);
});
