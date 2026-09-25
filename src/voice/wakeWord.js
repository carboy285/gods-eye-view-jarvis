import { createWakeWordEngine } from './wakeWordEngine.js';
import { createPcmCaptureNode, requestMicrophone } from './museAudioWorklet.js';

/** Clean "Hey Jarvis" scores ~0.99; "Hey Travis" peaked at 0.42 in testing. */
export const WAKE_THRESHOLD = 0.6;
const COOLDOWN_MS = 2_000;
// About half a second of audio; beyond that, drop the oldest rather than lag.
const MAX_QUEUED_CHUNKS = 6;

async function loadBrowserOrt() {
  const [ort, wasm] = await Promise.all([
    import('onnxruntime-web/wasm'),
    import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
  ]);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: wasm.default };
  return ort;
}

async function fetchModel(file) {
  const response = await fetch(`/wakeword/${file}`);
  if (!response.ok) throw new Error(`Wake-word model ${file} is missing`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadBrowserEngine() {
  return createWakeWordEngine({
    ort: await loadBrowserOrt(),
    loadModel: fetchModel,
  });
}

/** True when the failure means the user (or browser) refused the microphone. */
export function isMicrophoneRefusal(error) {
  return (
    ['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(
      error?.name,
    ) || /microphone/i.test(String(error?.message || ''))
  );
}

/**
 * Listens locally for "Hey Jarvis". Audio never leaves the browser; onWake
 * fires at most once per cooldown.
 */
export function createWakeWordDetector({
  onWake,
  onLevel = () => {},
  threshold = WAKE_THRESHOLD,
  cooldownMs = COOLDOWN_MS,
  loadEngine = loadBrowserEngine,
  getUserMedia = requestMicrophone,
  createAudioContext = () => new AudioContext(),
  createCaptureNode = createPcmCaptureNode,
  now = () => Date.now(),
} = {}) {
  let stream = null;
  let context = null;
  let node = null;
  let engine = null;
  let queue = [];
  let busy = false;
  let running = false;
  let lastWake = -Infinity;

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (running && queue.length) {
        const score = await engine.process(queue.shift());
        if (running && score >= threshold && now() - lastWake >= cooldownMs) {
          lastWake = now();
          onWake(score);
        }
      }
    } finally {
      busy = false;
    }
  }

  function stop() {
    running = false;
    queue = [];
    try {
      node?.disconnect();
    } catch {
      /* already disconnected */
    }
    node = null;
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
    context?.close?.().catch?.(() => {});
    context = null;
  }

  async function start() {
    running = true;
    // Created before any await, so it belongs to the click that started voice.
    context = createAudioContext();
    const engineReady = Promise.resolve().then(loadEngine);
    // Loads alongside the mic prompt; a failure surfaces at the await below.
    engineReady.catch(() => {});
    try {
      stream = await getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (context.state === 'suspended') await context.resume();
      node = await createCaptureNode(context);
      engine = await engineReady;
    } catch (error) {
      stop();
      throw error;
    }
    if (!running) return stop();
    node.port.onmessage = ({ data }) => {
      if (typeof data?.level === 'number') onLevel(Math.min(1, data.level * 6));
      if (!running || !data?.pcm) return;
      queue.push(new Int16Array(data.pcm));
      if (queue.length > MAX_QUEUED_CHUNKS) queue.shift();
      void drain();
    };
    context.createMediaStreamSource(stream).connect(node);
  }

  return { start, stop };
}
