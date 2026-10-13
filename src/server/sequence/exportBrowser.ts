/** Launching an export browser (exportRunner.chromiumExportWorker): bounded, retried, and never leaving a process.
 * Step 5 saw one `chromium.launch` hang for Playwright's default 180 s (process started, pipe never connected) while
 * normal launches take ~0.4 s. Playwright also keeps a timed-out browser running until its own 180 s close timeout,
 * and gives no handle to it, so each attempt carries a unique marker argument and the process found by it (a child
 * of this process, leader of its own process group) is killed with its group when the attempt fails or is stopped. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

export interface ExportBrowserLaunch { timeoutMs: number; attempts: number; pauseMs: number }
export const EXPORT_BROWSER_LAUNCH: Readonly<ExportBrowserLaunch> = Object.freeze({ timeoutMs: 30_000, attempts: 3, pauseMs: 500 });
const STOP_POLL_MS = 100;

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!;
/** Kill every process this process started with `marker` among its arguments, with its process group. */
function killMarked(marker: string): void {
  if (process.platform === 'win32') return;
  let rows: string;
  try { rows = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { console.warn('[sme] 書き出し用のブラウザのプロセスを確認できませんでした:', firstLine(error)); return; }
  for (const line of rows.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== process.pid || !match[3]!.split(' ').includes(marker)) continue;
    const pid = Number(match[1]);
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onStop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onStop); resolve(); }, ms);
    signal.addEventListener('abort', onStop, { once: true });
  });
}

type Launch = (options: LaunchOptions) => Promise<Browser>;
/** One attempt. A stop ends the starting process (also one that appears after the stop) and waits for the launch
 * to give up, then rejects with the stop reason. A failure kills whatever the attempt started. */
async function launchOnce(launch: Launch, executablePath: string, timeoutMs: number, signal: AbortSignal): Promise<Browser> {
  const marker = `--harness-export-launch=${randomUUID()}`;
  const pending = launch({ executablePath, timeout: timeoutMs, args: [marker] });
  let settled = false;
  const ended = pending.then(() => { settled = true; }, () => { settled = true; });
  let onStop: (() => void) | undefined;
  const stopped = new Promise<'stopped'>(resolve => { onStop = () => resolve('stopped'); signal.addEventListener('abort', onStop, { once: true }); });
  try {
    if (!signal.aborted && await Promise.race([ended.then(() => 'ended' as const), stopped]) === 'ended') {
      try { return await pending; } catch (error) { killMarked(marker); throw error; }
    }
    // Stopped: keep ending the process until the launch gives up (it does once the process is gone).
    while (!settled) { killMarked(marker); await Promise.race([ended, new Promise(resolve => setTimeout(resolve, STOP_POLL_MS))]); }
    killMarked(marker);
    // A launch that completed anyway (its process could not be killed, e.g. on Windows) is closed here.
    const late = await pending.catch(() => undefined);
    await late?.close().catch(() => undefined);
    throw signal.reason;
  } finally { if (onStop) signal.removeEventListener('abort', onStop); }
}

/** Launch Chromium for export: each attempt bounded by `timeoutMs`, `attempts` in all, with a warning per retry. */
export async function launchExportBrowser({ executablePath, signal, launch = options => chromium.launch(options), ...given }: Partial<ExportBrowserLaunch> & {
  executablePath: string; signal: AbortSignal; launch?: Launch;
}): Promise<Browser> {
  const { timeoutMs, attempts, pauseMs } = { ...EXPORT_BROWSER_LAUNCH, ...given };
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal.throwIfAborted();
    try { return await launchOnce(launch, executablePath, timeoutMs, signal); }
    catch (error) {
      signal.throwIfAborted();
      last = error;
      if (attempt < attempts) {
        console.warn(`[sme] 書き出し用のブラウザの起動に失敗しました（${attempt}/${attempts} 回目）。もう一度試します: ${firstLine(error)}`);
        await pause(pauseMs, signal);
      }
    }
  }
  throw new Error(`書き出し用のブラウザを起動できませんでした（${attempts} 回試しました）: ${firstLine(last)}`, { cause: last });
}
