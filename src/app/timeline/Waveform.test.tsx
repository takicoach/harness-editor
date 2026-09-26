/**
 * @vitest-environment jsdom
 *
 * R-7 回帰固定: Waveform は波形色を getComputedStyle 経由でテーマ別トークン
 * （--wave-rms / --wave-peak）から読み、data-theme 切替時に読み直して再描画する。
 *
 * jsdom は canvas 2D コンテキストを実装しないため、getContext を最小スタブへ
 * 差し替えて fillStyle の遷移を記録する（構造ではなく実際に使われた色を検証する）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { act } from 'react';
import { Waveform } from './Waveform';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.cssText = '';
  vi.restoreAllMocks();
});

/** fillStyle が設定されるたびに記録するフェイク 2D コンテキスト。 */
function stubCanvasContext() {
  const fillStyleLog: string[] = [];
  const fakeCtx = {
    clearRect: () => {},
    fillRect: () => {},
    get fillStyle() {
      return fillStyleLog[fillStyleLog.length - 1] ?? '';
    },
    set fillStyle(v: string) {
      fillStyleLog.push(v);
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => fakeCtx as unknown as CanvasRenderingContext2D,
  );
  return fillStyleLog;
}

const samples = new Float32Array([0.1, 0.5, -0.3, 0.8, -0.6, 0.2]);

describe('Waveform テーマ別配色（R-7）', () => {
  it('--wave-rms / --wave-peak を getComputedStyle から読んで描画する', () => {
    document.documentElement.style.setProperty('--wave-rms', 'rgb(10, 20, 30)');
    document.documentElement.style.setProperty('--wave-peak', 'rgb(40, 50, 60)');
    const log = stubCanvasContext();

    render(<Waveform samples={samples} width={40} height={20} />);

    expect(log).toContain('rgb(10, 20, 30)');
    expect(log).toContain('rgb(40, 50, 60)');
  });

  it('data-theme 切替後は新しいトークン値で再描画する（トークンが実際に切り替わる）', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.setProperty('--wave-rms', 'rgb(124, 148, 180)');
    const log = stubCanvasContext();

    render(<Waveform samples={samples} width={40} height={20} />);
    expect(log).toContain('rgb(124, 148, 180)');

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.style.setProperty('--wave-rms', 'rgb(78, 106, 142)');
      // MutationObserver のコールバックはマイクロタスクで発火する（useSyncExternalStore の
      // 購読が拾うのはその後）。act 内でマイクロタスクを明示的に消化して再描画を待つ。
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(log).toContain('rgb(78, 106, 142)');
  });
});
