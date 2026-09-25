import { isTrustedClientAddress } from '../../../src/keySetupCore.mjs';

const DEFAULT_USER_ID = 'gev-owner';
const COMPOSIO_TIMEOUT_MS = 30_000;

function envValue(env, name) {
  return String(env[name] || '').trim();
}

/** Connected-app tools act as the user, so only trusted devices get them. */
export function isAllowedAgentClient(req, env = process.env) {
  return isTrustedClientAddress(req?.socket?.remoteAddress, env);
}

function isComposioLink(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'composio.dev' ||
        url.hostname.endsWith('.composio.dev'))
    );
  } catch {
    return false;
  }
}

/** Find account-connection links anywhere in a Composio result. */
export function extractConnectLinks(value, found = new Set(), depth = 0) {
  if (depth > 8 || found.size >= 5) return [...found];
  if (typeof value === 'string') {
    if (isComposioLink(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) extractConnectLinks(item, found, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value))
      extractConnectLinks(item, found, depth + 1);
  }
  return [...found];
}

function isChatTool(tool) {
  return (
    tool?.type === 'function' &&
    typeof tool.function?.name === 'string' &&
    tool.function.parameters &&
    typeof tool.function.parameters === 'object'
  );
}

async function createComposioClient(apiKey) {
  const { Composio } = await import('@composio/core');
  return new Composio({ apiKey });
}

/**
 * One Composio Tool Router session per server process. Its meta tools find
 * and run app tools on demand, so the agent's prompt stays small.
 */
export function createComposioBridge({
  env = process.env,
  createClient = createComposioClient,
} = {}) {
  let keyInUse = null;
  let sessionPromise = null;
  let toolsPromise = null;

  function reset() {
    sessionPromise = null;
    toolsPromise = null;
  }

  function session() {
    const apiKey = envValue(env, 'COMPOSIO_API_KEY');
    if (!apiKey) return null;
    if (apiKey !== keyInUse) {
      keyInUse = apiKey;
      reset();
    }
    sessionPromise ??= Promise.resolve(createClient(apiKey))
      .then((client) =>
        client.sessions.create(
          envValue(env, 'GEV_COMPOSIO_USER_ID') || DEFAULT_USER_ID,
          {
            manageConnections: { enable: true, waitForConnections: false },
            sandbox: { enable: false },
          },
          { signal: AbortSignal.timeout(COMPOSIO_TIMEOUT_MS) },
        ),
      )
      .catch((error) => {
        reset();
        throw error;
      });
    return sessionPromise;
  }

  return {
    configured: () => Boolean(envValue(env, 'COMPOSIO_API_KEY')),

    async tools() {
      const current = session();
      if (!current) return [];
      toolsPromise ??= current
        .then((live) =>
          live.tools(undefined, {
            signal: AbortSignal.timeout(COMPOSIO_TIMEOUT_MS),
          }),
        )
        .then((tools) => (Array.isArray(tools) ? tools.filter(isChatTool) : []))
        .catch((error) => {
          reset();
          throw error;
        });
      return toolsPromise;
    },

    async execute(name, args) {
      const current = session();
      if (!current) return { ok: false, error: 'Composio is not configured' };
      try {
        const live = await current;
        const result = await live.execute(name, args || {}, undefined, {
          signal: AbortSignal.timeout(COMPOSIO_TIMEOUT_MS),
        });
        const connectLinks = extractConnectLinks(result?.data);
        // Links first: long results are truncated from the end before the model sees them.
        return {
          ok: !result?.error,
          ...(connectLinks.length ? { connectLinks } : {}),
          ...(result?.error ? { error: result.error } : {}),
          data: result?.data ?? null,
        };
      } catch {
        reset();
        return { ok: false, error: 'Composio request failed' };
      }
    },
  };
}
