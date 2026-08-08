import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { DenoiseJobManager, type FakeProcess, type DenoiseJobEvent } from './denoiseJob';

function makeFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  const stdout = new EventEmitter() as unknown as Readable;
  const stderr = new EventEmitter() as unknown as Readable;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => true);
  return proc;
}

describe('DenoiseJobManager', () => {
  it('start で job を登録し phase=preparing で初期化する', () => {
    const mgr = new DenoiseJobManager({ spawn: () => makeFakeProcess(), rename: vi.fn() });
    const job = mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    expect(job.projectId).toBe('p1');
    expect(job.phase).toBe('preparing');
    expect(mgr.exists('p1')).toBe(true);
  });

  it('同じ projectId で 2 度 start するとエラー（排他1本）', () => {
    const mgr = new DenoiseJobManager({ spawn: () => makeFakeProcess(), rename: vi.fn() });
    const opts = {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    };
    mgr.start('p1', opts);
    expect(() => mgr.start('p1', opts)).toThrow(/already-running/);
  });

  it('SSE イベント列: preparing→denoising→finalizing→done を発行する', () => {
    const proc = makeFakeProcess();
    const rename = vi.fn();
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename });
    const phases: string[] = [];
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/tmp/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    mgr.subscribe('p1', (ev) => phases.push(ev.phase));

    // spawn 後の最初の stdout 書き込みで denoising へ
    proc.stdout.emit('data', Buffer.from('frame=1\n'));
    // exit 0 で finalizing→done
    proc.emit('exit', 0);

    expect(phases).toContain('denoising');
    expect(phases).toContain('done');
  });

  it('成功後に tmpOutput → finalOutput のアトミック rename を呼ぶ', () => {
    const proc = makeFakeProcess();
    const rename = vi.fn();
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename });
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/tmp/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    proc.emit('exit', 0);
    expect(rename).toHaveBeenCalledWith('/tmp/out.mp4', '/proj/main.mp4');
  });

  it('rename は exit の前（finalizing）に呼ばれ、done は rename の後', () => {
    const proc = makeFakeProcess();
    const callOrder: string[] = [];
    const rename = vi.fn().mockImplementation(() => callOrder.push('rename'));
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename });
    mgr.subscribe('p1', (ev) => {
      if (ev.phase === 'done') callOrder.push('done');
    });
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/tmp/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    proc.emit('exit', 0);
    // rename が done の前
    expect(callOrder[0]).toBe('rename');
    expect(callOrder[1]).toBe('done');
  });

  it('exit != 0 で failed を発行し cleanup する', () => {
    const proc = makeFakeProcess();
    const rename = vi.fn();
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename });
    const events: DenoiseJobEvent[] = [];
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/tmp/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    mgr.subscribe('p1', (ev) => events.push(ev));
    proc.emit('exit', 1);
    const last = events.at(-1);
    expect(last?.phase).toBe('failed');
    expect(rename).not.toHaveBeenCalled();
    expect(mgr.exists('p1')).toBe(false);
  });

  it('spawn error で failed を発行しサーバを落とさない', () => {
    const proc = makeFakeProcess();
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename: vi.fn() });
    const events: DenoiseJobEvent[] = [];
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/tmp/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    mgr.subscribe('p1', (ev) => events.push(ev));
    expect(() => proc.emit('error', new Error('spawn ENOENT'))).not.toThrow();
    const last = events.at(-1);
    expect(last?.phase).toBe('failed');
    expect(last?.error?.code).toBe('ffmpeg-spawn-failed');
  });

  it('cancel で SIGTERM を送り job を削除', () => {
    const proc = makeFakeProcess();
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename: vi.fn() });
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: ['-y', '-i', '/in.mp4', '-af', 'afftdn=nr=12', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '/tmp/out.mp4'],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    const ok = mgr.cancel('p1');
    expect(ok).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mgr.exists('p1')).toBe(false);
  });

  it('未登録 cancel は false を返す', () => {
    const mgr = new DenoiseJobManager({ spawn: () => makeFakeProcess(), rename: vi.fn() });
    expect(mgr.cancel('none')).toBe(false);
  });

  it('discard で終了ジョブを破棄する', () => {
    const proc = makeFakeProcess();
    const mgr = new DenoiseJobManager({ spawn: () => proc, rename: vi.fn() });
    mgr.start('p1', {
      ffmpeg: 'ffmpeg',
      ffmpegArgs: [],
      tmpOutput: '/tmp/out.mp4',
      finalOutput: '/proj/main.mp4',
    });
    proc.emit('error', new Error('spawn ENOENT'));
    expect(mgr.exists('p1')).toBe(true);
    mgr.discard('p1');
    expect(mgr.exists('p1')).toBe(false);
  });
});
