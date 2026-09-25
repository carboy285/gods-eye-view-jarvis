import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  loadHttpsCredentials,
  plainHttpRedirect,
} from '../../server/standalone/https.js';
import {
  isPublicCertificate,
  localCaDownload,
  localCaPath,
} from '../../server/providers/local-ca.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { requestAuthority } from '../../server/standalone/key-setup.js';

const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';

test('HTTPS turns on only when both certificate files are set and readable', (t) => {
  const files = { '/c/server.crt': 'cert-bytes', '/c/server.key': 'key-bytes' };
  const read = (file) => {
    if (!(file in files)) throw new Error('ENOENT');
    return files[file];
  };
  assert.deepEqual(
    loadHttpsCredentials(
      { GEV_HTTPS_CERT: '/c/server.crt', GEV_HTTPS_KEY: '/c/server.key' },
      read,
    ),
    { cert: 'cert-bytes', key: 'key-bytes' },
  );
  assert.equal(
    loadHttpsCredentials({ GEV_HTTPS_CERT: '/c/server.crt' }, read),
    undefined,
  );
  assert.equal(loadHttpsCredentials({}, read), undefined);
  t.mock.method(console, 'warn', () => {});
  assert.equal(
    loadHttpsCredentials(
      { GEV_HTTPS_CERT: '/c/missing.crt', GEV_HTTPS_KEY: '/c/server.key' },
      read,
    ),
    undefined,
    'unreadable files fall back to plain HTTP',
  );
});

test('the dev server uses the credentials when given', () => {
  const https = { cert: 'c', key: 'k' };
  assert.deepEqual(createBrowserViteConfig({ https }).server.https, https);
  assert.equal('https' in createBrowserViteConfig().server, false);
});

test('the CA path defaults to ca.crt beside the server certificate', () => {
  assert.equal(
    localCaPath({ GEV_HTTPS_CERT: '/home/u/certs/server.crt' }),
    path.join('/home/u/certs', 'ca.crt'),
  );
  assert.equal(
    localCaPath({ GEV_HTTPS_CA: '/x/ca.pem', GEV_HTTPS_CERT: '/y/s.crt' }),
    '/x/ca.pem',
  );
  assert.equal(localCaPath({}), '');
});

function route(options) {
  const routes = new Map();
  localCaDownload(options).configureServer({
    middlewares: { use: (name, handler) => routes.set(name, handler) },
  });
  return routes.get('/api/jarvis/ca.crt');
}

function call(handler, method = 'GET') {
  const headers = {};
  let body;
  const res = {
    statusCode: 200,
    setHeader: (name, value) => (headers[name.toLowerCase()] = value),
    end: (text) => (body = text),
  };
  handler({ method }, res);
  return { status: res.statusCode, headers, body };
}

test('phones can download the public CA certificate', () => {
  const handler = route({
    env: { GEV_HTTPS_CERT: '/certs/server.crt' },
    read: (file) => {
      assert.equal(file, path.join('/certs', 'ca.crt'));
      return CERT;
    },
  });
  const ok = call(handler);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/x-x509-ca-cert');
  assert.equal(ok.body, CERT);
  assert.equal(call(handler, 'HEAD').body, undefined);
  assert.equal(call(handler, 'POST').status, 405);
});

test('the download never serves a private key or a missing file', () => {
  const leaky = route({
    env: { GEV_HTTPS_CA: '/certs/ca.key' },
    read: () => KEY,
  });
  assert.equal(call(leaky).status, 404);
  const bundled = route({
    env: { GEV_HTTPS_CA: '/certs/both.pem' },
    read: () => CERT + KEY,
  });
  assert.equal(call(bundled).status, 404);
  const missing = route({
    env: { GEV_HTTPS_CERT: '/certs/server.crt' },
    read: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(call(missing).status, 404);
  assert.equal(call(route({ env: {} })).status, 404);
  assert.equal(isPublicCertificate(CERT), true);
  assert.equal(isPublicCertificate(KEY), false);
});

test('plain http:// requests are redirected to https:// on the same host and path', () => {
  const request = (text) => Buffer.from(text, 'latin1');
  assert.equal(
    plainHttpRedirect(
      request('GET /a/b?x=1 HTTP/1.1\r\nHost: 192.168.1.10:4173\r\n\r\n'),
    ),
    'HTTP/1.1 301 Moved Permanently\r\nLocation: https://192.168.1.10:4173/a/b?x=1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  );
  assert.match(
    plainHttpRedirect(request('GET / HTTP/1.1\r\nHost: [::1]:4173\r\n\r\n')),
    /Location: https:\/\/\[::1\]:4173\/\r\n/,
  );
  for (const bad of [
    'GET / HTTP/1.1\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: evil.example/\r\nX: 1\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: a b\r\n\r\n',
  ])
    assert.match(plainHttpRedirect(request(bad)), /^HTTP\/1\.1 400 /);
});

test('POWER UP reads the HTTP/2 :authority when there is no Host header', () => {
  assert.equal(
    requestAuthority({ headers: { host: 'localhost:4173' } }),
    'localhost:4173',
  );
  // Browsers speak HTTP/2 over HTTPS, which carries :authority, not Host.
  assert.equal(
    requestAuthority({ headers: { ':authority': '192.168.1.10:4173' } }),
    '192.168.1.10:4173',
  );
  assert.equal(requestAuthority({ headers: {} }), undefined);
});
