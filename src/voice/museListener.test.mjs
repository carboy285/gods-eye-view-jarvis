import assert from 'node:assert/strict';
import test from 'node:test';
import { createMuseListener } from './museListener.js';
import { resampleToPcm16 } from './museAudioWorklet.js';

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  receive(event) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(event) }),
    );
  }
}

function harness() {
  const socket = new FakeSocket();
  const port = {};
  const listener = createMuseListener({
    getUserMedia: async () => ({ getTracks: () => [] }),
    createAudioContext: () => ({
      createMediaStreamSource: () => ({ connect() {} }),
      close: async () => {},
    }),
    createCaptureNode: async () => ({ port, disconnect() {} }),
    createWebSocket: (path) => {
      assert.equal(path, '/api/muse/asr');
      queueMicrotask(() => socket.receive({ type: 'session', sessionId: 's1' }));
      return socket;
    },
  });
  const heard = { partial: [], final: [], errors: [] };
  const callbacks = {
    onPartial: (text) => heard.partial.push(text),
    onFinal: (text) => heard.final.push(text),
    onSpeechStart: () => {},
    onLevel: () => {},
    onError: (message) => heard.errors.push(message),
  };
  return { listener, socket, port, heard, callbacks };
}

test('Muse listener commits each turn once from partials', async () => {
  const h = harness();
  await h.listener.start(h.callbacks);
  h.socket.receive({ type: 'transcript', text: 'take me to', turnId: 't1' });
  h.socket.receive({
    type: 'transcript',
    text: 'take me to Tokyo',
    turnId: 't1',
    final: true,
  });
  h.socket.receive({ type: 'speechComplete', turnId: 't1' });
  assert.deepEqual(h.heard.partial, ['take me to', 'take me to Tokyo']);
  assert.deepEqual(h.heard.final, ['take me to Tokyo']);
});

test('Muse listener sends silence while muted and ends the stream on stop', async () => {
  const h = harness();
  await h.listener.start(h.callbacks);
  const pcm = new Int16Array([1000, -1000]).buffer;

  h.listener.setMuted(true);
  h.port.onmessage({ data: { pcm } });
  assert.deepEqual(new Int16Array(h.socket.sent.at(-1)), new Int16Array(2));

  h.listener.setMuted(false);
  h.port.onmessage({ data: { pcm } });
  assert.equal(h.socket.sent.at(-1), pcm);

  h.listener.stop();
  assert.equal(JSON.parse(h.socket.sent.at(-1)).type, 'endStream');
  assert.equal(h.socket.readyState, 3);
});

test('Muse listener surfaces transcription errors', async () => {
  const h = harness();
  await h.listener.start(h.callbacks);
  h.socket.receive({ type: 'error', error: 'Muse transcription error' });
  assert.deepEqual(h.heard.errors, ['Muse transcription error']);
});

test('capture resampling produces 16 kHz little-endian PCM16', () => {
  const input = new Float32Array(48).fill(0.5);
  input[0] = -1;
  const output = resampleToPcm16(input, 48_000);
  assert.equal(output.length, 16);
  assert.equal(output[0], -32768);
  assert.equal(output[1], Math.trunc(0.5 * 0x7fff));
});
