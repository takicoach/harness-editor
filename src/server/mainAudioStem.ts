import { spawn } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { buildMainAudioFilter, type MainAudioFilterInput } from './mainAudioFilter';

export interface BuildMainAudioStemOptions {
  /** Absolute path to the immutable source selected for this render. */
  sourcePath: string;
  filterInput: MainAudioFilterInput;
  signal: AbortSignal;
  /** Resolved ffmpeg executable path (a PATH command is also accepted). */
  ffmpegPath: string;
  /** Existing absolute parent under which this call creates one owned directory. */
  tempBasePath: string;
}

export interface MainAudioStem {
  /** Absolute 48 kHz stereo float-PCM WAV path. */
  stemPath: string;
  /** Removes only this invocation's directory. Safe to call repeatedly. */
  cleanup: () => void;
}

const STDERR_LIMIT = 32 * 1024;
const FORCE_KILL_AFTER_MS = 2_000;

function abortError(): Error {
  const error = new Error('Main audio stem preparation was aborted');
  error.name = 'AbortError';
  return error;
}

function assertPath(value: string, label: string, absolute: boolean): void {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must not be empty`);
  if (absolute && !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

export async function runMainAudioFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortError();

  const child = spawn(ffmpegPath, args, {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let spawnFailure: Error | undefined;
  let closed = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  const onAbort = () => {
    if (closed) return;
    try { child.kill('SIGTERM'); } catch { /* close/error still determines completion */ }
    forceKillTimer = setTimeout(() => {
      if (!closed) {
        try { child.kill('SIGKILL'); } catch { /* wait for the process completion event */ }
      }
    }, FORCE_KILL_AFTER_MS);
    forceKillTimer.unref();
  };

  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => { spawnFailure = error; });
    child.once('close', (code, terminationSignal) => {
      closed = true;
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      if (spawnFailure !== undefined) {
        reject(new Error(`Unable to start ffmpeg: ${spawnFailure.message}`, { cause: spawnFailure }));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        reject(new Error(
          `ffmpeg failed${code === null ? ` after ${terminationSignal ?? 'an unknown signal'}` : ` with exit code ${code}`}`
            + (detail === '' ? '' : `: ${detail}`),
        ));
        return;
      }
      resolve();
    });
  });

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await completion;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
}

/**
 * Materialize buildMainAudioFilter as one owned WAV input for Remotion.
 *
 * Until this promise resolves, this function owns every allocated resource. On
 * success ownership transfers through cleanup; aborting the old signal later
 * cannot remove an already returned stem.
 */
export async function buildMainAudioStem(options: BuildMainAudioStemOptions): Promise<MainAudioStem> {
  assertPath(options.sourcePath, 'sourcePath', true);
  assertPath(options.ffmpegPath, 'ffmpegPath', false);
  assertPath(options.tempBasePath, 'tempBasePath', true);
  const built = buildMainAudioFilter(options.filterInput);
  if (options.signal.aborted) throw abortError();

  const ownedDirectory = await mkdtemp(join(options.tempBasePath, 'main-audio-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    rmSync(ownedDirectory, { recursive: true, force: true });
    cleaned = true;
  };
  let transferred = false;
  try {
    const filterPath = join(ownedDirectory, 'filter.ffscript');
    const stemPath = join(ownedDirectory, 'main-audio.wav');
    await writeFile(filterPath, built.filter, { encoding: 'utf8', flag: 'wx' });
    if (options.signal.aborted) throw abortError();

    await runMainAudioFfmpeg(options.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', options.sourcePath,
      '-/filter_complex', filterPath,
      '-map', '[mainaudio]',
      '-vn',
      '-ar', String(built.sampleRate),
      '-ac', '2',
      '-c:a', 'pcm_f32le',
      stemPath,
    ], options.signal);

    if (options.signal.aborted) throw abortError();
    const output = await stat(stemPath);
    if (!output.isFile() || output.size === 0) throw new Error('ffmpeg did not create the main audio stem');
    if (options.signal.aborted) throw abortError();

    transferred = true;
    return { stemPath, cleanup };
  } finally {
    if (!transferred) cleanup();
  }
}
