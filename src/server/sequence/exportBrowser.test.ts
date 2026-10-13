import { afterEach, expect, it, vi } from 'vitest';
import type { Browser, LaunchOptions } from 'playwright-core';
import { EXPORT_BROWSER_LAUNCH, launchExportBrowser } from './exportBrowser';

const browser = { version: () => 'fake' } as unknown as Browser;
/** A launch that follows a script: 'ok' resolves, an Error rejects, 'hang' never settles until a stop. */
function scriptedLaunch(script: Array<'ok' | Error>) {
  const calls: LaunchOptions[] = [];
  const launch = async (options: LaunchOptions) => {
    calls.push(options);
    const step = script[calls.length - 1];
    if (step === 'ok') return browser;
    throw step ?? new Error('no more steps');
  };
  return { calls, launch };
}
afterEach(() => { vi.restoreAllMocks(); });

it('gives each attempt a 30 s timeout; two failures are retried with a warning each and the third launch is used', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { calls, launch } = scriptedLaunch([new Error('Timeout 30000ms exceeded.'), new Error('Timeout 30000ms exceeded.'), 'ok']);
  await expect(launchExportBrowser({ executablePath: '/chrome', signal: new AbortController().signal, pauseMs: 0, launch })).resolves.toBe(browser);
  expect(EXPORT_BROWSER_LAUNCH).toMatchObject({ timeoutMs: 30_000, attempts: 3 });
  expect(calls).toHaveLength(3);
  for (const call of calls) expect(call).toMatchObject({ executablePath: '/chrome', timeout: 30_000 });
  // Each attempt is marked differently, so the process it started can be found and ended.
  expect(new Set(calls.map(call => call.args?.join(' '))).size).toBe(3);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[0]![0])).toMatch(/書き出し用のブラウザ.*1\/3/);
});

it('after the last attempt fails: a clear Japanese error naming the export browser, with the last error as its cause', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const last = new Error('browserType.launch: Timeout 30000ms exceeded.\nCall log:\n  - <launched> pid=1');
  const { calls, launch } = scriptedLaunch([new Error('first'), new Error('second'), last]);
  const error = await launchExportBrowser({ executablePath: '/chrome', signal: new AbortController().signal, pauseMs: 0, launch }).then(() => new Error('launched'), (value: unknown) => value as Error);
  expect(calls).toHaveLength(3);
  expect(error.message).toBe('書き出し用のブラウザを起動できませんでした（3 回試しました）: browserType.launch: Timeout 30000ms exceeded.');
  expect(error.cause).toBe(last);
});

it('a stop before the start rejects with the stop reason without launching', async () => {
  const controller = new AbortController(), reason = new Error('cancel'); controller.abort(reason);
  const { calls, launch } = scriptedLaunch(['ok']);
  await expect(launchExportBrowser({ executablePath: '/chrome', signal: controller.signal, launch })).rejects.toBe(reason);
  expect(calls).toHaveLength(0);
});

it('a stop during the pause between attempts ends at once, without another launch', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const controller = new AbortController(), reason = new Error('cancel');
  const { calls, launch } = scriptedLaunch([new Error('first'), 'ok']);
  const started = Date.now();
  const result = launchExportBrowser({ executablePath: '/chrome', signal: controller.signal, pauseMs: 60_000, launch });
  setTimeout(() => controller.abort(reason), 20);
  await expect(result).rejects.toBe(reason);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(calls).toHaveLength(1);
});

it('a stop during a launch rejects with the stop reason (not as a failed launch) and is not retried', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const controller = new AbortController(), reason = new Error('cancel');
  const calls: LaunchOptions[] = [];
  // Stands in for Playwright: the launch ends once the stop has ended its process.
  const launch = (options: LaunchOptions) => { calls.push(options); return new Promise<Browser>((_, reject) => controller.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Browser closed')), 50), { once: true })); };
  const result = launchExportBrowser({ executablePath: '/chrome', signal: controller.signal, launch });
  setTimeout(() => controller.abort(reason), 20);
  await expect(result).rejects.toBe(reason);
  expect(calls).toHaveLength(1);
  expect(warn).not.toHaveBeenCalled();
});

// Codex review (2026-10-09): where the process cannot be killed (Windows), a launch that still succeeds after the
// stop handed back a browser nobody closed. It must be closed before the stop is reported.
it('a launch that completes after the stop has its browser closed before rejecting with the stop reason', async () => {
  const controller = new AbortController(), reason = new Error('cancel');
  const close = vi.fn(async () => undefined);
  const late = { version: () => 'late', close } as unknown as Browser;
  const launch = () => new Promise<Browser>(resolve => controller.signal.addEventListener('abort', () => setTimeout(() => resolve(late), 50), { once: true }));
  const result = launchExportBrowser({ executablePath: '/chrome', signal: controller.signal, launch });
  setTimeout(() => controller.abort(reason), 20);
  await expect(result).rejects.toBe(reason);
  expect(close).toHaveBeenCalledOnce();
});
