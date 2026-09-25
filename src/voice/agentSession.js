import { resetVoiceVisualizerBars } from './realtimeInputPolicy.js';
import { createMuseListener } from './museListener.js';
import { createBrowserSpeechListener } from './browserSpeechListener.js';
import { createNeuralSpeaker } from './neuralSpeaker.js';
import { createWakeWordDetector, isMicrophoneRefusal } from './wakeWord.js';
import { panelCommand } from './jarvisPanel.js';
import { isSleepCommand } from './sleepCommands.js';

const MAX_TOOL_STEPS = 8;
const MAX_HISTORY = 40;
const TOOL_RESULT_CHARS = 12_000;
/** After Jarvis answers, keep listening this long so follow-ups skip the wake word. */
const FOLLOW_UP_MS = 8_000;
const STANDBY_DETAIL = 'Say "Hey Jarvis"';
const STAND_DOWN =
  /^(?:(?:hey )?jarvis[,.]? )?(?:stand down|(?:go (?:to|into|on) )?stand ?-?by(?: mode)?|never ?mind|cancel(?: that)?|forget it|that'?s all)(?:,? please)?[.!]?$/i;

/** Whole-utterance commands that cancel instead of going to the agent. */
export function isStandDown(text) {
  return STAND_DOWN.test(String(text || '').trim());
}

/** A short rising two-note chime so you know Jarvis heard its name. */
function createChime() {
  let context = null;
  return {
    prepare() {
      try {
        context ??= new AudioContext();
        if (context.state === 'suspended') context.resume().catch(() => {});
      } catch {
        context = null;
      }
    },
    play() {
      if (!context) return;
      const start = context.currentTime;
      for (const [offset, frequency] of [
        [0, 660],
        [0.1, 990],
      ]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(0.12, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.13);
      }
    },
  };
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function serializeToolResult(result) {
  let text;
  try {
    text = JSON.stringify(result ?? { ok: true });
  } catch {
    text = JSON.stringify({ ok: false, error: 'Result could not be encoded' });
  }
  return text.length > TOOL_RESULT_CHARS
    ? `${text.slice(0, TOOL_RESULT_CHARS)}…[truncated]`
    : text;
}

function formatAltitude(heightM) {
  return heightM >= 10_000
    ? `${Math.round(heightM / 1000)} km`
    : `${Math.round(heightM)} m`;
}

/** One line of live map state for the agent, from get_current_view_state. */
export function summarizeViewState(view) {
  if (!view?.ok) return '';
  const parts = [];
  const { latitude, longitude, heightM } = view.camera || {};
  if ([latitude, longitude, heightM].every(Number.isFinite))
    parts.push(
      `camera over ${latitude.toFixed(2)}, ${longitude.toFixed(2)} at ${formatAltitude(heightM)}`,
    );
  if (view.style) parts.push(`style ${view.style}`);
  const layers = (Array.isArray(view.layers) ? view.layers : [])
    .filter((layer) => layer?.enabled)
    .map((layer) => {
      const state =
        layer.feedState && layer.feedState !== 'nominal'
          ? `, ${layer.feedState}`
          : '';
      return `${layer.name || layer.id} (${layer.count ?? 0}${state})`;
    });
  parts.push(
    layers.length ? `layers on: ${layers.join(', ')}` : 'no layers on',
  );
  const tracked = (Array.isArray(view.tracked) ? view.tracked : [])
    .map((entity) => {
      const label =
        entity.callsign || entity.name || entity.registration || entity.id;
      return label ? `${entity.kind || 'contact'} ${label}` : null;
    })
    .filter(Boolean);
  if (tracked.length) parts.push(`tracking ${tracked.join(', ')}`);
  return parts.join('; ');
}

/** Plain spoken sentences from a reply, even when the model sends markdown. */
export function speakableText(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]+/g, '')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/:\./g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only Composio's own https pages may be offered as an account-connect link. */
export function safeConnectLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'composio.dev' ||
        url.hostname.endsWith('.composio.dev'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Drop the oldest whole turns so tool calls always keep their results. */
export function trimAgentHistory(messages, limit = MAX_HISTORY) {
  let start = 0;
  while (messages.length - start > limit) {
    start++;
    while (start < messages.length && messages[start].role !== 'user') start++;
  }
  return start ? messages.slice(start) : messages;
}

function defaultListener(agentProvider) {
  return agentProvider === 'muse'
    ? createMuseListener()
    : createBrowserSpeechListener();
}

/**
 * Voice adapter for a chat-completions agent (NVIDIA NIM or Meta Muse): a
 * listener turns speech into text, the server-side agent calls GEV tools, and
 * the browser speaks the reply.
 */
export function createAgentSession({
  agentProvider = 'nvidia',
  emit,
  runAction,
  signal,
  ui,
  createListener = () => defaultListener(agentProvider),
  fetchImpl = (...args) => fetch(...args),
  neuralSpeaker = agentProvider === 'nvidia'
    ? createNeuralSpeaker({ fetchImpl })
    : null,
  speech = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
  // null keeps the always-listening mode (no wake word).
  createWakeWord = (options) => createWakeWordDetector(options),
  chime = createChime(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (id) => clearTimeout(id),
  // null disables reminders and other announcements from the server.
  createEventSource = globalThis.EventSource
    ? (url) => new EventSource(url)
    : null,
  clientId = globalThis.crypto?.randomUUID?.() ||
    `page-${Math.random().toString(36).slice(2, 12)}`,
}) {
  let listener = null;
  let messages = [];
  let turn = null;
  let speaking = null;
  let frame = null;
  let active = false;
  let mode = 'continuous';
  let wake = null;
  let followUpTimer = null;
  let events = null;
  // Set while "Goodnight" is being said; the page sleeps when it finishes.
  let sleepPending = null;
  const pendingAnnouncements = [];

  const bars = () => ui?.root?.querySelectorAll('.gev-voice-visualizer span');

  function setState(state, detail) {
    emit({ type: 'state', state, detail });
  }

  function setSpeaker(speaker) {
    if (ui?.root) ui.root.dataset.speaker = speaker;
  }

  function showLevel(level) {
    const list = bars();
    if (!list) return;
    let index = 0;
    for (const bar of list) {
      const shaped = Math.min(1, level * (0.7 + ((index * 7) % 5) * 0.12));
      bar.style.setProperty(
        '--audio-level',
        `${Math.round(5 + shaped * 29)}px`,
      );
      bar.style.setProperty('--audio-opacity', String(0.56 + shaped * 0.44));
      index++;
    }
  }

  function animateSpeech() {
    if (frame !== null) cancelFrame(frame);
    const tick = (time) => {
      if (!speaking) {
        frame = null;
        resetVoiceVisualizerBars(bars());
        return;
      }
      const measured = neuralSpeaker?.level() || 0;
      showLevel(measured || 0.35 + 0.3 * Math.abs(Math.sin(time / 140)));
      frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
  }

  /** In wake mode, speaking ends in the follow-up window unless told not to. */
  function finishSpeaking({ resume = true } = {}) {
    speaking = null;
    setSpeaker('idle');
    if (sleepPending) {
      const { until } = sleepPending;
      sleepPending = null;
      return fallAsleep(until);
    }
    if (resume && active && !turn && pendingAnnouncements.length)
      return announce(pendingAnnouncements.shift());
    if (mode === 'continuous') listener?.setMuted(false);
    else if (resume && active && !turn)
      void openListening('Go ahead', { followUp: true });
  }

  /** Speak a reminder or other server announcement, with a chime first. */
  function announce(text) {
    if (mode === 'wake') {
      clearFollowUp();
      setState('speaking', text);
    } else if (ui?.detail) ui.detail.textContent = text;
    chime?.play();
    speak(text);
  }

  function handleAnnouncement(event) {
    const text = typeof event?.text === 'string' ? event.text.trim() : '';
    if (!active || !text) return;
    emit({ type: 'announcement', kind: String(event.kind || 'note') });
    emit({ type: 'transcript', role: 'assistant', text, final: true });
    // Another of the user's devices speaks it; this one only shows it.
    if (!event.speak) {
      if (!turn && ui?.detail) ui.detail.textContent = text;
      return;
    }
    if (turn || speaking) pendingAnnouncements.push(text);
    else announce(text);
  }

  /** Sleep mode: finish any "Goodnight", then turn the microphone off. */
  function fallAsleep(until = null) {
    if (speaking) {
      sleepPending = { until: until ?? sleepPending?.until ?? null };
      return;
    }
    if (active) stop();
    emit({ type: 'sleep', until });
    setState('idle', 'Jarvis is asleep');
  }

  function requestSleep() {
    Promise.resolve()
      .then(() =>
        fetchImpl('/api/jarvis/sleep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sleep' }),
        }),
      )
      .catch(() => {});
  }

  /** This page is the one the user is using, so announcements speak here. */
  function claimSpeaker() {
    if (!events) return;
    Promise.resolve()
      .then(() =>
        fetchImpl('/api/jarvis/speaker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: clientId }),
        }),
      )
      .catch(() => {});
  }

  function connectAnnouncements() {
    if (!createEventSource || events) return;
    try {
      events = createEventSource(
        `/api/jarvis/events?client=${encodeURIComponent(clientId)}`,
      );
    } catch {
      events = null;
      return;
    }
    events.addEventListener('open', claimSpeaker);
    events.addEventListener('sleep', (message) => {
      let until = null;
      try {
        until = JSON.parse(message.data)?.until ?? null;
      } catch {
        /* sleep anyway */
      }
      fallAsleep(until);
    });
    events.addEventListener('wake', () => emit({ type: 'wake' }));
    events.addEventListener('announcement', (message) => {
      try {
        handleAnnouncement(JSON.parse(message.data));
      } catch {
        /* ignore malformed events */
      }
    });
  }

  function stopSpeaking({ resume = true } = {}) {
    if (!speaking) return false;
    finishSpeaking({ resume });
    neuralSpeaker?.cancel();
    speech?.cancel();
    return true;
  }

  function speakWithBrowser(text, token) {
    if (!speech || typeof Utterance !== 'function') {
      if (speaking === token) finishSpeaking();
      return;
    }
    speech.cancel();
    const utterance = new Utterance(text);
    const finish = () => {
      if (speaking === token) finishSpeaking();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speech.speak(utterance);
  }

  /** NVIDIA's neural voice when available, otherwise the browser's own. */
  function speak(text) {
    if (!text) return;
    const token = {};
    speaking = token;
    // Wake mode stops recognition while talking; the wake word still listens.
    if (mode === 'wake') stopListening();
    else listener?.setMuted(true);
    setSpeaker('ai');
    animateSpeech();
    if (!neuralSpeaker) return speakWithBrowser(text, token);
    neuralSpeaker.speak(text).then(
      () => {
        if (speaking === token) finishSpeaking();
      },
      () => {
        if (speaking === token) speakWithBrowser(text, token);
      },
    );
  }

  function showConnectLink(href) {
    emit({ type: 'connect-link', href });
    const doc = globalThis.document;
    if (!ui?.root?.appendChild || !doc) return;
    let link = ui.root.querySelector('.gev-agent-connect');
    if (!link) {
      link = doc.createElement('a');
      link.className = 'gev-agent-connect';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Connect your account ↗';
      link.addEventListener('click', () => setTimeout(() => link.remove(), 0));
      ui.root.appendChild(link);
    }
    link.href = href;
  }

  async function runOnServer(name, args, turnSignal) {
    const response = await fetchImpl('/api/agent/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
      signal: turnSignal,
    });
    const result = await response
      .json()
      .catch(() => ({ ok: false, error: 'Tool failed' }));
    const link = (
      Array.isArray(result?.connectLinks) ? result.connectLinks : []
    )
      .map(safeConnectLink)
      .find(Boolean);
    if (link) showConnectLink(link);
    return result;
  }

  async function viewContext(turnSignal) {
    try {
      return summarizeViewState(
        await runAction('get_current_view_state', {}, { signal: turnSignal }),
      );
    } catch (error) {
      if (turnSignal.aborted || error?.name === 'AbortError') throw error;
      return '';
    }
  }

  async function postChat(turnSignal, context) {
    const response = await fetchImpl('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, context }),
      signal: turnSignal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data?.detail || data?.error || 'Agent request failed');
    return data.message || {};
  }

  async function runTurn(text, turnSignal) {
    messages = trimAgentHistory([...messages, { role: 'user', content: text }]);
    setState('executing', 'Thinking');
    const context = await viewContext(turnSignal);
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const message = await postChat(turnSignal, context);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      messages.push({
        role: 'assistant',
        content: message.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      if (!toolCalls.length) return message.content || '';
      for (const call of toolCalls) {
        const name = call.function?.name;
        setState(
          'executing',
          name
            ? name
                .replace(/^COMPOSIO_/, '')
                .replaceAll('_', ' ')
                .toLowerCase()
            : 'Working',
        );
        const args = parseArguments(call.function?.arguments);
        let result;
        try {
          result =
            call.runOn === 'server'
              ? await runOnServer(name, args, turnSignal)
              : await runAction(name, args, { signal: turnSignal });
        } catch (error) {
          if (turnSignal.aborted || error?.name === 'AbortError') throw error;
          result = { ok: false, error: error?.message || 'Action failed' };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: serializeToolResult(result),
        });
      }
    }
    return 'I ran out of steps for that request.';
  }

  function cancelTurn(reason) {
    if (!turn) return false;
    turn.abort();
    turn = null;
    emit({ type: 'interruption', reason });
    return true;
  }

  async function handleUserText(rawText) {
    const text = String(rawText || '').trim();
    if (!text || !active) return;
    if (isStandDown(text)) {
      const stopped = cancelTurn('stand-down');
      if (stopSpeaking({ resume: false }) && !stopped)
        emit({ type: 'interruption', reason: 'stand-down' });
      if (mode === 'wake') enterStandby('Standing by');
      else setState('listening', 'Standing by');
      return;
    }
    // "Goodnight": say so, tell the server (screen off, quiet phone), then sleep.
    if (isSleepCommand(text)) {
      cancelTurn('sleep');
      stopSpeaking({ resume: false });
      emit({ type: 'transcript', role: 'user', text, final: true });
      emit({
        type: 'transcript',
        role: 'assistant',
        text: 'Goodnight.',
        final: true,
      });
      sleepPending = { until: null };
      if (mode === 'wake') clearFollowUp();
      speak('Goodnight.');
      requestSleep();
      return;
    }
    // Showing or hiding the HUD is local; it needs no round trip to the model.
    const panel = panelCommand(text);
    if (panel !== null) {
      cancelTurn('new-request');
      stopSpeaking({ resume: false });
      emit({ type: 'transcript', role: 'user', text, final: true });
      emit({ type: 'hud', visible: panel });
      if (mode === 'wake') void openListening('Go ahead', { followUp: true });
      else setState('listening', panel ? 'Panel shown' : 'Panel hidden');
      return;
    }
    cancelTurn('new-request');
    stopSpeaking({ resume: false });
    if (mode === 'wake') stopListening();
    claimSpeaker();
    const controller = new AbortController();
    turn = controller;
    emit({ type: 'transcript', role: 'user', text, final: true });
    try {
      const reply = speakableText(await runTurn(text, controller.signal));
      if (turn !== controller || !active) return;
      turn = null;
      if (reply)
        emit({
          type: 'transcript',
          role: 'assistant',
          text: reply,
          final: true,
        });
      emit({ type: 'completion', status: 'completed' });
      if (mode === 'wake') {
        setState('speaking', reply || 'Done');
        if (reply) speak(reply);
        else void openListening('Go ahead', { followUp: true });
      } else {
        if (reply) speak(reply);
        setState('listening', reply || 'Ask or command');
      }
    } catch (error) {
      if (turn !== controller || !active) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      turn = null;
      const detail = error?.message || 'Agent request failed';
      if (mode === 'wake') enterStandby(detail);
      else setState('listening', detail);
    } finally {
      if (turn === controller) turn = null;
    }
  }

  function stopListening() {
    listener?.stop();
    listener = null;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    resetVoiceVisualizerBars(bars());
  }

  function clearFollowUp() {
    if (followUpTimer !== null) clearTimer(followUpTimer);
    followUpTimer = null;
  }

  function listenerCallbacks() {
    return {
      onPartial: (text) => {
        clearFollowUp();
        if (!turn && ui?.detail) ui.detail.textContent = `“${text}”`;
      },
      onFinal: (text) => {
        clearFollowUp();
        if (!speaking) setSpeaker('idle');
        void handleUserText(text);
      },
      onSpeechStart: () => {
        clearFollowUp();
        if (!speaking) setSpeaker('user');
      },
      onLevel: (level) => {
        if (!speaking) showLevel(level);
      },
      onError: (message) => {
        if (!active) return;
        stopListening();
        if (mode === 'wake') enterStandby(message);
        else setState('error', message);
      },
    };
  }

  /** Start speech recognition (wake mode); a follow-up window times out to standby. */
  async function openListening(detail, { followUp = false } = {}) {
    if (!active) return;
    clearFollowUp();
    if (!listener) {
      const current = createListener();
      listener = current;
      try {
        await current.start(listenerCallbacks());
      } catch (error) {
        if (listener === current) listener = null;
        if (active) enterStandby(error?.message || 'Could not start listening');
        return;
      }
      if (listener !== current || !active) return;
    }
    setState('listening', detail);
    if (followUp)
      followUpTimer = setTimer(() => {
        followUpTimer = null;
        if (!turn && !speaking) enterStandby();
      }, FOLLOW_UP_MS);
  }

  function enterStandby(detail = STANDBY_DETAIL) {
    clearFollowUp();
    stopListening();
    if (active) setState('standby', detail);
  }

  /** "Hey Jarvis": interrupt whatever is happening and listen. */
  function handleWake() {
    if (!active) return;
    const interrupted = cancelTurn('wake-word');
    if (stopSpeaking({ resume: false }) && !interrupted)
      emit({ type: 'interruption', reason: 'wake-word' });
    chime?.play();
    void openListening('Listening');
  }

  async function startWakeWord() {
    const detector = createWakeWord({
      onWake: handleWake,
      onLevel: (level) => {
        if (!speaking && !listener) showLevel(level);
      },
    });
    wake = detector;
    try {
      await detector.start();
      return true;
    } catch (error) {
      detector.stop();
      if (wake === detector) wake = null;
      if (isMicrophoneRefusal(error))
        throw new Error(
          /https/i.test(error?.message || '')
            ? error.message
            : 'Microphone access was blocked; allow it for this site',
        );
      // The wake word could not load (model or runtime); always-listening still works.
      return false;
    }
  }

  async function start() {
    active = true;
    mode = 'continuous';
    // Still inside the click that started voice, so audio playback is allowed later.
    neuralSpeaker?.prepare();
    chime?.prepare();
    if (createWakeWord && (await startWakeWord())) {
      if (!active) return;
      mode = 'wake';
      if (ui?.helpDetail)
        ui.helpDetail.textContent =
          'Say "Hey Jarvis" · click the mic to turn Jarvis off';
      enterStandby();
      connectAnnouncements();
      return;
    }
    if (!active) return;
    listener = createListener();
    await listener.start(listenerCallbacks());
    if (!active) return;
    if (ui?.helpDetail)
      ui.helpDetail.textContent =
        'Click to toggle voice · click while the agent speaks to interrupt';
    setState('listening', 'Jarvis is listening');
    connectAnnouncements();
  }

  function stop() {
    active = false;
    sleepPending = null;
    clearFollowUp();
    turn?.abort();
    turn = null;
    wake?.stop();
    wake = null;
    events?.close();
    events = null;
    pendingAnnouncements.length = 0;
    stopListening();
    stopSpeaking({ resume: false });
    setSpeaker('idle');
  }

  signal?.addEventListener('abort', stop, { once: true });

  return {
    capabilities: { costControls: false, pushToTalk: false },
    start,
    stop,
    sendText: (text) => handleUserText(text),
    sendMapEvent: () => {},
    // A click while the agent is speaking interrupts it instead of ending voice.
    ignoreButtonClick: () => {
      if (!stopSpeaking()) return false;
      emit({ type: 'interruption', reason: 'user-click' });
      return true;
    },
    bindControls() {
      const kicker = ui?.root?.querySelector?.('.gev-voice-kicker');
      if (kicker) kicker.textContent = 'JARVIS';
    },
  };
}
