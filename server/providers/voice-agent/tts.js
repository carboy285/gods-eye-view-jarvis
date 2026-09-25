import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const MAGPIE_HOST = 'grpc.nvcf.nvidia.com:443';
const MAGPIE_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Jason.Calm';
const TTS_TIMEOUT_MS = 20_000;
export const TTS_SAMPLE_RATE = 22_050;
export const MAX_TTS_CHARS = 1_000;

const PROTO_ROOT = fileURLToPath(new URL('./proto/', import.meta.url));

function envValue(env, name) {
  return String(env[name] || '').trim();
}

let _service;
/** Parsed on first use, so starting the dev server never reads the proto files. */
function magpieService() {
  if (_service !== undefined) return _service;
  try {
    const definition = protoLoader.loadSync('riva/proto/riva_tts.proto', {
      includeDirs: [PROTO_ROOT],
      keepCase: true,
      enums: String,
      defaults: true,
    });
    const Service =
      grpc.loadPackageDefinition(definition).nvidia.riva.tts
        .RivaSpeechSynthesis;
    _service = { grpc, Service };
  } catch {
    console.warn(
      '[voice-agent] Magpie proto failed to load; NVIDIA voice is off.',
    );
    _service = null;
  }
  return _service;
}

/** Keep speech to whole sentences within Magpie's input limit. */
export function trimForSpeech(text, limit = MAX_TTS_CHARS) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const end = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
  );
  return end > 0 ? cut.slice(0, end + 1) : cut;
}

/**
 * Streams NVIDIA Magpie speech (16-bit mono PCM at 22.05 kHz) from the hosted
 * NVCF endpoint, authenticated with the NVIDIA API key.
 */
export function createMagpieSynthesizer({
  env = process.env,
  loadService = magpieService,
} = {}) {
  let client = null;
  let keyInUse = null;

  function currentClient(apiKey) {
    const service = loadService();
    if (!service) return null;
    if (!client || keyInUse !== apiKey) {
      client?.close();
      client = new service.Service(
        MAGPIE_HOST,
        service.grpc.credentials.createSsl(),
      );
      keyInUse = apiKey;
    }
    return { client, grpc: service.grpc };
  }

  return {
    configured: () => Boolean(envValue(env, 'NVIDIA_API_KEY')),

    /** Calls onAudio(Buffer) per chunk; resolves when done, rejects on failure. */
    stream(text, { onAudio, signal }) {
      const apiKey = envValue(env, 'NVIDIA_API_KEY');
      const connection = apiKey ? currentClient(apiKey) : null;
      if (!connection) return Promise.reject(new Error('NVIDIA voice is off'));
      const metadata = new connection.grpc.Metadata();
      metadata.set('function-id', MAGPIE_FUNCTION_ID);
      metadata.set('authorization', `Bearer ${apiKey}`);
      return new Promise((resolve, reject) => {
        const call = connection.client.SynthesizeOnline(metadata, {
          deadline: Date.now() + TTS_TIMEOUT_MS,
        });
        const cancel = () => call.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        const finish = (error) => {
          signal?.removeEventListener('abort', cancel);
          if (error) reject(error);
          else resolve();
        };
        call.on('data', (response) => {
          if (response?.audio?.length) onAudio(Buffer.from(response.audio));
        });
        call.on('error', finish);
        call.on('end', () => finish());
        call.write({
          text,
          language_code: 'en-US',
          encoding: 'LINEAR_PCM',
          sample_rate_hz: TTS_SAMPLE_RATE,
          voice_name: envValue(env, 'NVIDIA_TTS_VOICE') || DEFAULT_VOICE,
        });
        call.end();
      });
    },
  };
}
