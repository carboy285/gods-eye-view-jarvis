import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  voiceAgent = '',
  https,
  host = 'localhost',
  port = 4173,
} = {}) {
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      ...(https ? { https } : {}),
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      // Provider name only ('nvidia' | 'muse' | ''): agent keys never reach the browser.
      'import.meta.env.GEV_VOICE_AGENT': JSON.stringify(voiceAgent || ''),
    },
    // ONNX Runtime ships ready-to-run ESM; pre-bundling it would force a page
    // reload the first time the wake word loads.
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
