import { readFileSync } from 'node:fs';

function envPath(env, name) {
  return String(env[name] || '').trim();
}

// Every TLS connection opens with a handshake record; plain HTTP opens with a method name.
const TLS_HANDSHAKE = 0x16;
const SAFE_HOST =
  /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** The 301 a plain-HTTP request gets: same host and path, https scheme. */
export function plainHttpRedirect(head) {
  const text = head.toString('latin1');
  const target = /^[A-Z]+ (\/\S*) HTTP\/1\.[01]\r?\n/.exec(text)?.[1] || '/';
  const host = /\r?\nhost:[ \t]*([^\r\n]+)/i.exec(text)?.[1]?.trim();
  if (!host || !SAFE_HOST.test(host))
    return 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
  const location = `https://${host}${target}`;
  return `HTTP/1.1 301 Moved Permanently\r\nLocation: ${location}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
}

/**
 * One port, both schemes: TLS connections go to the HTTPS server as before,
 * and a plain http:// request is answered with a redirect to https://.
 */
export function redirectPlainHttp(server) {
  const tlsListeners = server.listeners('connection');
  server.removeAllListeners('connection');
  server.on('connection', (socket) => {
    socket.on('error', () => socket.destroy());
    socket.once('data', (data) => {
      socket.pause();
      if (data[0] === TLS_HANDSHAKE) {
        socket.unshift(data);
        for (const listener of tlsListeners) listener.call(server, socket);
        process.nextTick(() => socket.resume());
        return;
      }
      socket.end(plainHttpRedirect(data));
    });
  });
}

/** Vite plugin: install the redirect on the dev server's HTTPS listener. */
export function plainHttpRedirectPlugin() {
  return {
    name: 'plain-http-redirect',
    configureServer(server) {
      if (server.httpServer) redirectPlainHttp(server.httpServer);
    },
  };
}

/** HTTPS key pair from GEV_HTTPS_CERT / GEV_HTTPS_KEY, or undefined for plain HTTP. */
export function loadHttpsCredentials(env = process.env, read = readFileSync) {
  const cert = envPath(env, 'GEV_HTTPS_CERT');
  const key = envPath(env, 'GEV_HTTPS_KEY');
  if (!cert || !key) return undefined;
  try {
    return { cert: read(cert), key: read(key) };
  } catch {
    // A missing certificate must not take the whole server down.
    console.warn(
      '[https] GEV_HTTPS_CERT or GEV_HTTPS_KEY could not be read; serving plain HTTP.',
    );
    return undefined;
  }
}
