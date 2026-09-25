import { createPcmCaptureNode, requestMicrophone } from './museAudioWorklet.js';

const SESSION_TIMEOUT_MS = 10_000;

function defaultWebSocket(path) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${scheme}://${location.host}${path}`);
}

function waitForSession(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Muse transcription did not start')),
      SESSION_TIMEOUT_MS,
    );
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('Muse transcription connection failed'));
    };
    ws.addEventListener('error', fail, { once: true });
    ws.addEventListener('close', fail, { once: true });
    ws.addEventListener('message', function ready(message) {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event?.type !== 'error' && event?.type !== 'session') return;
      clearTimeout(timer);
      ws.removeEventListener('message', ready);
      ws.removeEventListener('error', fail);
      ws.removeEventListener('close', fail);
      if (event.type === 'error')
        reject(new Error(event.error || 'Muse transcription error'));
      else resolve();
    });
  });
}

/** Listens through Muse Voice Transcribe, relayed by the GEV server. */
export function createMuseListener({
  getUserMedia = requestMicrophone,
  createAudioContext = () => new AudioContext(),
  createCaptureNode = createPcmCaptureNode,
  createWebSocket = defaultWebSocket,
} = {}) {
  let stream = null;
  let audioContext = null;
  let captureNode = null;
  let socket = null;
  let muted = false;
  let running = false;
  let partialText = '';
  const committedTurns = new Set();

  function commit(turnId, onFinal) {
    const text = partialText.trim();
    if (turnId != null) {
      if (committedTurns.has(turnId)) return;
      committedTurns.add(turnId);
    }
    partialText = '';
    if (text) onFinal(text);
  }

  function handleEvent(event, callbacks) {
    const name = event?.type || event?.event;
    if (name === 'error') {
      callbacks.onError(event.error || 'Muse transcription error');
      return;
    }
    if (name === 'speechStart') callbacks.onSpeechStart();
    const text = event?.text ?? event?.transcript;
    if (typeof text === 'string') {
      partialText = text;
      if (text.trim()) callbacks.onPartial(text.trim());
    }
    if (event?.final === true || name === 'speechComplete')
      commit(event?.turnId ?? null, callbacks.onFinal);
  }

  function stop() {
    running = false;
    if (socket) {
      const closing = socket;
      socket = null;
      try {
        if (closing.readyState === 1)
          closing.send(JSON.stringify({ type: 'endStream' }));
        closing.close();
      } catch {
        /* already closed */
      }
    }
    try {
      captureNode?.disconnect();
    } catch {
      /* already disconnected */
    }
    captureNode = null;
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
    audioContext?.close?.().catch?.(() => {});
    audioContext = null;
  }

  async function start(callbacks) {
    running = true;
    muted = false;
    partialText = '';
    committedTurns.clear();
    stream = await getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    audioContext = createAudioContext();
    const node = await createCaptureNode(audioContext);
    socket = createWebSocket('/api/muse/asr');
    socket.binaryType = 'arraybuffer';
    await waitForSession(socket);
    if (!running) return;
    socket.addEventListener('message', (message) => {
      try {
        handleEvent(JSON.parse(message.data), callbacks);
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.addEventListener('close', () => {
      if (!running || !socket) return;
      socket = null;
      callbacks.onError('Muse transcription disconnected');
    });
    captureNode = node;
    captureNode.port.onmessage = ({ data }) => {
      if (typeof data?.level === 'number' && !muted)
        callbacks.onLevel(Math.min(1, data.level * 6));
      if (data?.pcm && socket?.readyState === 1)
        // Silence keeps the stream real-time without transcribing the agent's own voice.
        socket.send(muted ? new ArrayBuffer(data.pcm.byteLength) : data.pcm);
    };
    audioContext.createMediaStreamSource(stream).connect(captureNode);
  }

  return {
    start,
    stop,
    setMuted(value) {
      muted = Boolean(value);
    },
  };
}
