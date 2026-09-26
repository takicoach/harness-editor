import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { VIDEO_CONFIG_SOURCE } from '../core/__fixtures__/videoConfig.fixture';
import { projectWatchPaths } from './projectWatchPaths';
import { watchProject } from './watchProject';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(videoFile = 'main.mp4'): string {
  const dir = mkdtempSync(join(tmpdir(), 'script-watch-audit-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), VIDEO_CONFIG_SOURCE.replace("'main.mp4'", `'${videoFile}'`));
  writeFileSync(join(dir, 'transcript.json'), '{"words":[]}\n');
  writeFileSync(join(dir, 'public', videoFile), 'source-a');
  return dir;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('watch event timeout');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
}

describe('script correspondence dynamic watch audit', () => {
  it('keeps config-derived watch paths inside public and includes transcript, source and the future proxy', () => {
    const dir = makeProject();
    expect(projectWatchPaths(dir)).toEqual(expect.arrayContaining([
      join(dir, 'transcript.json'),
      join(dir, 'public', 'main.mp4'),
      join(dir, 'public', 'main.preview.mp4'),
    ]));

    writeFileSync(join(dir, 'src', 'videoConfig.ts'), VIDEO_CONFIG_SOURCE.replace("'main.mp4'", "'../../outside.mp4'"));
    const publicDir = resolve(dir, 'public');
    for (const path of projectWatchPaths(dir)) {
      if (!path.includes(`${sep}public${sep}`)) continue;
      const rel = relative(publicDir, path);
      expect(rel === '..' || rel.startsWith(`..${sep}`)).toBe(false);
    }
    expect(projectWatchPaths(dir)).not.toContain(resolve(dir, '..', 'outside.mp4'));
  });

  it('emits when an initially absent preview proxy is created', async () => {
    const dir = makeProject();
    const onChange = vi.fn();
    const stop = watchProject(dir, onChange, { debounceMs: 20 });
    try {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      expect(onChange).not.toHaveBeenCalled();
      writeFileSync(join(dir, 'public', 'unrelated-upload.mp4'), 'unrelated');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      expect(onChange).not.toHaveBeenCalled();
      writeFileSync(join(dir, 'public', 'main.preview.mp4'), 'proxy');
      await waitUntil(() => onChange.mock.calls.length >= 1);
    } finally {
      stop();
    }
  }, 10_000);

  it('keeps supported source symlinks observable without adding their outside target to the allowlist', async () => {
    const dir = makeProject();
    const externalDir = mkdtempSync(join(tmpdir(), 'script-watch-external-audit-'));
    dirs.push(externalDir);
    const target = join(externalDir, 'camera.mov');
    writeFileSync(target, 'external-a');
    unlinkSync(join(dir, 'public', 'main.mp4'));
    symlinkSync(target, join(dir, 'public', 'main.mp4'));
    expect(projectWatchPaths(dir)).not.toContain(target);

    const onChange = vi.fn();
    const stop = watchProject(dir, onChange, { debounceMs: 20 });
    try {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      expect(onChange).not.toHaveBeenCalled();
      writeFileSync(target, 'external-b');
      await waitUntil(() => onChange.mock.calls.length >= 1);
    } finally {
      stop();
    }
  }, 10_000);

  it('emits for transcript/source and adds the replacement source and future proxy after videoConfig changes', async () => {
    const dir = makeProject();
    const onChange = vi.fn();
    const stop = watchProject(dir, onChange, { debounceMs: 20 });
    try {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));

      writeFileSync(join(dir, 'transcript.json'), '{"words":[{"text":"a","start":0,"end":1}]}\n');
      await waitUntil(() => onChange.mock.calls.length >= 1);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      onChange.mockClear();

      writeFileSync(join(dir, 'public', 'main.mp4'), 'source-b');
      await waitUntil(() => onChange.mock.calls.length >= 1);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      onChange.mockClear();

      // The replacement commonly already exists when config switches to it. The config event must
      // add that exact file to the live watcher for later changes.
      writeFileSync(join(dir, 'public', 'next.mp4'), 'next-source-a');
      writeFileSync(join(dir, 'src', 'videoConfig.ts'), VIDEO_CONFIG_SOURCE.replace("'main.mp4'", "'next.mp4'"));
      await waitUntil(() => onChange.mock.calls.length >= 1);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      onChange.mockClear();

      writeFileSync(join(dir, 'public', 'next.mp4'), 'next-source-b');
      await waitUntil(() => onChange.mock.calls.length >= 1);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      onChange.mockClear();

      writeFileSync(join(dir, 'public', 'next.preview.mp4'), 'next-proxy');
      await waitUntil(() => onChange.mock.calls.length >= 1);
    } finally {
      stop();
    }
  }, 15_000);
});
