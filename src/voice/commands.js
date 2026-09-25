import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createAgentSession } from './agentSession.js';
import { createJarvisPanel } from './jarvisPanel.js';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options) {
  const agentProvider = options?.agentProvider;
  const controls = bindVoiceCommands({
    createSession: agentProvider
      ? (hooks) => createAgentSession({ ...hooks, agentProvider })
      : createRealtimeSession,
    ...options,
  });
  if (agentProvider && options?.jarvisPanel !== false)
    attachJarvisPanel(controls.session, options?.createPanel);
  return controls;
}

/** The Jarvis HUD follows the session and goes away with it. */
export function attachJarvisPanel(session, createPanel = createJarvisPanel) {
  if (!session?.subscribe || session.disposed || !globalThis.document)
    return null;
  const panel = createPanel();
  const unsubscribe = session.subscribe((event) => panel.handle(event));
  session.signal?.addEventListener(
    'abort',
    () => {
      unsubscribe();
      panel.destroy();
    },
    { once: true },
  );
  return panel;
}
