import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessSafetyNet, installProcessSafetyNet } from './processSafetyNet';

/**
 * 実プロセスへ登録されたハンドラを、このテストの外へ漏らさないための後始末。
 * ここを漏らすと **vitest 自身が未処理 rejection を検知できなくなる**
 * （砦が握り潰して継続するため）。ファイル単位分離に依存すると
 * `--no-isolate` や pool 変更で静かに fail-open するので、
 * 登録差分を自前で取り除いて封じ込める（前ラウンドのレビュー minor 指摘）。
 */
function withoutLeakingHandlers(fn: () => void): void {
  const beforeUncaught = process.listeners('uncaughtException');
  const beforeRejection = process.listeners('unhandledRejection');
  try {
    fn();
  } finally {
    for (const l of process.listeners('uncaughtException')) {
      if (!beforeUncaught.includes(l)) process.off('uncaughtException', l);
    }
    for (const l of process.listeners('unhandledRejection')) {
      if (!beforeRejection.includes(l)) process.off('unhandledRejection', l);
    }
  }
}

describe('createProcessSafetyNet', () => {
  it('通常時は継続する（exit を呼ばずログだけ残す）', () => {
    const log = vi.fn();
    const exit = vi.fn();
    const net = createProcessSafetyNet({ log, exit, now: () => 0 });
    net.handle('uncaughtException', new Error('isolated glitch'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('unhandledRejection も同じく継続する', () => {
    const log = vi.fn();
    const exit = vi.fn();
    const net = createProcessSafetyNet({ log, exit, now: () => 0 });
    net.handle('unhandledRejection', 'some rejection reason');
    expect(log).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('窓内に limit を超えて連続すると復旧不能とみなして終了する', () => {
    const log = vi.fn();
    const exit = vi.fn();
    let t = 0;
    const net = createProcessSafetyNet({ log, exit, now: () => t, windowMs: 10_000, limit: 3 });
    for (let i = 0; i < 4; i++) {
      t += 10; // 窓の外へは出ない
      net.handle('uncaughtException', new Error(`err-${i}`));
    }
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('窓が過ぎればカウントがリセットされ、終了しない', () => {
    const log = vi.fn();
    const exit = vi.fn();
    let t = 0;
    const net = createProcessSafetyNet({ log, exit, now: () => t, windowMs: 1_000, limit: 2 });
    net.handle('uncaughtException', new Error('a'));
    net.handle('uncaughtException', new Error('b'));
    t += 2_000; // 窓を過ぎる
    net.handle('uncaughtException', new Error('c'));
    expect(exit).not.toHaveBeenCalled();
  });

  it('install() は同一ネットで process.on を1回しか登録しない（二重配線防止）', () => {
    const onSpy = vi.spyOn(process, 'on');
    try {
      withoutLeakingHandlers(() => {
        const net = createProcessSafetyNet({ log: vi.fn(), exit: vi.fn() });
        net.install();
        net.install();
        net.install();
      });
      const registeredKinds = onSpy.mock.calls
        .filter(([event]) => event === 'uncaughtException' || event === 'unhandledRejection')
        .map(([event]) => event);
      expect(registeredKinds).toEqual(['uncaughtException', 'unhandledRejection']);
    } finally {
      onSpy.mockRestore();
    }
  });

  it('installProcessSafetyNet() をモジュール単位で複数回呼んでも実配線は1組だけ', () => {
    const onSpy = vi.spyOn(process, 'on');
    try {
      withoutLeakingHandlers(() => {
        installProcessSafetyNet();
        installProcessSafetyNet();
      });
      const registeredKinds = onSpy.mock.calls
        .filter(([event]) => event === 'uncaughtException' || event === 'unhandledRejection')
        .map(([event]) => event);
      // このプロセス内で以前に呼ばれていない前提が崩れても壊れないよう、
      // 「呼ぶたびに増え続けない」ことだけを保証する（0 or 1 組）。
      expect(registeredKinds.length).toBeLessThanOrEqual(2);
    } finally {
      onSpy.mockRestore();
    }
  });
});

/**
 * 上のテスト群は exit/log を差し替えた「判定ロジック」の検査であり、
 * 「実プロセスが本当に生き残るか」は一切証明していない（壊れたプローブと
 * 区別がつかない）。ここでは実際に子プロセスを起動し、
 *   ・砦なし → 非同期 throw でプロセスが死ぬ（＝プローブが本物であることの存在検査）
 *   ・砦あり → 同じ throw で死なず、以後の処理が続いて exit 0 で終わる
 * を両方向で実測する。片側だけでは「そもそも throw が届いていない」を排除できない。
 */
describe('installProcessSafetyNet（実プロセスでの効き目）', () => {
  const src = fileURLToPath(new URL('./processSafetyNet.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  let dir = '';

  /** 子スクリプトを書き出して実行し、終了コードと標準出力/エラーを返す。 */
  function runChild(body: string): { code: number | null; out: string } {
    dir = mkdtempSync(join(tmpdir(), 'sme-safetynet-'));
    const file = join(dir, 'child.ts');
    writeFileSync(file, `import { installProcessSafetyNet } from ${JSON.stringify(src)};\n${body}\n`);
    const r = spawnSync(process.execPath, [tsx, file], { encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const THROW_LATER = `setTimeout(() => { throw new Error('boom'); }, 10);
setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 300);`;

  it('砦を入れないと非同期 throw でプロセスが死ぬ（プローブが本物であることの確認）', () => {
    const r = runChild(THROW_LATER);
    expect(r.out).not.toContain('SURVIVED');
    expect(r.code).not.toBe(0);
  });

  it('砦を入れると同じ throw で死なず、処理が続く', () => {
    const r = runChild(`installProcessSafetyNet();\n${THROW_LATER}`);
    expect(r.out).toContain('SURVIVED');
    expect(r.code).toBe(0);
  });

  const REJECT_LATER = `setTimeout(() => { void Promise.reject(new Error('boom')); }, 10);
setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 300);`;

  it('砦を入れないと未処理 rejection でプロセスが死ぬ', () => {
    const r = runChild(REJECT_LATER);
    expect(r.out).not.toContain('SURVIVED');
    expect(r.code).not.toBe(0);
  });

  it('砦を入れると未処理 rejection でも死なず、処理が続く', () => {
    const r = runChild(`installProcessSafetyNet();\n${REJECT_LATER}`);
    expect(r.out).toContain('SURVIVED');
    expect(r.code).toBe(0);
  });

  it('復旧不能（短時間に大量連続）と判断したら実際にプロセスを終了する（握り潰しではない）', () => {
    // 既定 limit=20 / windowMs=10s を超える件数を、窓を跨がないよう一気に投げる。
    const r = runChild(`installProcessSafetyNet();
setTimeout(() => {
  for (let i = 0; i < 40; i++) setTimeout(() => { throw new Error('storm-' + i); }, 0);
}, 10);
setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 1000);`);
    expect(r.out).not.toContain('SURVIVED');
    expect(r.out).toContain('復旧不能');
    expect(r.code).toBe(1);
  });
});
