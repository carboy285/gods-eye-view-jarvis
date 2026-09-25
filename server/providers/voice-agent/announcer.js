import { randomUUID } from 'node:crypto';

const HEARTBEAT_MS = 25_000;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

export function isValidClientId(value) {
  return CLIENT_ID.test(String(value || ''));
}

/**
 * Server-Sent Events to open Jarvis pages. Every page shows an announcement;
 * only one speaks it: the page used most recently, else the newest page.
 */
export function createAnnouncer({
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const clients = new Map();
  let speaker = null;

  function speakingClient() {
    if (speaker && clients.has(speaker)) return speaker;
    let newest = null;
    for (const [id, client] of clients)
      if (!newest || client.connectedAt >= clients.get(newest).connectedAt)
        newest = id;
    return newest;
  }

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return {
    /** Keep an SSE response open for one page. */
    connect(clientId, req, res) {
      const previous = clients.get(clientId);
      if (previous) {
        clearIntervalImpl(previous.heartbeat);
        previous.res.end();
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.write(': connected\n\n');
      const heartbeat = setIntervalImpl(
        () => res.write(': ping\n\n'),
        HEARTBEAT_MS,
      );
      heartbeat?.unref?.();
      const client = { res, connectedAt: Date.now(), heartbeat };
      clients.set(clientId, client);
      req.on('close', () => {
        clearIntervalImpl(heartbeat);
        if (clients.get(clientId) === client) clients.delete(clientId);
      });
    },

    /** The page the user just talked to becomes the one that speaks. */
    claimSpeaker(clientId) {
      if (!clients.has(clientId)) return false;
      speaker = clientId;
      return true;
    },

    announce({ kind = 'note', text }) {
      const id = randomUUID();
      const voice = speakingClient();
      for (const [clientId, { res }] of clients)
        send(res, 'announcement', {
          id,
          kind,
          text,
          speak: clientId === voice,
        });
      return { delivered: clients.size, spoken: Boolean(voice) };
    },

    /** A named event for every open page, like sleep and wake. */
    broadcast(event, data = {}) {
      for (const { res } of clients.values()) send(res, event, data);
      return clients.size;
    },

    clientCount: () => clients.size,

    close() {
      for (const { res, heartbeat } of clients.values()) {
        clearIntervalImpl(heartbeat);
        res.end();
      }
      clients.clear();
    },
  };
}
