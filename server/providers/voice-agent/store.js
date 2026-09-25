import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Jarvis's private state lives here, outside the repo and Vite's served root. */
export function jarvisHome() {
  return path.join(os.homedir(), '.gods-eye-view');
}

/** A JSON document on disk: cached reads, owner-only atomic writes. */
export function createJsonFile({ file, fsImpl = fs, empty }) {
  let cache;
  return {
    async read() {
      if (cache !== undefined) return cache;
      try {
        cache = JSON.parse(await fsImpl.readFile(file, 'utf8'));
      } catch {
        cache = structuredClone(empty);
      }
      return cache;
    },
    async write(value) {
      await fsImpl.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fsImpl.writeFile(temporary, JSON.stringify(value, null, 2), {
        mode: 0o600,
      });
      await fsImpl.rename(temporary, file);
      cache = value;
    },
  };
}
