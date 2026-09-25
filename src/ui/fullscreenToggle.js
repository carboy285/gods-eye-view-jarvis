/** The page's full-screen API, with Safari's prefixed names as a fallback. */
function fullscreenApi(doc) {
  const root = doc.documentElement;
  if (doc.fullscreenEnabled && root.requestFullscreen)
    return {
      active: () => Boolean(doc.fullscreenElement),
      enter: () => root.requestFullscreen({ navigationUI: 'hide' }),
      exit: () => doc.exitFullscreen(),
      event: 'fullscreenchange',
    };
  if (doc.webkitFullscreenEnabled && root.webkitRequestFullscreen)
    return {
      active: () => Boolean(doc.webkitFullscreenElement),
      enter: () => root.webkitRequestFullscreen(),
      exit: () => doc.webkitExitFullscreen(),
      event: 'webkitfullscreenchange',
    };
  // iPhone Safari cannot full-screen a page; no button rather than a dead one.
  return null;
}

/**
 * A full-screen button beside the top-right style readout. It follows the
 * real state, so F11, Esc and the browser's own controls keep it in sync.
 * @returns {{button: HTMLButtonElement, destroy: Function} | null}
 */
export function installFullscreenToggle({ doc = globalThis.document } = {}) {
  const host = doc?.getElementById?.('style-indicator');
  const api = doc ? fullscreenApi(doc) : null;
  if (!host || !api || doc.getElementById('fullscreen-toggle')) return null;

  const button = doc.createElement('button');
  button.id = 'fullscreen-toggle';
  button.type = 'button';
  const icon = doc.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);

  const render = () => {
    const on = api.active();
    icon.textContent = on ? 'fullscreen_exit' : 'fullscreen';
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute(
      'aria-label',
      on ? 'Exit full screen' : 'Enter full screen',
    );
    button.title = on ? 'Exit full screen (Esc)' : 'Full screen';
  };

  const onClick = () => {
    Promise.resolve()
      .then(() => (api.active() ? api.exit() : api.enter()))
      .catch(() => {})
      .finally(render);
  };

  button.addEventListener('click', onClick);
  doc.addEventListener(api.event, render);
  host.append(button);
  render();

  return {
    button,
    destroy() {
      button.removeEventListener('click', onClick);
      doc.removeEventListener(api.event, render);
      button.remove();
    },
  };
}
