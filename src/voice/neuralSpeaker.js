const START_LEAD_SECONDS = 0.05;

/** Little-endian 16-bit PCM bytes to Float32 samples. */
export function pcm16ToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  return samples;
}

/**
 * Plays NVIDIA voice from /api/agent/tts as the audio streams in. speak()
 * resolves when playback ends and rejects if no audio could be fetched, so the
 * caller can fall back to the browser's own speech.
 */
export function createNeuralSpeaker({
  fetchImpl = (...args) => fetch(...args),
  createAudioContext = () => new AudioContext(),
} = {}) {
  let context = null;
  let analyser = null;
  let levels = null;
  let current = null;

  function audio() {
    if (!context) {
      context = createAudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(context.destination);
      levels = new Float32Array(analyser.fftSize);
    }
    return context;
  }

  function cancel() {
    const playing = current;
    current = null;
    if (!playing) return;
    playing.controller.abort();
    for (const source of playing.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    playing.finish();
  }

  async function speak(text) {
    cancel();
    const ctx = audio();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const controller = new AbortController();
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const playing = { controller, sources: new Set(), finish };
    current = playing;

    const response = await fetchImpl('/api/agent/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error('NVIDIA voice unavailable');
    const rate = Number(response.headers.get('X-Sample-Rate')) || 22_050;

    let playhead = ctx.currentTime + START_LEAD_SECONDS;
    let carry = null;
    let pending = 0;
    let streamDone = false;
    const settle = () => {
      if (streamDone && pending === 0) {
        if (current === playing) current = null;
        finish();
      }
    };

    const reader = response.body.getReader();
    let scheduled = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // Keep what already played; only a stream that never produced audio fails.
        if (!scheduled) throw error;
        break;
      }
      const { value, done: ended } = chunk;
      if (ended || current !== playing) break;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry);
        bytes.set(value, carry.length);
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes.slice(-1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      const samples = pcm16ToFloat32(bytes);
      if (!samples.length) continue;
      const buffer = ctx.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      playhead = Math.max(playhead, ctx.currentTime + START_LEAD_SECONDS);
      source.start(playhead);
      playhead += buffer.duration;
      playing.sources.add(source);
      pending++;
      scheduled++;
      source.onended = () => {
        playing.sources.delete(source);
        pending--;
        settle();
      };
    }
    streamDone = true;
    settle();
    return done;
  }

  return {
    speak,
    cancel,
    /** Unlock audio inside the click that starts voice (browser autoplay rules). */
    prepare() {
      const ctx = audio();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    /** Current output loudness, 0..1, for the visualizer. */
    level() {
      if (!analyser || !current) return 0;
      analyser.getFloatTimeDomainData(levels);
      let sum = 0;
      for (const sample of levels) sum += sample * sample;
      return Math.min(1, Math.sqrt(sum / levels.length) * 4);
    },
  };
}
