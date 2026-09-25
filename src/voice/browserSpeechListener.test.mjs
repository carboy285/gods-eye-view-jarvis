import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSpeechListener } from './browserSpeechListener.js';

function fakeRecognition() {
  const instances = [];
  class Recognition {
    constructor() {
      this.starts = 0;
      this.aborts = 0;
      instances.push(this);
    }
    start() {
      this.starts++;
      queueMicrotask(() => this.onstart?.());
    }
    abort() {
      this.aborts++;
      queueMicrotask(() => this.onend?.());
    }
  }
  return { Recognition, instances };
}

function result(transcript, isFinal) {
  return Object.assign([{ transcript }], { isFinal });
}

function callbacks() {
  const heard = { partial: [], final: [], errors: [], speech: 0 };
  return {
    heard,
    onPartial: (text) => heard.partial.push(text),
    onFinal: (text) => heard.final.push(text),
    onSpeechStart: () => heard.speech++,
    onLevel: () => {},
    onError: (message) => heard.errors.push(message),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('browser listener streams interim text and reports final phrases', async () => {
  const { Recognition, instances } = fakeRecognition();
  const listener = createBrowserSpeechListener({ Recognition, lang: 'en-GB' });
  const cb = callbacks();
  await listener.start(cb);
  const [recognition] = instances;
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.lang, 'en-GB');

  recognition.onspeechstart();
  recognition.onresult({ resultIndex: 0, results: [result('take me', false)] });
  recognition.onresult({
    resultIndex: 0,
    results: [result(' take me to Tokyo ', true), result('and', false)],
  });
  assert.equal(cb.heard.speech, 1);
  assert.deepEqual(cb.heard.partial, ['take me', 'and']);
  assert.deepEqual(cb.heard.final, ['take me to Tokyo']);
});

test('browser listener restarts after the browser ends it, except while muted', async () => {
  const { Recognition, instances } = fakeRecognition();
  const listener = createBrowserSpeechListener({ Recognition });
  await listener.start(callbacks());
  const [recognition] = instances;

  recognition.onend();
  assert.equal(recognition.starts, 2, 'silence timeouts do not end voice');

  listener.setMuted(true);
  await settle();
  assert.equal(recognition.aborts, 1);
  assert.equal(recognition.starts, 2, 'muted recognition stays off');

  listener.setMuted(false);
  assert.equal(recognition.starts, 3);

  listener.stop();
  await settle();
  assert.equal(recognition.starts, 3, 'a stopped listener never restarts');
});

test('browser listener reports permission errors and ignores silence', async () => {
  const { Recognition, instances } = fakeRecognition();
  const listener = createBrowserSpeechListener({ Recognition });
  const cb = callbacks();
  await listener.start(cb);
  instances[0].onerror({ error: 'no-speech' });
  instances[0].onerror({ error: 'aborted' });
  assert.deepEqual(cb.heard.errors, []);
  instances[0].onerror({ error: 'not-allowed' });
  assert.match(cb.heard.errors[0], /Microphone access was blocked/);
});

test('browser listener fails to start with a clear reason', async () => {
  await assert.rejects(
    createBrowserSpeechListener({ Recognition: undefined }).start(callbacks()),
    /no built-in speech recognition/,
  );
  class Denied {
    start() {
      queueMicrotask(() => this.onerror({ error: 'not-allowed' }));
    }
    abort() {}
  }
  await assert.rejects(
    createBrowserSpeechListener({ Recognition: Denied }).start(callbacks()),
    /Microphone access was blocked/,
  );
});
