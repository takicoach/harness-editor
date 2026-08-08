import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, 'transcribe.py');

function runScript(args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
    return { stdout, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', code: err.status ?? 1 };
  }
}

describe('scripts/transcribe.py', () => {
  it('--mock-backend で固定の JSON Lines を出して exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcribe-test-'));
    const out = join(dir, 'transcript.json');
    try {
      const { stdout, code } = runScript([
        '--mock-backend', '--video', '/dev/null', '--out', out,
      ]);
      expect(code).toBe(0);
      const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.phase)).toEqual([
        'loading-model', 'analyzing', 'writing', 'completed',
      ]);
      const written = JSON.parse(readFileSync(out, 'utf8'));
      expect(written.words.length).toBeGreaterThan(0);
      expect(typeof written.duration_ms).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--video が無いと exit 1 と failed イベント', () => {
    const { stdout, code } = runScript(['--mock-backend', '--out', '/tmp/x.json']);
    expect(code).toBe(1);
    const last = stdout.trim().split('\n').map((l) => JSON.parse(l)).pop();
    expect(last?.phase).toBe('failed');
  });

  it('--detect-backend で利用可能 backend を出力（mlx > openai の優先順位）', () => {
    const { stdout, code } = runScript(['--detect-backend']);
    // mlx-whisper か openai-whisper のいずれかが入っていれば 0
    // どちらも入っていなければ failed
    if (code === 0) {
      expect(stdout.trim()).toMatch(/^(mlx-whisper|openai-whisper)$/);
    } else {
      const ev = JSON.parse(stdout.trim().split('\n').pop()!);
      expect(ev.phase).toBe('failed');
      expect(ev.error.code).toBe('no-whisper-backend');
    }
  });
});
