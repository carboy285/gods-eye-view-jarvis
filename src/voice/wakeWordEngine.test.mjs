import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createWakeWordEngine, WAKE_CHUNK_SAMPLES } from './wakeWordEngine.js';
import { WAKE_THRESHOLD } from './wakeWord.js';

const ort = await import('onnxruntime-web');
ort.env.wasm.numThreads = 1;

const modelDir = new URL('../../public/wakeword/', import.meta.url);
// 16 kHz mono PCM16 clips synthesized with NVIDIA Magpie (Jason, calm voice).
const clip = (name) => {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
};

const engine = await createWakeWordEngine({
  ort,
  loadModel: (file) => readFileSync(new URL(file, modelDir)),
});

async function peakScore(samples) {
  engine.reset();
  // Settle the buffers on two seconds of silence, as a detector would be.
  for (let chunk = 0; chunk < 25; chunk++)
    await engine.process(new Int16Array(WAKE_CHUNK_SAMPLES));
  let peak = 0;
  for (
    let offset = 0;
    offset + WAKE_CHUNK_SAMPLES <= samples.length;
    offset += WAKE_CHUNK_SAMPLES
  )
    peak = Math.max(
      peak,
      await engine.process(
        samples.subarray(offset, offset + WAKE_CHUNK_SAMPLES),
      ),
    );
  return peak;
}

test('"Hey Jarvis" wakes the engine with a clear margin', async () => {
  assert.ok((await peakScore(clip('hey-jarvis-16k.pcm'))) > 0.9);
});

test('near misses and ordinary speech stay under the threshold', async () => {
  assert.ok((await peakScore(clip('hey-travis-16k.pcm'))) < WAKE_THRESHOLD);
  assert.ok((await peakScore(clip('not-wake-16k.pcm'))) < 0.1);
});

test('the first 1.6 s of scores are held back while buffers settle', async () => {
  engine.reset();
  const scores = [];
  for (let chunk = 0; chunk < 21; chunk++)
    scores.push(await engine.process(new Int16Array(WAKE_CHUNK_SAMPLES)));
  // 16 chunks to fill the feature window, then 5 settling predictions.
  assert.deepEqual(scores.slice(0, 20), new Array(20).fill(0));
  assert.equal(typeof scores[20], 'number');
});

test('chunks must be exactly 80 ms', async () => {
  await assert.rejects(engine.process(new Int16Array(100)), RangeError);
});
