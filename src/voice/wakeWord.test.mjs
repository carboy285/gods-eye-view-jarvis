import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWakeWordDetector,
  isMicrophoneRefusal,
  WAKE_THRESHOLD,
} from './wakeWord.js';

function harness({ scores = [], getUserMedia, loadEngine } = {}) {
  const port = {};
  const tracks = [
    {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    },
  ];
  const context = {
    state: 'running',
    closed: false,
    createMediaStreamSource: () => ({ connect() {} }),
    close: async () => {
      context.closed = true;
    },
  };
  const wakes = [];
  const levels = [];
  let clock = 0;
  const detector = createWakeWordDetector({
    onWake: (score) => wakes.push(score),
    onLevel: (level) => levels.push(level),
    loadEngine:
      loadEngine ||
      (async () => ({ process: async () => scores.shift() ?? 0 })),
    getUserMedia: getUserMedia || (async () => ({ getTracks: () => tracks })),
    createAudioContext: () => context,
    createCaptureNode: async () => ({ port, disconnect() {} }),
    now: () => clock,
  });
  return {
    detector,
    port,
    tracks,
    context,
    wakes,
    levels,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const chunk = () => ({ data: { pcm: new Int16Array(1280).buffer } });

test('the detector wakes above the threshold, then waits out a cooldown', async () => {
  const h = harness({ scores: [0.2, 0.95, 0.97, 0.99] });
  await h.detector.start();
  h.port.onmessage(chunk());
  h.port.onmessage(chunk());
  await settle();
  assert.deepEqual(h.wakes, [0.95]);

  h.port.onmessage(chunk());
  await settle();
  assert.deepEqual(h.wakes, [0.95], 'no double trigger within the cooldown');

  h.advance(2_000);
  h.port.onmessage(chunk());
  await settle();
  assert.deepEqual(h.wakes, [0.95, 0.99]);
  assert.equal(WAKE_THRESHOLD, 0.6);
});

test('mic levels feed the visualizer', async () => {
  const h = harness();
  await h.detector.start();
  h.port.onmessage({ data: { level: 0.05 } });
  assert.deepEqual(h.levels, [0.30000000000000004]);
});

test('stop releases the microphone and ignores late audio', async () => {
  const h = harness({ scores: [0.99] });
  await h.detector.start();
  h.detector.stop();
  h.port.onmessage(chunk());
  await settle();
  assert.deepEqual(h.wakes, []);
  assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.context.closed, true);
});

test('start fails cleanly when the mic or the models are unavailable', async () => {
  const denied = harness({
    getUserMedia: async () => {
      throw Object.assign(new Error('Permission denied'), {
        name: 'NotAllowedError',
      });
    },
  });
  await assert.rejects(denied.detector.start(), { name: 'NotAllowedError' });
  assert.equal(denied.context.closed, true);

  const broken = harness({
    loadEngine: async () => {
      throw new Error('Wake-word model hey_jarvis_v0.1.onnx is missing');
    },
  });
  await assert.rejects(broken.detector.start(), /missing/);
  assert.equal(broken.tracks[0].stopped, true);
});

test('microphone refusals are told apart from other start failures', () => {
  assert.equal(isMicrophoneRefusal({ name: 'NotAllowedError' }), true);
  assert.equal(isMicrophoneRefusal({ name: 'NotFoundError' }), true);
  assert.equal(
    isMicrophoneRefusal(
      new Error(
        'This browser only allows the microphone over HTTPS or localhost',
      ),
    ),
    true,
  );
  assert.equal(
    isMicrophoneRefusal(new Error('Wake-word model missing')),
    false,
  );
});
