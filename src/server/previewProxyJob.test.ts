import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  PreviewProxyJobManager,
  durationsMatch,
  parseProgressSeconds,
  type FakeProcess,
  type PreviewProxyEvent,
  type StartPreviewProxyOptions,
} from './previewProxyJob';

function makeFakeProc(): FakeProcess {
  const em = new EventEmitter() as FakeProcess;
  em.stdout = new Readable({ read() {} });
  em.stderr = new Readable({ read() {} });
  em.kill = vi.fn(() => true);
  return em;
}

function baseOpts(overrides: Partial<StartPreviewProxyOptions> = {}): StartPreviewProxyOptions {
  return {
    ffmpeg: 'ffmpeg',
    ffmpegArgs: ['-y'],
    tmpOutput: '/pj/public/.sme-preview-tmp.mp4',
    finalOutput: '/pj/public/main.preview.mp4',
    durationSeconds: 100,
    probeDuration: () => 100,
    ...overrides,
  };
}

describe('parseProgressSeconds', () => {
  it('out_time= を秒へ変換し、複数行は最後を採用する', () => {
    expect(parseProgressSeconds('out_time=00:00:30.500000\n')).toBe(30.5);
    expect(
      parseProgressSeconds('out_time=00:00:10.000000\nfps=99\nout_time=00:01:00.000000\n'),
    ).toBe(60);
    expect(parseProgressSeconds('out_time=01:02:03.000000\n')).toBe(3723);
  });
  it('out_time が無ければ null', () => {
    expect(parseProgressSeconds('frame=100\nfps=30\n')).toBeNull();
  });
});

describe('durationsMatch', () => {
  it('±max(1.5秒, 0.5%) を許容する', () => {
    expect(durationsMatch(100, 100.4)).toBe(true);
    expect(durationsMatch(100, 98.4)).toBe(false);
    expect(durationsMatch(1410, 1405)).toBe(true); // 0.5% = 7.05 秒
    expect(durationsMatch(1410, 1400)).toBe(false);
  });
});

describe('PreviewProxyJobManager', () => {
  function setup(opts?: Partial<StartPreviewProxyOptions>) {
    const procs: FakeProcess[] = [];
    const spawn = vi.fn(() => {
      const p = makeFakeProc();
      procs.push(p);
      return p;
    });
    const rename = vi.fn();
    const unlink = vi.fn();
    const m = new PreviewProxyJobManager({ spawn, rename, unlink });
    const events: PreviewProxyEvent[] = [];
    m.start('p1', baseOpts(opts));
    m.subscribe('p1', (ev) => events.push(ev));
    return { m, procs, rename, unlink, events };
  }

  it('進捗行で converting + percent を emit し、単調増加のみ通す', () => {
    const { m, procs, events } = setup();
    procs[0]!.stdout.emit('data', 'out_time=00:00:25.000000\n');
    expect(m.get('p1')!.percent).toBe(25);
    procs[0]!.stdout.emit('data', 'out_time=00:00:10.000000\n'); // 逆行は無視
    expect(m.get('p1')!.percent).toBe(25);
    procs[0]!.stdout.emit('data', 'out_time=00:01:39.000000\n');
    expect(m.get('p1')!.percent).toBe(99);
    expect(events.filter((e) => e.phase === 'converting').length).toBeGreaterThanOrEqual(2);
  });

  it('exit 0 → 尺一致 → rename → done(percent 100)', () => {
    const { procs, rename, events } = setup();
    procs[0]!.stdout.emit('data', 'out_time=00:01:40.000000\n');
    procs[0]!.emit('exit', 0);
    expect(rename).toHaveBeenCalledWith('/pj/public/.sme-preview-tmp.mp4', '/pj/public/main.preview.mp4');
    expect(events.at(-1)).toEqual({ phase: 'done' });
  });

  it('尺不一致は tmp を削除して failed（rename しない）', () => {
    const { procs, rename, unlink, events } = setup({ probeDuration: () => 42 });
    procs[0]!.emit('exit', 0);
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith('/pj/public/.sme-preview-tmp.mp4');
    const last = events.at(-1)!;
    expect(last.phase).toBe('failed');
    expect(last.error!.code).toBe('duration-mismatch');
  });

  it('尺の測定失敗（null）も failed', () => {
    const { procs, events } = setup({ probeDuration: () => null });
    procs[0]!.emit('exit', 0);
    expect(events.at(-1)!.error!.code).toBe('duration-mismatch');
  });

  it('exit 非0 は tmp を削除して failed', () => {
    const { procs, unlink, events } = setup();
    procs[0]!.emit('exit', 1);
    expect(unlink).toHaveBeenCalledWith('/pj/public/.sme-preview-tmp.mp4');
    expect(events.at(-1)!.error!.code).toBe('ffmpeg-error');
  });

  it('cancel は SIGTERM + tmp 削除 + cancelled', () => {
    const { m, procs, unlink, events } = setup();
    expect(m.cancel('p1')).toBe(true);
    expect(procs[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(unlink).toHaveBeenCalledWith('/pj/public/.sme-preview-tmp.mp4');
    expect(events.at(-1)).toEqual({ phase: 'cancelled' });
    expect(m.exists('p1')).toBe(false);
  });

  it('spawn error はジョブを保持したまま failed（SSE 観測まで discard しない）', () => {
    const { m, procs, events } = setup();
    procs[0]!.emit('error', new Error('ENOENT'));
    expect(events.at(-1)!.phase).toBe('failed');
    expect(m.get('p1')!.phase).toBe('failed');
    m.discard('p1');
    expect(m.exists('p1')).toBe(false);
  });

  it('同一プロジェクトの二重 start は例外', () => {
    const { m } = setup();
    expect(() => m.start('p1', baseOpts())).toThrowError('already-running');
  });
});
