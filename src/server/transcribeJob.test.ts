import { describe, it, expect, vi } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { TranscribeJobManager, type FakeProcess, type TranscribeJobEvent } from './transcribeJob';

function makeFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  const stdout = new EventEmitter() as unknown as Readable;
  const stderr = new EventEmitter() as unknown as Readable;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => true);
  return proc;
}

describe('TranscribeJobManager', () => {
  it('retains synchronous interpreter-resolution failure as one terminal event and allows retry after discard',()=>{
    let fail=true;const proc=makeFakeProcess(),events:TranscribeJobEvent[]=[];
    const mgr=new TranscribeJobManager({spawn:()=>{if(fail)throw new Error('Python 3.10 以上が見つかりません');return proc;}});
    mgr.subscribe('p1',event=>events.push(event));
    const job=mgr.start('p1',{backupPath:'/private/retained-backup'});
    expect(job.phase).toBe('failed');expect(job.backupPath).toBe('/private/retained-backup');expect(mgr.get('p1')).toBe(job);
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({phase:'failed',error:{code:'python-spawn-failed'}});
    mgr.discard('p1');fail=false;expect(mgr.start('p1',{backupPath:null}).phase).toBe('starting');
  });
  it('does not overwrite a new job started by a synchronous failure subscriber',()=>{
    let calls=0;const proc=makeFakeProcess();
    const mgr=new TranscribeJobManager({spawn:()=>{if(calls++===0)throw new Error('resolution failed');return proc;}});
    mgr.subscribe('p1',event=>{if(event.phase==='failed'){mgr.discard('p1');mgr.start('p1',{backupPath:'new'});}});
    const previous=mgr.start('p1',{backupPath:'previous'});
    expect(previous.phase).toBe('failed');expect(mgr.get('p1')).toMatchObject({phase:'starting',backupPath:'new'});
    expect(calls).toBe(2);expect(mgr.cancel('p1')).toBe(true);expect(proc.kill).toHaveBeenCalledTimes(1);
  });
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

  it(
    'stderr を大量に出す実子プロセスでもハングしない（stderr drain 回帰テスト・A-1）',
    async () => {
      // mlx-whisper/openai-whisper のモデルロード進捗・tqdm・警告を模して、
      // OS パイプバッファ（macOS で 64KB 程度）を大きく超える stderr を実際に書かせる。
      // Node の process.stderr.write はパイプに対して非同期（Node のドキュメント通り）で
      // 即座には子プロセスをブロックしないため、Python (mlx-whisper/openai-whisper) の
      // 同期 write と同じブロッキング挙動を fs.writeSync(fd=2, ...) で再現する。
      // stderr に listener が無いと子プロセスの write が本当にブロックし、
      // stdout の completed イベントが永遠に来ない（実測: 5MB 未 drain で 3秒超ハング）。
      const size = 5_000_000;
      const script =
        `require('fs').writeSync(2, 'x'.repeat(${size}));` +
        `process.stdout.write(JSON.stringify({phase:'completed'})+'\\n');`;
      const realProc = nodeSpawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as FakeProcess;

      const mgr = new TranscribeJobManager({ spawn: () => realProc });
      const completed = new Promise<void>((resolve) => {
        mgr.subscribe('p1', (ev) => {
          if (ev.phase === 'completed') resolve();
        });
      });
      mgr.start('p1', { backupPath: null });

      try {
        await Promise.race([
          completed,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('timeout: stderr が drain されずハングした')),
              4000,
            ),
          ),
        ]);
      } finally {
        mgr.cancel('p1');
      }
    },
    8000,
  );
});
