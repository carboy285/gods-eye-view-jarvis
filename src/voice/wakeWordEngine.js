/**
 * openWakeWord's "hey jarvis" pipeline, one 80 ms chunk at a time:
 * 16 kHz audio -> melspectrogram (8 frames x 32) -> speech embedding over the
 * last 76 frames (96 values) -> wake-word score over the last 16 embeddings.
 * Mirrors openWakeWord's AudioFeatures streaming logic (v0.5.1 models).
 */
export const WAKE_CHUNK_SAMPLES = 1_280;
const MEL_CONTEXT_SAMPLES = 480;
const MEL_BINS = 32;
const EMBEDDING_WINDOW = 76;
const EMBEDDING_SIZE = 96;
const FEATURE_FRAMES = 16;
// openWakeWord ignores the first predictions while its buffers settle.
const WARMUP_PREDICTIONS = 5;

export const WAKE_MODEL_FILES = Object.freeze({
  melspectrogram: 'melspectrogram.onnx',
  embedding: 'embedding_model.onnx',
  wakeWord: 'hey_jarvis_v0.1.onnx',
});

async function session(ort, loadModel, file) {
  return ort.InferenceSession.create(await loadModel(file));
}

export async function createWakeWordEngine({ ort, loadModel }) {
  const [melModel, embeddingModel, wakeModel] = await Promise.all([
    session(ort, loadModel, WAKE_MODEL_FILES.melspectrogram),
    session(ort, loadModel, WAKE_MODEL_FILES.embedding),
    session(ort, loadModel, WAKE_MODEL_FILES.wakeWord),
  ]);

  let context;
  let melFrames;
  let embeddings;
  let predictions;

  function reset() {
    context = new Float32Array(MEL_CONTEXT_SAMPLES);
    // openWakeWord seeds the spectrogram buffer with ones.
    melFrames = Array.from({ length: EMBEDDING_WINDOW }, () =>
      new Float32Array(MEL_BINS).fill(1),
    );
    embeddings = [];
    predictions = 0;
  }

  async function run(model, data, dims) {
    const output = await model.run({
      [model.inputNames[0]]: new ort.Tensor('float32', data, dims),
    });
    return output[model.outputNames[0]].data;
  }

  /** Feed one 1,280-sample Int16 chunk; returns the wake-word score (0..1). */
  async function process(chunk) {
    if (chunk.length !== WAKE_CHUNK_SAMPLES)
      throw new RangeError(
        `Wake-word chunks must be ${WAKE_CHUNK_SAMPLES} samples`,
      );
    // The model expects raw int16 magnitudes as floats, not -1..1.
    const samples = new Float32Array(MEL_CONTEXT_SAMPLES + chunk.length);
    samples.set(context);
    for (let index = 0; index < chunk.length; index++)
      samples[MEL_CONTEXT_SAMPLES + index] = chunk[index];
    context = samples.slice(-MEL_CONTEXT_SAMPLES);

    const mel = await run(melModel, samples, [1, samples.length]);
    for (let frame = 0; frame + MEL_BINS <= mel.length; frame += MEL_BINS) {
      const row = new Float32Array(MEL_BINS);
      for (let bin = 0; bin < MEL_BINS; bin++)
        row[bin] = mel[frame + bin] / 10 + 2;
      melFrames.push(row);
    }
    melFrames = melFrames.slice(-EMBEDDING_WINDOW);

    const window = new Float32Array(EMBEDDING_WINDOW * MEL_BINS);
    melFrames.forEach((row, index) => window.set(row, index * MEL_BINS));
    const embedding = await run(embeddingModel, window, [
      1,
      EMBEDDING_WINDOW,
      MEL_BINS,
      1,
    ]);
    embeddings.push(Float32Array.from(embedding.slice(0, EMBEDDING_SIZE)));
    if (embeddings.length > FEATURE_FRAMES) embeddings.shift();
    if (embeddings.length < FEATURE_FRAMES) return 0;

    const features = new Float32Array(FEATURE_FRAMES * EMBEDDING_SIZE);
    embeddings.forEach((row, index) =>
      features.set(row, index * EMBEDDING_SIZE),
    );
    const [score] = await run(wakeModel, features, [
      1,
      FEATURE_FRAMES,
      EMBEDDING_SIZE,
    ]);
    predictions++;
    return predictions <= WARMUP_PREDICTIONS ? 0 : score;
  }

  reset();
  return { process, reset };
}
