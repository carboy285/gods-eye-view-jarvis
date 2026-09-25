import assert from 'node:assert/strict';
import test from 'node:test';
import { createNeuralSpeaker, pcm16ToFloat32 } from './neuralSpeaker.js';

function fakeAudioContext() {
  const scheduled = [];
  const context = {
    state: 'running',
    currentTime: 1,
    destination: {},
    scheduled,
    createAnalyser: () => ({
      fftSize: 0,
      connect() {},
      getFloatTimeDomainData(target) {
        target.fill(0.1);
      },
    }),
    createBuffer: (channels, length, rate) => {
      const data = new Float32Array(length);
      return {
        duration: length / rate,
        data,
        copyToChannel: (samples) => data.set(samples),
      };
    },
    createBufferSource: () => {
      const source = {
        connect() {},
        start(at) {
          source.startedAt = at;
          scheduled.push(source);
        },
        stop() {
          source.stopped = true;
        },
      };
      return source;
    },
    resume: async () => {},
  };
  return context;
}

function streamResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'X-Sample-Rate': '4' } });
}

test('PCM16 little-endian bytes become float samples', () => {
  assert.deepEqual(
    [...pcm16ToFloat32(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x01]))],
    [0.5, -0.5],
  );
});

test('streamed audio is scheduled back to back, even across odd chunk splits', async () => {
  const context = fakeAudioContext();
  const requests = [];
  const speaker = createNeuralSpeaker({
    createAudioContext: () => context,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      // Two samples split mid-sample, then two more.
      return streamResponse([[0x00, 0x40, 0x00], [0xc0], [0x00, 0x40, 0x00, 0x40]]);
    },
  });
  const done = speaker.speak('Hello.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [{ url: '/api/agent/tts', body: { text: 'Hello.' } }]);
  assert.deepEqual(
    context.scheduled.map((source) => [...source.buffer.data]),
    [[0.5], [-0.5], [0.5, 0.5]],
  );
  const starts = context.scheduled.map((source) => source.startedAt);
  assert.equal(starts[0], 1.05);
  assert.equal(starts[1], 1.3, 'each chunk starts when the previous one ends');
  assert.ok(speaker.level() > 0);
  for (const source of context.scheduled) source.onended();
  await done;
  assert.equal(speaker.level(), 0, 'quiet once playback ends');
});

test('speak rejects when no audio comes, so the caller can fall back', async () => {
  const speaker = createNeuralSpeaker({
    createAudioContext: fakeAudioContext,
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  await assert.rejects(speaker.speak('Hi.'), /NVIDIA voice unavailable/);
});

test('cancel stops scheduled audio and settles playback', async () => {
  const context = fakeAudioContext();
  const speaker = createNeuralSpeaker({
    createAudioContext: () => context,
    fetchImpl: async () => streamResponse([[0x00, 0x40]]),
  });
  const done = speaker.speak('Hello.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  speaker.cancel();
  await done;
  assert.equal(context.scheduled[0].stopped, true);
});
