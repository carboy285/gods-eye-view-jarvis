const DEFAULT_SERVER = 'https://ntfy.sh';
const TIMEOUT_MS = 10_000;
const MAX_MESSAGE_CHARS = 500;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

function envValue(env, name) {
  return String(env[name] || '').trim();
}

/** Push notifications to the user's phone through ntfy (https://ntfy.sh). */
export function createPhoneNotifier({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const topic = () => envValue(env, 'NTFY_TOPIC');
  return {
    configured: () => TOPIC.test(topic()),

    async push({ title = 'Jarvis', message, priority = 'default' }) {
      if (!TOPIC.test(topic()))
        return { ok: false, error: 'No phone is set up (NTFY_TOPIC)' };
      const text = String(message || '')
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);
      if (!text) return { ok: false, error: 'Nothing to send' };
      const server = (envValue(env, 'NTFY_SERVER') || DEFAULT_SERVER).replace(
        /\/+$/,
        '',
      );
      const token = envValue(env, 'NTFY_TOKEN');
      try {
        const response = await fetchImpl(`${server}/`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            topic: topic(),
            title: String(title).slice(0, 80),
            message: text,
            priority: priority === 'high' ? 4 : 3,
            tags: ['robot'],
          }),
        });
        if (!response.ok) {
          console.warn(`[jarvis] phone push failed: HTTP ${response.status}`);
          return { ok: false, error: 'The phone notification failed' };
        }
        return { ok: true, sent: text };
      } catch {
        console.warn('[jarvis] phone push failed');
        return { ok: false, error: 'The phone notification failed' };
      }
    },
  };
}
