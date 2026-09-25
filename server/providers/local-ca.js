import { readFileSync } from 'node:fs';
import path from 'node:path';

function envPath(env, name) {
  return String(env[name] || '').trim();
}

/** The local CA certificate: GEV_HTTPS_CA, else ca.crt beside the server certificate. */
export function localCaPath(env = process.env) {
  const explicit = envPath(env, 'GEV_HTTPS_CA');
  if (explicit) return explicit;
  const cert = envPath(env, 'GEV_HTTPS_CERT');
  return cert ? path.join(path.dirname(cert), 'ca.crt') : '';
}

/** Only a public certificate may be served; anything holding a key is refused. */
export function isPublicCertificate(text) {
  return /-----BEGIN CERTIFICATE-----/.test(text) && !/PRIVATE KEY/.test(text);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Vite plugin: lets phones and laptops download the local CA to trust it. */
export function localCaDownload({
  read = readFileSync,
  env = process.env,
} = {}) {
  function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const file = localCaPath(env);
    let text = '';
    try {
      text = file ? String(read(file, 'utf8')) : '';
    } catch {
      text = '';
    }
    if (!isPublicCertificate(text))
      return sendJson(res, 404, { error: 'No local certificate authority' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="gods-eye-view-local-ca.crt"',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : text);
  }
  // Must return nothing: Vite runs a returned function as a post-middleware hook.
  const install = (server) => {
    server.middlewares.use('/api/jarvis/ca.crt', handler);
  };
  return {
    name: 'local-ca-download',
    configureServer: install,
    configurePreviewServer: install,
  };
}
