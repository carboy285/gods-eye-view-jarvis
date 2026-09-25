import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claimSingleInstance,
  devServerCommand,
  restartDelayMs,
  serviceHome,
} from '../../scripts/jarvis-service.mjs';

test('restarts back off from one second to a one-minute cap', () => {
  assert.deepEqual(
    [0, 1, 2, 5, 6, 20, -3].map(restartDelayMs),
    [1_000, 2_000, 4_000, 32_000, 60_000, 60_000, 1_000],
  );
});

test('the dev server runs Vite directly on the LAN port with a strict port', () => {
  const { command, args, options } = devServerCommand({
    root: '/repo',
    nodePath: '/opt/node/bin/node',
    environment: { PATH: '/usr/bin' },
  });
  assert.equal(command, '/opt/node/bin/node');
  assert.deepEqual(args, [
    path.join('/repo', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    '0.0.0.0',
    '--port',
    '4173',
    '--strictPort',
  ]);
  assert.equal(options.cwd, '/repo');
  assert.equal(options.windowsHide, true);
  assert.ok(options.env.PATH.startsWith(`/opt/node/bin${path.delimiter}`));
  const custom = devServerCommand({
    root: '/repo',
    nodePath: 'node',
    environment: { GEV_SERVICE_HOST: '127.0.0.1', GEV_SERVICE_PORT: '5000' },
  });
  assert.deepEqual(custom.args.slice(1, 5), ['--host', '127.0.0.1', '--port', '5000']);
});

test('only one supervisor runs; a stale pid file is taken over', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'jarvis-service.pid');

  assert.equal(claimSingleInstance(pidFile, 100, () => false), true);
  assert.equal(readFileSync(pidFile, 'utf8'), '100');
  assert.equal(claimSingleInstance(pidFile, 200, (pid) => pid === 100), false, 'a live supervisor wins');
  assert.equal(claimSingleInstance(pidFile, 200, () => false), true, 'a dead one is replaced');
  writeFileSync(pidFile, 'garbage');
  assert.equal(claimSingleInstance(pidFile, 300, () => true), true);
  assert.equal(serviceHome({ GEV_SERVICE_HOME: dir }), path.join(dir, '.gods-eye-view'));
});
