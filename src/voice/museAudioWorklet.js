export const MUSE_SAMPLE_RATE = 16_000;
/** 80 ms frames: the chunk size of Muse Voice Transcribe and openWakeWord. */
export const MUSE_FRAME_SAMPLES = 1_280;

export function requestMicrophone(constraints) {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia)
    throw new Error(
      'This browser only allows the microphone over HTTPS or localhost',
    );
  return navigator.mediaDevices.getUserMedia(constraints);
}

/** An AudioWorklet node posting { pcm } 16 kHz Int16 frames and { level }. */
export async function createPcmCaptureNode(context) {
  const moduleUrl = URL.createObjectURL(
    new Blob([MUSE_WORKLET_SOURCE], { type: 'text/javascript' }),
  );
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  return new AudioWorkletNode(context, 'muse-capture');
}

/** Linear-resample Float32 audio and convert it to little-endian PCM16. */
export function resampleToPcm16(
  input,
  inputRate,
  outputRate = MUSE_SAMPLE_RATE,
) {
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const sample =
      input[left] + (input[right] - input[left]) * (position - left);
    const clamped = Math.max(-1, Math.min(1, sample));
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

/**
 * AudioWorklet processor source. It runs in the audio thread, so it is loaded
 * from a Blob URL and must be self-contained.
 */
export const MUSE_WORKLET_SOURCE = `
const OUTPUT_RATE = ${MUSE_SAMPLE_RATE};
const FRAME = ${MUSE_FRAME_SAMPLES};
const resampleToPcm16 = (${resampleToPcm16.toString()});
class MuseCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Int16Array(FRAME);
    this.filled = 0;
    this.carry = new Float32Array(0);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const merged = new Float32Array(this.carry.length + channel.length);
    merged.set(this.carry);
    merged.set(channel, this.carry.length);
    const ratio = sampleRate / OUTPUT_RATE;
    const usable = Math.floor(Math.floor(merged.length / ratio) * ratio);
    this.carry = merged.slice(usable);
    const pcm = resampleToPcm16(merged.subarray(0, usable), sampleRate, OUTPUT_RATE);
    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    this.port.postMessage({ level: Math.sqrt(sum / channel.length) });
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(FRAME - this.filled, pcm.length - offset);
      this.pending.set(pcm.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === FRAME) {
        const frame = this.pending.buffer.slice(0);
        this.port.postMessage({ pcm: frame }, [frame]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('muse-capture', MuseCaptureProcessor);
`;
