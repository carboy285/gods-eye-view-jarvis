import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';
import { createJsonFile, jarvisHome } from './store.js';

const API_ROOT = 'https://inkbox.ai/api/v1/imessage';
const REQUEST_TIMEOUT_MS = 15_000;
// Poll briskly while a conversation is going, gently otherwise.
const ACTIVE_POLL_MS = 4_000;
const IDLE_POLL_MS = 20_000;
const ACTIVE_WINDOW_MS = 10 * 60_000;
// A text that waited longer than this (PC off, service down) is not acted on.
const MAX_INBOUND_AGE_MS = 30 * 60_000;
const MAX_TEXT_CHARS = 2_000;
const MAX_SEEN = 500;

function envValue(env, name) {
  return String(env[name] || '').trim();
}

/** Digits only, US numbers without a leading 1: "+1 (555) 010-2030" and "5550102030" match. */
export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
}

/** E.164 for a phoneKey: ten digits are a US number. */
function e164(key) {
  return key.length === 10 ? `+1${key}` : `+${key}`;
}

/**
 * Jarvis over iMessage through Inkbox's shared router. It polls for new
 * texts (no public URL, so the server stays home-only), answers only the
 * owner's number, and can text the owner reminders and alerts.
 */
export function createIMessageBridge({
  env = process.env,
  fetchImpl = fetch,
  handleText,
  file = path.join(jarvisHome(), 'jarvis-imessage.json'),
  fsImpl,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const store = createJsonFile({
    file,
    fsImpl,
    empty: { conversationId: null, seen: [] },
  });
  let timer = null;
  let running = false;
  let lastActivity = 0;
  let polling = null;
  let warned = false;

  const apiKey = () => envValue(env, 'INKBOX_API_KEY');
  const owner = () => phoneKey(envValue(env, 'INKBOX_OWNER_NUMBER'));
  const configured = () => Boolean(apiKey() && owner().length >= 10);

  async function call(method, route, { params, body } = {}) {
    const url = new URL(`${API_ROOT}${route}`);
    for (const [key, value] of Object.entries(params || {}))
      url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'X-API-Key': apiKey(),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      // Never log the response body: it can echo account details.
      throw Object.assign(new Error(`Inkbox HTTP ${response.status}`), {
        status: response.status,
      });
    }
    return response.status === 204
      ? null
      : readResponseJsonCapped(response, 1024 * 1024);
  }

  async function state() {
    const data = (await store.read()) || {};
    return {
      conversationId:
        typeof data.conversationId === 'string' ? data.conversationId : null,
      seen: Array.isArray(data.seen) ? data.seen : [],
    };
  }

  /** Text the owner: into their conversation, or by number once connected. */
  async function send(text, { conversationId: into } = {}) {
    if (!configured()) return { ok: false, error: 'iMessage is not set up' };
    const message = String(text || '')
      .trim()
      .slice(0, MAX_TEXT_CHARS);
    if (!message) return { ok: false, error: 'Nothing to send' };
    const conversationId = into || (await state()).conversationId;
    try {
      await call('POST', '/messages', {
        body: conversationId
          ? { conversation_id: conversationId, text: message }
          : { to: e164(owner()), text: message },
      });
      return { ok: true, sent: message };
    } catch (error) {
      console.warn(`[imessage] send failed (${error.status || 'network'})`);
      return { ok: false, error: 'The iMessage could not be sent' };
    }
  }

  async function markRead(conversationId) {
    await call('POST', '/mark-read', {
      body: { conversation_id: conversationId },
    }).catch(() => {});
  }

  async function answer(message, current) {
    lastActivity = now();
    current.conversationId = message.conversation_id;
    await call('POST', '/typing', {
      body: { conversation_id: message.conversation_id },
    }).catch(() => {});
    let reply;
    try {
      reply = await handleText(
        String(message.content).slice(0, MAX_TEXT_CHARS),
      );
    } catch {
      reply = "Sorry, I couldn't finish that. Try again in a moment.";
    }
    if (reply) await send(reply, { conversationId: message.conversation_id });
  }

  async function poll() {
    const unread = await call('GET', '/messages', {
      params: { limit: 50, offset: 0, is_read: false },
    });
    const current = await state();
    const before = JSON.stringify(current);
    const conversations = new Set();
    const inbound = (Array.isArray(unread) ? unread : [])
      .filter(
        (message) =>
          message?.direction === 'inbound' &&
          typeof message.id === 'string' &&
          !current.seen.includes(message.id),
      )
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const message of inbound) {
      current.seen = [...current.seen, message.id].slice(-MAX_SEEN);
      if (message.conversation_id) conversations.add(message.conversation_id);
      const fromOwner =
        !message.is_group &&
        phoneKey(message.remote_number) === owner() &&
        typeof message.content === 'string' &&
        message.content.trim();
      const fresh =
        now() - Date.parse(message.created_at) <= MAX_INBOUND_AGE_MS;
      // Anyone else is ignored without a reply, so the number cannot be probed.
      if (fromOwner && fresh) await answer(message, current);
    }
    for (const id of conversations) await markRead(id);
    if (JSON.stringify(current) !== before) await store.write(current);
  }

  function schedule() {
    if (!running) return;
    const delay =
      now() - lastActivity < ACTIVE_WINDOW_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    timer = setTimeoutImpl(() => void tick(), delay);
    timer?.unref?.();
  }

  /** One poll; overlapping calls share it. */
  function tick() {
    polling ??= (configured() ? poll() : Promise.resolve())
      .then(() => {
        warned = false;
      })
      .catch((error) => {
        if (!warned)
          console.warn(
            `[imessage] polling failed (${error.status || 'network'})`,
          );
        warned = true;
      })
      .finally(() => {
        polling = null;
        schedule();
      });
    return polling;
  }

  return {
    configured,
    send,
    tick,
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    },
  };
}
