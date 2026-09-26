import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Node-only local journals. Corrupt/unknown files are never replaced with an empty state. */
export function readAtomicJsonFile<T>(file: string, parse: (input: unknown) => T, empty: () => T): T {
  try { return parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
}

/** One lock-protected read–modify–fsync–rename. A crash leaves a lock requiring explicit recovery. */
export function updateAtomicJsonFile<T>(file: string, read: () => T, update: (current: T) => T): T {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('STORE_BUSY: 記録を保存中です。異常終了後は利用プロセスがないことを確認してロックを解放してください');
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const current = read();
    const next = update(current);
    if (next === current) return current;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, file);
    return next;
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); }
    finally { rmdirSync(lock); }
  }
}
