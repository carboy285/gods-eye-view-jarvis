import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJsonFile, jarvisHome } from './store.js';
import { nextDailyOccurrence } from './time.js';

const TICK_MS = 15_000;
// A job missed while the PC was off still fires if it is at most this late.
const MAX_LATE_MS = 60 * 60_000;
const MAX_JOBS = 200;

/**
 * Jarvis's clock: one-off and daily jobs persisted to disk, delivered when
 * due. Delivery (speech, phone) is injected so the scheduler stays pure.
 */
export function createScheduler({
  file = path.join(jarvisHome(), 'jarvis-jobs.json'),
  fsImpl,
  now = () => new Date(),
  timeZone = () => 'UTC',
  deliver = async () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const store = createJsonFile({ file, fsImpl, empty: { jobs: [] } });
  let timer = null;
  let ticking = null;

  async function jobs() {
    const data = await store.read();
    return Array.isArray(data?.jobs) ? data.jobs : [];
  }

  async function save(list) {
    await store.write({ jobs: list });
  }

  async function add({ kind, text = '', at, repeat = null, data = null }) {
    const list = await jobs();
    if (list.length >= MAX_JOBS)
      return { ok: false, error: 'Too many scheduled items' };
    const nextAt = repeat
      ? nextDailyOccurrence(repeat, now(), timeZone())
      : at instanceof Date && !Number.isNaN(at.getTime())
        ? at
        : null;
    if (!nextAt)
      return { ok: false, error: 'That time could not be understood' };
    if (!repeat && nextAt <= now())
      return { ok: false, error: 'That time has already passed' };
    const job = {
      id: randomUUID(),
      kind,
      text: String(text).slice(0, 300),
      nextAt: nextAt.toISOString(),
      ...(repeat ? { repeat } : {}),
      ...(data ? { data } : {}),
    };
    await save([...list, job]);
    return { ok: true, job };
  }

  async function list() {
    return [...(await jobs())].sort((a, b) => a.nextAt.localeCompare(b.nextAt));
  }

  /** Remove jobs whose text or kind contains `match` ("all" removes everything). */
  async function cancel(match, { kind } = {}) {
    const needle = String(match || '')
      .trim()
      .toLowerCase();
    if (!needle) return { ok: false, error: 'Say what to cancel' };
    const current = await jobs();
    const kept = current.filter((job) => {
      if (kind && job.kind !== kind) return true;
      if (needle === 'all') return false;
      return !`${job.kind} ${job.text}`.toLowerCase().includes(needle);
    });
    const removed = current.filter((job) => !kept.includes(job));
    if (removed.length) await save(kept);
    return { ok: true, cancelled: removed };
  }

  async function runDue() {
    const current = await jobs();
    const moment = now();
    let changed = false;
    const next = [];
    for (const job of current) {
      const dueAt = new Date(job.nextAt);
      if (dueAt > moment) {
        next.push(job);
        continue;
      }
      changed = true;
      if (moment - dueAt <= MAX_LATE_MS) {
        try {
          await deliver(job);
        } catch {
          // A failed delivery must not wedge the queue.
        }
      }
      if (job.repeat) {
        const following = nextDailyOccurrence(job.repeat, moment, timeZone());
        if (following) next.push({ ...job, nextAt: following.toISOString() });
      }
    }
    if (changed) await save(next);
  }

  /** Deliver everything due; overlapping ticks share one run. */
  function tick() {
    ticking ??= runDue().finally(() => {
      ticking = null;
    });
    return ticking;
  }

  return {
    add,
    list,
    cancel,
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setIntervalImpl(() => void tick(), TICK_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
  };
}
