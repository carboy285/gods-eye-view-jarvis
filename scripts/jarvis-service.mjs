#!/usr/bin/env node
// Keeps the God's Eye View dev server (and so Jarvis) running: starts it,
// logs its output, and restarts it with backoff whenever it exits.
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './project-root.mjs';

const STABLE_UPTIME_MS = 5 * 60_000;

export function serviceHome(environment = process.env) {
  return path.join(
    environment.GEV_SERVICE_HOME || os.homedir(),
    '.gods-eye-view',
  );
}

/** 1 s, 2 s, 4 s … capped at a minute, so a crash loop never spins. */
export function restartDelayMs(recentCrashes) {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(recentCrashes, 0), 6));
}

export function devServerCommand({
  root = projectRoot(import.meta.url),
  environment = process.env,
  nodePath = process.execPath,
} = {}) {
  return {
    command: nodePath,
    args: [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      environment.GEV_SERVICE_HOST || '0.0.0.0',
      '--port',
      environment.GEV_SERVICE_PORT || '4173',
      '--strictPort',
    ],
    options: {
      cwd: root,
      windowsHide: true,
      env: {
        ...environment,
        // Vite's helpers and npm scripts may spawn `node`; make sure it resolves.
        PATH: `${path.dirname(nodePath)}${path.delimiter}${environment.PATH || environment.Path || ''}`,
      },
    },
  };
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Only one supervisor at a time; a stale pid file from a crash is taken over. */
export function claimSingleInstance(
  pidFile,
  pid = process.pid,
  alive = isRunning,
) {
  try {
    const existing = Number(readFileSync(pidFile, 'utf8'));
    if (existing && existing !== pid && alive(existing)) return false;
  } catch {
    /* no pid file yet */
  }
  writeFileSync(pidFile, String(pid));
  return true;
}

function logStream(home) {
  const dir = path.join(home, 'logs');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  return createWriteStream(path.join(dir, `jarvis-${day}.log`), { flags: 'a' });
}

function supervise() {
  const home = serviceHome();
  mkdirSync(home, { recursive: true });
  const pidFile = path.join(home, 'jarvis-service.pid');
  if (!claimSingleInstance(pidFile)) {
    console.log('Jarvis service is already running.');
    return;
  }

  let child = null;
  let stopping = false;
  let recentCrashes = 0;

  const start = () => {
    const log = logStream(home);
    const { command, args, options } = devServerCommand();
    const startedAt = Date.now();
    log.write(`\n[${new Date().toISOString()}] starting dev server\n`);
    child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('exit', (code, signal) => {
      child = null;
      log.write(
        `[${new Date().toISOString()}] dev server exited (${signal || code})\n`,
      );
      log.end();
      if (stopping) return;
      recentCrashes =
        Date.now() - startedAt > STABLE_UPTIME_MS ? 0 : recentCrashes + 1;
      setTimeout(start, restartDelayMs(recentCrashes));
    });
  };

  const stop = () => {
    stopping = true;
    child?.kill();
    rmSync(pidFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  start();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) supervise();
