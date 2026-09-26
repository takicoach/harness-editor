import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChangeNotifier } from './changeNotifier';

describe('createChangeNotifier（data-safety-6）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce 満了で 1 回だけ通知する', () => {
    const onChange = vi.fn();
    const n = createChangeNotifier({ debounceMs: 500, onChange, log: () => {} });
    n.trigger('a.ts');
    n.trigger('b.ts');
    vi.advanceTimersByTime(499);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('自己書込ウィンドウ中の外部変更は捨てられず、ウィンドウ明けに通知される', () => {
    const onChange = vi.fn();
    // 残り 1000ms の自己書込ウィンドウ。時間が進むほど残りが減る。
    // 内容は自分が保存したものと違う＝本物の外部変更（data-safety-6 の対象）。
    let elapsed = 0;
    const n = createChangeNotifier({
      debounceMs: 500,
      onChange,
      isSelfWrite: () => elapsed < 1000,
      selfWriteRemainingMs: () => Math.max(0, 1000 - elapsed),
      isSelfContent: () => false,
      log: () => {},
    });
    const advance = (ms: number): void => {
      elapsed += ms;
      vi.advanceTimersByTime(ms);
    };

    n.trigger('telopData.ts');
    advance(500); // debounce 満了。ウィンドウ内なので先送りされる。
    expect(onChange).not.toHaveBeenCalled();

    // 残り 500ms ＋ 余裕 100ms 後に再評価され、ウィンドウが明けているので通知される。
    advance(600);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('自分で保存しただけなら通知しない（内容がディスクと一致・サイクル 2 レビュー）', () => {
    // 1 タブだけで Cmd+S。chokidar の change は自分の書込の残響で、
    // ウィンドウが明けた時点のディスクは「自分が保存した内容」のまま。
    const onChange = vi.fn();
    let elapsed = 0;
    const n = createChangeNotifier({
      debounceMs: 500,
      onChange,
      isSelfWrite: () => elapsed < 1000,
      selfWriteRemainingMs: () => Math.max(0, 1000 - elapsed),
      isSelfContent: () => true,
      log: () => {},
    });
    const advance = (ms: number): void => {
      elapsed += ms;
      vi.advanceTimersByTime(ms);
    };
    n.trigger('telopData.ts');
    advance(500);
    advance(5000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('保存直後に外部が書き換えたら通知する（内容が記録と違う）', () => {
    const onChange = vi.fn();
    let elapsed = 0;
    // 300ms 時点で外部が書き換え、以後ディスクの内容は記録と食い違う。
    const n = createChangeNotifier({
      debounceMs: 500,
      onChange,
      isSelfWrite: () => elapsed < 1000,
      selfWriteRemainingMs: () => Math.max(0, 1000 - elapsed),
      isSelfContent: () => elapsed < 300,
      log: () => {},
    });
    const advance = (ms: number): void => {
      elapsed += ms;
      vi.advanceTimersByTime(ms);
    };
    n.trigger('telopData.ts');
    advance(500);
    expect(onChange).not.toHaveBeenCalled();
    advance(600);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ウィンドウ外でも内容が自分の保存と一致するイベントは通知しない（遅れて届いた残響）', () => {
    const onChange = vi.fn();
    const n = createChangeNotifier({
      debounceMs: 100,
      onChange,
      isSelfWrite: () => false,
      isSelfContent: () => true,
      log: () => {},
    });
    n.trigger('telopData.ts');
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('先送り中も 1 回しか通知しない（再評価で重複発火しない）', () => {
    const onChange = vi.fn();
    let elapsed = 0;
    const n = createChangeNotifier({
      debounceMs: 100,
      onChange,
      isSelfWrite: () => elapsed < 300,
      selfWriteRemainingMs: () => Math.max(0, 300 - elapsed),
      log: () => {},
    });
    const advance = (ms: number): void => {
      elapsed += ms;
      vi.advanceTimersByTime(ms);
    };
    n.trigger('cutData.ts');
    advance(2000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stop() 後は先送り中の再評価も発火しない', () => {
    const onChange = vi.fn();
    const n = createChangeNotifier({
      debounceMs: 100,
      onChange,
      isSelfWrite: () => true,
      selfWriteRemainingMs: () => 100,
      log: () => {},
    });
    n.trigger('x.ts');
    vi.advanceTimersByTime(100);
    n.stop();
    vi.advanceTimersByTime(10000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
