import { spawn } from 'node:child_process';
import path from 'node:path';
import { createJsonFile, jarvisHome } from './store.js';
import { nextDailyOccurrence } from './time.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_WAKE_TIME = '07:00';
// Long enough for "Goodnight" to be spoken before the screen goes dark.
const SCREEN_OFF_DELAY_MS = 4_000;
// While asleep only what the user scheduled, and real emergencies, get through.
const ALWAYS_DELIVERED = new Set([
  'reminder',
  'timer',
  'briefing',
  'note',
  'text',
]);
const URGENT_WHEN_HIGH = new Set(['weather', 'earthquake']);

// PostMessage (not SendMessage) to every window: SC_MONITORPOWER, 2 = off.
// Moving the mouse or pressing a key turns the screen back on.
const MONITOR_OFF_SCRIPT = [
  '$sig = \'[DllImport("user32.dll")] public static extern bool PostMessage(int hWnd, int msg, int wParam, int lParam);\'',
  '$user32 = Add-Type -MemberDefinition $sig -Name GevMonitor -Namespace Gev -PassThru',
  '[void]$user32::PostMessage(0xffff, 0x0112, 0xF170, 2)',
].join('; ');

function validWakeTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/** Turns this PC's display off (Windows only; GEV_SCREEN_OFF=0 disables it). */
export function createScreenControl({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
} = {}) {
  const enabled = () =>
    platform === 'win32' && String(env.GEV_SCREEN_OFF ?? '1').trim() !== '0';
  return {
    enabled,
    turnOff({ delayMs = SCREEN_OFF_DELAY_MS } = {}) {
      if (!enabled()) return false;
      const timer = setTimeoutImpl(() => {
        try {
          const child = spawnImpl(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle',
              'Hidden',
              '-Command',
              MONITOR_OFF_SCRIPT,
            ],
            { windowsHide: true, stdio: 'ignore' },
          );
          child.on?.('error', () => {});
          child.unref?.();
        } catch {
          // A dark screen is a nicety; sleep mode works without it.
        }
      }, delayMs);
      timer?.unref?.();
      return true;
    },
  };
}

/**
 * Jarvis's sleep mode: pages turn their microphones off, the screen goes
 * dark, and phone alerts are held to what the user scheduled plus real
 * emergencies, until the wake time or a "good morning".
 */
export function createSleepMode({
  file = path.join(jarvisHome(), 'jarvis-sleep.json'),
  fsImpl,
  env = process.env,
  now = () => new Date(),
  timeZone = () => 'UTC',
  announcer,
  screen = createScreenControl({ env }),
} = {}) {
  const store = createJsonFile({ file, fsImpl, empty: {} });

  const wakeTime = () => validWakeTime(env.GEV_WAKE_TIME) || DEFAULT_WAKE_TIME;

  async function current() {
    const data = (await store.read()) || {};
    const until = Date.parse(data.until);
    return data.sleeping && until > now().getTime()
      ? { sleeping: true, until: new Date(until) }
      : { sleeping: false, until: null };
  }

  return {
    wakeTime,
    status: current,
    async isAsleep() {
      return (await current()).sleeping;
    },

    /** Should an alert of this kind reach the phone right now? */
    async allows(kind, priority) {
      if (!(await current()).sleeping) return true;
      return (
        ALWAYS_DELIVERED.has(kind) ||
        (priority === 'high' && URGENT_WHEN_HIGH.has(kind))
      );
    },

    async sleep({ wakeAt } = {}) {
      const time = validWakeTime(wakeAt) || wakeTime();
      const until = nextDailyOccurrence(
        { time, days: EVERY_DAY },
        now(),
        timeZone(),
      );
      await store.write({
        sleeping: true,
        since: now().toISOString(),
        until: until.toISOString(),
      });
      announcer?.broadcast('sleep', { until: until.toISOString() });
      const screenOff = screen.turnOff();
      return { ok: true, until, screenOff };
    },

    async wake() {
      const was = (await current()).sleeping;
      if (was) {
        await store.write({ sleeping: false });
        announcer?.broadcast('wake', {});
      }
      return { ok: true, wasAsleep: was };
    },
  };
}
