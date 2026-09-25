const STATE_LABELS = Object.freeze({
  idle: 'Offline',
  connecting: 'Starting',
  standby: 'Standing by',
  listening: 'Listening',
  executing: 'Thinking',
  speaking: 'Speaking',
  error: 'Needs attention',
});
const STORAGE_KEY = 'gev.jarvis.panel';
const REFRESH_MS = 60_000;
const MAX_UPCOMING = 5;
const MAX_LINE_CHARS = 280;

/** "Hide the panel", "show the HUD", "close Jarvis panel": true, false or null. */
export function panelCommand(text) {
  const match =
    /^(?:jarvis[, ]+)?(show|open|hide|close)\s+(?:the\s+|your\s+)?(?:jarvis\s+)?(?:panel|hud)[.!]?$/i.exec(
      String(text || '').trim(),
    );
  if (!match) return null;
  return /^(show|open)$/i.test(match[1]);
}

function clip(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX_LINE_CHARS
    ? `${clean.slice(0, MAX_LINE_CHARS - 1)}…`
    : clean;
}

const KIND_LABELS = Object.freeze({
  reminder: 'Reminder',
  timer: 'Timer',
  briefing: 'Briefing',
  text: 'Text',
});

/** HUD rows from /api/jarvis/upcoming: scheduled items first, then watches. */
export function upcomingRows(data) {
  const rows = (Array.isArray(data?.items) ? data.items : [])
    .slice(0, MAX_UPCOMING)
    .map((item) => ({
      label: KIND_LABELS[item?.kind] || 'Scheduled',
      text: clip(item?.text || ''),
      when: clip(`${item?.when || ''}${item?.repeats ? ', repeats' : ''}`),
    }));
  const watches = data?.watches || {};
  for (const callsign of Array.isArray(watches.flights) ? watches.flights : [])
    rows.push({
      label: 'Flight',
      text: clip(callsign),
      when: 'until it lands',
    });
  if (watches.earthquakes)
    rows.push({
      label: 'Alerts',
      text: `Earthquakes M${watches.earthquakes.minMagnitude}+`,
      when: `within ${watches.earthquakes.radiusKm} km of home`,
    });
  if (watches.severeWeather)
    rows.push({ label: 'Alerts', text: 'Severe weather', when: 'at home' });
  return rows;
}

/** The saved choice; otherwise shown, except on phones where no corner is free. */
function readVisible(storage, narrow) {
  let saved = null;
  try {
    saved = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    saved = null;
  }
  if (saved === 'shown' || saved === 'hidden') return saved === 'shown';
  return !narrow();
}

function saveVisible(storage, visible) {
  try {
    storage?.setItem(STORAGE_KEY, visible ? 'shown' : 'hidden');
  } catch {
    // Remembering the choice is a convenience only.
  }
}

/** "7:00 AM" in the viewer's own zone. */
function clockTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isTypingTarget(target) {
  return Boolean(
    target?.closest?.('input, textarea, select, [contenteditable]') ||
    target?.isContentEditable,
  );
}

/**
 * The Jarvis HUD: status ring, last exchange, upcoming items and the
 * account-connect link. It only observes session events; it never acts.
 */
