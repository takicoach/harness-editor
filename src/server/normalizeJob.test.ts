import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { NormalizeJobManager, type FakeProcess, type NormalizeJobEvent, type StartNormalizeOptions } from './normalizeJob';
import type { LoudnormMeasured } from './buildNormalizeArgs';

function makeFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter() as unknown as Readable;
  proc.stderr = new EventEmitter() as unknown as Readable;
  proc.kill = vi.fn(() => true);
  return proc;
}

const MEASURED: LoudnormMeasured = {
  input_i: '-27.1', input_tp: '-9.9', input_lra: '7.4', input_thresh: '-37.4', target_offset: '0.46',
};

/** spawn が呼ばれるたびに配列の先頭 proc を返すヘルパ。 */
function sequencedSpawn(procs: FakeProcess[]) {
  let i = 0;
  return () => procs[i++]!;
}

function baseOpts(over: Partial<StartNormalizeOptions> = {}): StartNormalizeOptions {
  return {
    ffmpeg: 'ffmpeg',
    measureArgs: ['-i', '/in.mp4', '-af', 'loudnorm=...:print_format=json', '-f', 'null', '-'],
    parseMeasured: () => MEASURED,
    buildApplyArgs: (m) => ['-y', '-i', '/in.mp4', '-af', m ? 'apply-measured' : 'apply-dynamic', '/tmp/out.mp4'],
    tmpOutput: '/tmp/out.mp4',
    finalOutput: '/proj/public/main.mp4',
    ...over,
  };
}

describe('NormalizeJobManager（2パス）', () => {
  it('start で preparing 初期化、exists=true', () => {
    const mgr = new NormalizeJobManager({ spawn: () => makeFakeProcess(), rename: vi.fn() });
    const job = mgr.start('p1', baseOpts());
    expect(job.phase).toBe('preparing');
    expect(mgr.exists('p1')).toBe(true);
  });

  it('2度 start で already-running', () => {
    const mgr = new NormalizeJobManager({ spawn: () => makeFakeProcess(), rename: vi.fn() });
    mgr.start('p1', baseOpts());
    expect(() => mgr.start('p1', baseOpts())).toThrow(/already-running/);
  });

  it('イベント列: measuring→normalizing→finalizing→done を発行する', () => {
    const measure = makeFakeProcess();
    const apply = makeFakeProcess();
    const rename = vi.fn();
    const mgr = new NormalizeJobManager({ spawn: sequencedSpawn([measure, apply]), rename });
    const phases: string[] = [];
    mgr.start('p1', baseOpts());
    mgr.subscribe('p1', (ev) => phases.push(ev.phase));

    measure.stderr.emit('data', Buffer.from('{...}'));   // measuring へ
    measure.emit('exit', 0);                              // → 適用 spawn（normalizing）
    apply.stdout.emit('data', Buffer.from('frame=1\n'));
    apply.emit('exit', 0);                                // → finalizing→done

    expect(phases).toContain('measuring');
    expect(phases).toContain('normalizing');
    expect(phases).toContain('finalizing');
    expect(phases).toContain('done');
  });

  it('測定 exit(0) 後に parseMeasured の結果で buildApplyArgs が呼ばれる', () => {
    const measure = makeFakeProcess();
    const apply = makeFakeProcess();
    const buildApplyArgs = vi.fn((m: LoudnormMeasured | null) => ['-y', '-af', m ? 'measured' : 'dyn', '/tmp/out.mp4']);
    const parseMeasured = vi.fn(() => MEASURED);
    const mgr = new NormalizeJobManager({ spawn: sequencedSpawn([measure, apply]), rename: vi.fn() });
    mgr.start('p1', baseOpts({ parseMeasured, buildApplyArgs }));
    measure.stderr.emit('data', Buffer.from('json'));
    measure.emit('exit', 0);
    expect(parseMeasured).toHaveBeenCalled();
    expect(buildApplyArgs).toHaveBeenCalledWith(MEASURED);
  });

  it('parseMeasured が null でも buildApplyArgs(null) で続行する（フォールバック）', () => {
    const measure = makeFakeProcess();
    const apply = makeFakeProcess();
    const buildApplyArgs = vi.fn(() => ['-y', '/tmp/out.mp4']);
    const mgr = new NormalizeJobManager({ spawn: sequencedSpawn([measure, apply]), rename: vi.fn() });
    mgr.start('p1', baseOpts({ parseMeasured: () => null, buildApplyArgs }));
    measure.emit('exit', 0);
    expect(buildApplyArgs).toHaveBeenCalledWith(null);
  });

  it('適用成功後に tmp→final の rename を呼び、done は rename の後', () => {
    const measure = makeFakeProcess();
    const apply = makeFakeProcess();
    const order: string[] = [];
    const rename = vi.fn(() => order.push('rename'));
    const mgr = new NormalizeJobManager({ spawn: sequencedSpawn([measure, apply]), rename });
    mgr.subscribe('p1', (ev) => { if (ev.phase === 'done') order.push('done'); });
    mgr.start('p1', baseOpts());
    measure.emit('exit', 0);
    apply.emit('exit', 0);
    expect(rename).toHaveBeenCalledWith('/tmp/out.mp4', '/proj/public/main.mp4');
    expect(order).toEqual(['rename', 'done']);
  });

  it('測定 exit!=0 で failed・適用 spawn しない・rename しない', () => {
    const measure = makeFakeProcess();
    const apply = makeFakeProcess();
    const spawn = vi.fn(sequencedSpawn([measure, apply]));
    const rename = vi.fn();
    const mgr = new NormalizeJobManager({ spawn, rename });
    const events: NormalizeJobEvent[] = [];
    mgr.start('p1', baseOpts());
    mgr.subscribe('p1', (ev) => events.push(ev));
    measure.emit('exit', 1);
    expect(events.at(-1)?.phase).toBe('failed');
    expect(spawn).toHaveBeenCalledTimes(1); // 適用は spawn されない
    expect(rename).not.toHaveBeenCalled();
    expect(mgr.exists('p1')).toBe(false);
  });

  it('適用 exit!=0 で failed', () => {
    const measure = makeFakeProcess();
    const apply = makeFakeProcess();
    const mgr = new NormalizeJobManager({ spawn: sequencedSpawn([measure, apply]), rename: vi.fn() });
    const events: NormalizeJobEvent[] = [];
    mgr.start('p1', baseOpts());
    mgr.subscribe('p1', (ev) => events.push(ev));
    measure.emit('exit', 0);
    apply.emit('exit', 2);
    expect(events.at(-1)?.phase).toBe('failed');
    expect(mgr.exists('p1')).toBe(false);
  });

  it('spawn error で failed・サーバを落とさず保持（discard で破棄）', () => {
    const measure = makeFakeProcess();
    const mgr = new NormalizeJobManager({ spawn: () => measure, rename: vi.fn() });
    const events: NormalizeJobEvent[] = [];
    mgr.start('p1', baseOpts());
    mgr.subscribe('p1', (ev) => events.push(ev));
    expect(() => measure.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(events.at(-1)?.error?.code).toBe('ffmpeg-spawn-failed');
    expect(mgr.exists('p1')).toBe(true);
    mgr.discard('p1');
    expect(mgr.exists('p1')).toBe(false);
  });

  it('cancel は現在の proc を kill して job を削除', () => {
    const measure = makeFakeProcess();
    const mgr = new NormalizeJobManager({ spawn: () => measure, rename: vi.fn() });
    mgr.start('p1', baseOpts());
    expect(mgr.cancel('p1')).toBe(true);
    expect(measure.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mgr.exists('p1')).toBe(false);
  });
});
