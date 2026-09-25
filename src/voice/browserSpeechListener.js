const QUIET_ERRORS = new Set(['no-speech', 'aborted']);

function describeRecognitionError(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed')
    return 'Microphone access was blocked; allow it for this site';
  if (code === 'audio-capture') return 'No microphone was found';
  if (code === 'network')
    return 'Browser speech recognition needs an internet connection';
  return 'Browser speech recognition failed';
}

/** Listens with the browser's built-in SpeechRecognition (Chrome, Edge, Safari). */
export function createBrowserSpeechListener({
  Recognition = globalThis.SpeechRecognition ||
    globalThis.webkitSpeechRecognition,
  lang = globalThis.navigator?.language || 'en-US',
} = {}) {
  let recognition = null;
  let running = false;
  let muted = false;
  let listening = false;

  function resume() {
    if (!running || muted || listening || !recognition) return;
    try {
      recognition.start();
      listening = true;
    } catch {
      /* already started */
    }
  }

  function start(callbacks) {
    if (typeof Recognition !== 'function')
      return Promise.reject(
        new Error(
          'This browser has no built-in speech recognition; use Chrome, Edge or Safari',
        ),
      );
    running = true;
    muted = false;
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    return new Promise((resolve, reject) => {
      let started = false;
      recognition.onstart = () => {
        if (started) return;
        started = true;
        resolve();
      };
      recognition.onspeechstart = () => callbacks.onSpeechStart();
      recognition.onresult = (event) => {
        let interim = '';
        for (
          let index = event.resultIndex;
          index < event.results.length;
          index++
        ) {
          const result = event.results[index];
          const text = String(result[0]?.transcript || '').trim();
          if (!text) continue;
          if (result.isFinal) callbacks.onFinal(text);
          else interim = `${interim} ${text}`.trim();
        }
        if (interim) callbacks.onPartial(interim);
      };
      recognition.onerror = (event) => {
        if (QUIET_ERRORS.has(event.error)) return;
        const message = describeRecognitionError(event.error);
        if (!started) {
          running = false;
          reject(new Error(message));
        } else callbacks.onError(message);
      };
      // Recognition ends itself after silence or a time limit; keep it going.
      recognition.onend = () => {
        listening = false;
        resume();
      };
      resume();
    });
  }

  function stop() {
    running = false;
    listening = false;
    const current = recognition;
    recognition = null;
    if (!current) return;
    current.onend = null;
    current.onresult = null;
    current.onerror = null;
    try {
      current.abort();
    } catch {
      /* already stopped */
    }
  }

  return {
    start,
    stop,
    // Pause recognition while the agent speaks so it never hears itself.
    setMuted(value) {
      muted = Boolean(value);
      if (!muted) return resume();
      if (!listening) return;
      try {
        recognition?.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}