export function createJarvisPanel({
  doc = globalThis.document,
  fetchImpl = (...args) => fetch(...args),
  storage = globalThis.localStorage,
  setIntervalImpl = (callback, ms) => setInterval(callback, ms),
  clearIntervalImpl = (id) => clearInterval(id),
  narrow = () =>
    Boolean(globalThis.matchMedia?.('(max-width: 720px)')?.matches),
} = {}) {
  const element = (tag, className, parent) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    parent?.appendChild(node);
    return node;
  };

  const root = element('aside', 'gev-jarvis');
  root.setAttribute('aria-label', 'Jarvis');
  root.dataset.state = 'idle';
  const head = element('div', 'gev-jarvis-head', root);
  const ring = element('div', 'gev-jarvis-ring', head);
  ring.setAttribute('aria-hidden', 'true');
  element('span', '', ring);
  const titles = element('div', 'gev-jarvis-titles', head);
  element('div', 'gev-jarvis-title', titles).textContent = 'JARVIS';
  const status = element('div', 'gev-jarvis-status', titles);
  status.setAttribute('role', 'status');
  status.textContent = STATE_LABELS.idle;
  const close = element('button', 'gev-jarvis-close', head);
  close.type = 'button';
  close.setAttribute('aria-label', 'Hide Jarvis panel (J)');
  close.textContent = '×';

  const exchange = element('div', 'gev-jarvis-exchange', root);
  const you = element('p', 'gev-jarvis-you', exchange);
  const reply = element('p', 'gev-jarvis-reply', exchange);
  reply.textContent = 'Say "Hey Jarvis" once voice is on.';

  // Collapsed to one summary line by default: the free space over the globe is short.
  const upcoming = element('section', 'gev-jarvis-upcoming', root);
  const summary = element('button', 'gev-jarvis-summary', upcoming);
  summary.type = 'button';
  summary.setAttribute('aria-expanded', 'false');
  const list = element('ul', '', upcoming);
  list.id = `gev-jarvis-upcoming-${Math.random().toString(36).slice(2, 8)}`;
  summary.setAttribute('aria-controls', list.id);
  list.hidden = true;
  upcoming.hidden = true;

  const connect = element('a', 'gev-jarvis-connect', root);
  connect.target = '_blank';
  connect.rel = 'noopener noreferrer';
  connect.textContent = 'Connect your account ↗';
  connect.hidden = true;

  // While the panel is closed, a small tab in its corner brings it back.
  // Sleep mode blacks the page out; a click brings the globe back.
  const night = element('div', 'gev-jarvis-night');
  night.setAttribute('role', 'button');
  night.tabIndex = 0;
  night.hidden = true;
  element('p', 'gev-jarvis-night-title', night).textContent =
    'Jarvis is asleep';
  const nightDetail = element('p', 'gev-jarvis-night-detail', night);
  element('p', 'gev-jarvis-night-hint', night).textContent =
    'Click to show the globe · click the mic to wake Jarvis';
  const showNight = (until) => {
    const when = until ? new Date(until) : null;
    nightDetail.textContent =
      when && !Number.isNaN(when.getTime())
        ? `Back on at ${clockTime(when)}`
        : 'Back on in the morning';
    night.hidden = false;
  };
  const hideNight = () => {
    night.hidden = true;
  };

  const reopen = element('button', 'gev-jarvis-tab');
  reopen.type = 'button';
  reopen.setAttribute('aria-label', 'Show Jarvis panel (J)');
  reopen.title = 'Show Jarvis (J)';
  reopen.textContent = 'JARVIS';
  reopen.dataset.state = 'idle';

  let visible = readVisible(storage, narrow);
  let active = false;
  let timer = null;
  let loading = null;
  let destroyed = false;
  root.hidden = !visible;
  reopen.hidden = visible;

  function renderUpcoming(rows) {
    const scheduled = rows.filter(
      (row) => !['Flight', 'Alerts'].includes(row.label),
    );
    const watching = rows.length - scheduled.length;
    summary.textContent = [
      scheduled.length ? `${scheduled.length} upcoming` : '',
      scheduled[0]?.when.replace(/^at /, '').replace(/, repeats$/, '') || '',
      watching ? `${watching} watching` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    list.replaceChildren();
    for (const row of rows) {
      const item = element('li', '', list);
      element('span', 'gev-jarvis-kind', item).textContent = row.label;
      element('span', 'gev-jarvis-text', item).textContent = row.text;
      element('span', 'gev-jarvis-when', item).textContent = row.when;
    }
    upcoming.hidden = rows.length === 0;
  }

  /** Reload upcoming items; devices without personal access simply show none. */
  function refresh() {
    if (destroyed || !visible) return Promise.resolve();
    loading ??= Promise.resolve()
      .then(() =>
        fetchImpl('/api/jarvis/upcoming', {
          headers: { Accept: 'application/json' },
        }),
      )
      .then((response) => (response?.ok ? response.json() : null))
      .then((data) => {
        if (!destroyed) renderUpcoming(data ? upcomingRows(data) : []);
      })
      .catch(() => {})
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function schedule() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
    if (visible && active && !destroyed)
      timer = setIntervalImpl(() => void refresh(), REFRESH_MS);
  }

  function toggle(force) {
    if (destroyed) return visible;
    visible = typeof force === 'boolean' ? force : !visible;
    root.hidden = !visible;
    reopen.hidden = visible;
    saveVisible(storage, visible);
    schedule();
    if (visible) void refresh();
    return visible;
  }

  function onKeyDown(event) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      String(event.key).toLowerCase() !== 'j' ||
      isTypingTarget(event.target)
    )
      return;
    toggle();
  }

  close.addEventListener('click', () => toggle(false));
  summary.addEventListener('click', () => {
    list.hidden = !list.hidden;
    summary.setAttribute('aria-expanded', String(!list.hidden));
  });
  connect.addEventListener('click', () =>
    setTimeout(() => {
      connect.hidden = true;
    }, 0),
  );
  doc.addEventListener('keydown', onKeyDown);
  reopen.addEventListener('click', () => toggle(true));
  night.addEventListener('click', hideNight);
  night.addEventListener('keydown', (event) => {
    if (['Enter', 'Escape', ' '].includes(event.key)) hideNight();
  });
  doc.body?.appendChild(root);
  doc.body?.appendChild(reopen);
  doc.body?.appendChild(night);

  return {
    root,
    toggle,
    refresh,
    isVisible: () => visible,
    /** Feed every voice-session event through here. */
    handle(event) {
      if (destroyed || !event) return;
      if (event.type === 'state') {
        if (['connecting', 'listening', 'standby'].includes(event.state))
          hideNight();
        root.dataset.state = event.state;
        reopen.dataset.state = event.state;
        status.textContent = STATE_LABELS[event.state] || event.state;
        const wasActive = active;
        active = !['idle', 'error'].includes(event.state);
        if (active !== wasActive) {
          schedule();
          if (active) void refresh();
        }
      } else if (event.type === 'transcript' && event.final !== false) {
        // Lines are clamped in CSS; the tooltip keeps the whole text.
        if (event.role === 'user') {
          you.textContent = you.title = clip(event.text);
          reply.textContent = '…';
          reply.title = '';
        } else if (event.role === 'assistant')
          reply.textContent = reply.title = clip(event.text);
      } else if (event.type === 'connect-link') {
        connect.href = event.href;
        connect.hidden = false;
      } else if (event.type === 'hud') toggle(event.visible);
      else if (event.type === 'sleep') showNight(event.until);
      else if (event.type === 'wake') hideNight();
      else if (event.type === 'completion' || event.type === 'announcement')
        void refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer) clearIntervalImpl(timer);
      doc.removeEventListener('keydown', onKeyDown);
      root.remove();
      reopen.remove();
      night.remove();
    },
  };
}
