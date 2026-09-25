import assert from 'node:assert/strict';
import test from 'node:test';
import { installFullscreenToggle } from './fullscreenToggle.js';

class FakeNode extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.textContent = '';
    this.parent = null;
  }
  append(child) {
    child.parent = this;
    this.children.push(child);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  click() {
    this.dispatchEvent(new Event('click'));
  }
}

function fakeDocument({ standard = true, prefixed = false, host = true } = {}) {
  const doc = new EventTarget();
  const indicator = new FakeNode('div');
  const byId = new Map(host ? [['style-indicator', indicator]] : []);
  let full = null;
  const change = (name) => doc.dispatchEvent(new Event(name));
  doc.documentElement = new FakeNode('html');
  doc.createElement = (tag) => new FakeNode(tag);
  doc.getElementById = (id) =>
    byId.get(id) ?? indicator.children.find((child) => child.id === id) ?? null;
  if (standard) {
    doc.fullscreenEnabled = true;
    Object.defineProperty(doc, 'fullscreenElement', { get: () => full });
    doc.documentElement.requestFullscreen = async () => {
      full = doc.documentElement;
      change('fullscreenchange');
    };
    doc.exitFullscreen = async () => {
      full = null;
      change('fullscreenchange');
    };
  }
  if (prefixed) {
    doc.webkitFullscreenEnabled = true;
    Object.defineProperty(doc, 'webkitFullscreenElement', {
      get: () => full,
    });
    doc.documentElement.webkitRequestFullscreen = () => {
      full = doc.documentElement;
      change('webkitfullscreenchange');
    };
    doc.webkitExitFullscreen = () => {
      full = null;
      change('webkitfullscreenchange');
    };
  }
  return {
    doc,
    indicator,
    pressEsc: () => {
      full = null;
      change(standard ? 'fullscreenchange' : 'webkitfullscreenchange');
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the button enters and leaves full screen and follows Esc', async () => {
  const { doc, indicator, pressEsc } = fakeDocument();
  const toggle = installFullscreenToggle({ doc });
  assert.equal(indicator.children[0], toggle.button);
  assert.equal(toggle.button.getAttribute('aria-label'), 'Enter full screen');
  assert.equal(toggle.button.children[0].textContent, 'fullscreen');

  toggle.button.click();
  await settle();
  assert.equal(toggle.button.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.button.children[0].textContent, 'fullscreen_exit');
  assert.equal(toggle.button.getAttribute('aria-label'), 'Exit full screen');

  pressEsc();
  assert.equal(toggle.button.getAttribute('aria-pressed'), 'false');

  assert.equal(installFullscreenToggle({ doc }), null, 'only one button');
  toggle.destroy();
  assert.equal(indicator.children.length, 0);
});

test("Safari's prefixed full-screen API works too", async () => {
  const { doc } = fakeDocument({ standard: false, prefixed: true });
  const toggle = installFullscreenToggle({ doc });
  toggle.button.click();
  await settle();
  assert.equal(toggle.button.getAttribute('aria-pressed'), 'true');
  toggle.button.click();
  await settle();
  assert.equal(toggle.button.getAttribute('aria-pressed'), 'false');
});

test('no button where full screen is unavailable (iPhone) or nothing to attach to', () => {
  assert.equal(
    installFullscreenToggle({ doc: fakeDocument({ standard: false }).doc }),
    null,
  );
  assert.equal(
    installFullscreenToggle({ doc: fakeDocument({ host: false }).doc }),
    null,
  );
  assert.equal(installFullscreenToggle({ doc: null }), null);
});
