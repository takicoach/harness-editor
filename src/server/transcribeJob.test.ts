import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { TranscribeJobManager, type FakeProcess, type TranscribeJobEvent } from './transcribeJob';

function makeFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  const stdout = new EventEmitter() as unknown as Readable;
  proc.stdout = stdout;
  proc.kill = vi.fn(() => true);
  return proc;
}

describe('TranscribeJobManager', () => {
  it('start で job を登録し phase=starting で初期化する', () => {
    const mgr = new TranscribeJobManager({ spawn: () => makeFakeProcess() });
    const job = mgr.start('p1', { backupPath: '/tmp/bak.json' });
    expect(job.projectId).toBe('p1');
    expect(job.phase).toBe('starting');
    expect(mgr.exists('p1')).toBe(true);
  });

  it('同じ projectId で 2 度 start するとエラー', () => {
    const mgr = new TranscribeJobManager({ spawn: () => makeFakeProcess() });
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    expect(() => mgr.start('p1', { backupPath: '/tmp/bak.json' }))
      .toThrow(/already-running/);
  });

  it('subprocess の JSON Lines を phase へ反映、listener を呼ぶ', () => {
    const proc = makeFakeProcess();
    const mgr = new TranscribeJobManager({ spawn: () => proc });
    const events: Array<{ phase: string; percent?: number }> = [];
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    mgr.subscribe('p1', (ev) => events.push(ev));
    proc.stdout.emit('data', Buffer.from('{"phase":"loading-model"}\n{"phase":"analyzing","percent":33}\n'));
    expect(events.map((e) => e.phase)).toEqual(['loading-model', 'analyzing']);
    expect(mgr.get('p1')?.phase).toBe('analyzing');
    expect(mgr.get('p1')?.percent).toBe(33);
  });

  it('completed で job を削除（次の start を許す）', () => {
    const proc = makeFakeProcess();
    const mgr = new TranscribeJobManager({ spawn: () => proc });
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    proc.stdout.emit('data', Buffer.from('{"phase":"completed"}\n'));
    proc.emit('exit', 0);
    expect(mgr.exists('p1')).toBe(false);
  });

  it('spawn の error（stale な Python パス等）を failed ジョブへ変換しサーバを落とさない', () => {
    const proc = makeFakeProcess();
    const mgr = new TranscribeJobManager({ spawn: () => proc });
    const events: TranscribeJobEvent[] = [];
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    mgr.subscribe('p1', (ev) => events.push(ev));
    // error listener が無ければここで unhandled error として throw される。
    expect(() => proc.emit('error', new Error('spawn /bad/python ENOENT'))).not.toThrow();
    const last = events.at(-1);
    expect(last?.phase).toBe('failed');
    expect(last?.error?.code).toBe('python-spawn-failed');
    expect(last?.error?.message).toContain('HARNESS_PYTHON');
    expect(last?.error?.message).toContain('SUPERMOVIE_PYTHON');
    // 終了状態は保持される（SSE が観測する前に消さない）。snapshot も failed のまま。
    expect(mgr.exists('p1')).toBe(true);
    expect(mgr.get('p1')?.phase).toBe('failed');
  });

  it('discard で保持された終了ジョブを破棄して再 start を許す', () => {
    const proc = makeFakeProcess();
    const mgr = new TranscribeJobManager({ spawn: () => proc });
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    proc.emit('error', new Error('spawn /bad/python ENOENT'));
    expect(mgr.exists('p1')).toBe(true);
    mgr.discard('p1');
    expect(mgr.exists('p1')).toBe(false);
  });

  it('cancel で SIGTERM を送り job を削除', () => {
    const proc = makeFakeProcess();
    const mgr = new TranscribeJobManager({ spawn: () => proc });
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    const ok = mgr.cancel('p1');
    expect(ok).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mgr.exists('p1')).toBe(false);
  });

  it('未登録の cancel は false を返す', () => {
    const mgr = new TranscribeJobManager({ spawn: () => makeFakeProcess() });
    expect(mgr.cancel('p1')).toBe(false);
  });

  it('途中の改行で分割された JSON は次の chunk と結合される', () => {
    const proc = makeFakeProcess();
    const mgr = new TranscribeJobManager({ spawn: () => proc });
    mgr.start('p1', { backupPath: '/tmp/bak.json' });
    const events: Array<{ phase: string }> = [];
    mgr.subscribe('p1', (ev) => events.push(ev));
    proc.stdout.emit('data', Buffer.from('{"phase":"loa'));
    proc.stdout.emit('data', Buffer.from('ding-model"}\n'));
    expect(events.map((e) => e.phase)).toEqual(['loading-model']);
  });
});
