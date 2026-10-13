import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchExportBrowser } from './exportBrowser';
import { chromiumExportWorker } from './exportRunner';
import { renderExportFrames } from './exportParallel';

// Real Playwright with a fake browser that starts (with a child, like Chromium's helpers) but never connects its
// pipe: the launch hang seen in step 5. Each start appends its own pid and its child's pid to a file.
const posix = process.platform !== 'win32';
let directory = '', fake = '', pidFile = '';
beforeAll(async () => {
  if (!posix) return;
  directory = await mkdtemp(join(tmpdir(), 'export-browser-')); fake = join(directory, 'fake-chromium'); pidFile = join(directory, 'pids');
  await writeFile(fake, `#!/bin/sh\nsleep 600 &\necho "$$ $!" >> '${pidFile}'\nwait\n`); await chmod(fake, 0o755);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function pids(): Promise<number[]> { return (await readFile(pidFile, 'utf8').catch(() => '')).split(/\s+/).filter(Boolean).map(Number); }
async function started(count: number, ms = 10_000): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await pids();
    if (found.length >= count * 2 || Date.now() > deadline) return found;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function gone(list: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = list.filter(alive);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

it.skipIf(!posix)('a launch that never connects times out, is retried, fails clearly and leaves no process behind', async () => {
  await rm(pidFile, { force: true });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const error = await launchExportBrowser({ executablePath: fake, signal: new AbortController().signal, timeoutMs: 1000, attempts: 2, pauseMs: 0 }).then(() => new Error('launched'), (value: unknown) => value as Error);
    expect(error.message).toMatch(/^書き出し用のブラウザを起動できませんでした（2 回試しました）: .*Timeout 1000ms exceeded/);
    expect(warn).toHaveBeenCalledTimes(1);
    const list = await pids();
    expect(list).toHaveLength(4); // presence: both attempts really started a process with a child
    // Playwright alone keeps a timed-out browser up to its 180 s close timeout.
    expect(await gone(list, 2000)).toEqual([]);
  } finally { warn.mockRestore(); }
}, 20_000);

it.skipIf(!posix)('a stop during a hanging launch ends within seconds and leaves no process behind', async () => {
  await rm(pidFile, { force: true });
  const controller = new AbortController(), reason = new Error('cancel');
  const result = launchExportBrowser({ executablePath: fake, signal: controller.signal, timeoutMs: 60_000 }).catch(value => value as Error);
  const list = await started(1);
  expect(list).toHaveLength(2);
  const stopping = Date.now(); controller.abort(reason);
  expect(await result).toBe(reason);
  expect(Date.now() - stopping).toBeLessThan(3000);
  expect(await gone(list, 2000)).toEqual([]);
}, 20_000);

it.skipIf(!posix)('a stop right after the start, before the process exists, still ends it once it appears', async () => {
  await rm(pidFile, { force: true });
  const controller = new AbortController(), reason = new Error('cancel');
  const result = launchExportBrowser({ executablePath: fake, signal: controller.signal, timeoutMs: 60_000 }).catch(value => value as Error);
  controller.abort(reason);
  expect(await result).toBe(reason);
  // Whatever got started is gone; nothing starts later.
  expect(await gone(await pids(), 2000)).toEqual([]);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await gone(await pids(), 2000)).toEqual([]);
}, 20_000);

it.skipIf(!posix)('through the export: a cancel while every worker launch hangs ends the job within seconds, no process left', async () => {
  await rm(pidFile, { force: true });
  const controller = new AbortController(), reason = new Error('cancel');
  const workers = chromiumExportWorker({ executablePath: fake, origin: 'http://127.0.0.1:9', target: { projectId: 'case', jobId: 'job' }, resolution: { width: 320, height: 180 },
    launch: { timeoutMs: 60_000 } });
  const result = renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 8, signal: controller.signal, open: workers.open, frame: async () => undefined })
    .catch(value => value as Error);
  const list = await started(2);
  expect(list).toHaveLength(4);
  const stopping = Date.now(); controller.abort(reason);
  expect(await result).toBe(reason);
  expect(Date.now() - stopping).toBeLessThan(3000);
  expect(await gone(list, 2000)).toEqual([]);
}, 20_000);
