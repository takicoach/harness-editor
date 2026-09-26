/**
 * @vitest-environment jsdom
 */
/**
 * QA C-2: プレビューが落ちたときに 12px の絵文字だけを残さず、
 * 文章＋「再読み込み」を出し、再読み込み（＝key を進める）で崩壊が解ける。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { PlayerErrorBoundary } from './PlayerErrorBoundary';

let shouldThrow = true;
function Boom(): React.ReactElement {
  if (shouldThrow) throw new Error('useCurrentFrame can only be called inside <Player>');
  return <div data-testid="player-ok">player</div>;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React はエラー境界に落ちた例外を console.error に出す。テスト出力を汚さない。
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  shouldThrow = true;
});
afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe('PlayerErrorBoundary（QA C-2）', () => {
  it('崩壊時は絵文字ではなく文章と「再読み込み」を出す', () => {
    const { getByTestId } = render(
      <PlayerErrorBoundary resetKey={0} onReload={() => {}}>
        <Boom />
      </PlayerErrorBoundary>,
    );
    const panel = getByTestId('preview-crash');
    expect(panel.textContent).toContain('プレビューを表示できませんでした');
    expect(panel.textContent).toContain('再読み込み');
    expect(panel.textContent).toContain('アプリを起動し直して');
    expect(getByTestId('preview-crash-reload')).not.toBeNull();
  });

  it('crashed → 再読み込み → key が進むと崩壊が解けて子を作り直す', () => {
    const onReload = vi.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <PlayerErrorBoundary resetKey={0} onReload={onReload}>
        <Boom />
      </PlayerErrorBoundary>,
    );
    expect(queryByTestId('preview-crash')).not.toBeNull();

    // 「再読み込み」は App へ通知するだけ（key を進めるのは App の責務）。
    fireEvent.click(getByTestId('preview-crash-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);

    // App が key を進めた（＝Player を再マウント）。原因が解消していれば復帰する。
    shouldThrow = false;
    rerender(
      <PlayerErrorBoundary resetKey={1} onReload={onReload}>
        <Boom />
      </PlayerErrorBoundary>,
    );
    expect(queryByTestId('preview-crash')).toBeNull();
    expect(queryByTestId('player-ok')).not.toBeNull();
  });

  it('key が進んでも原因が続いていれば再び案内を出す（黙って空にならない）', () => {
    const { queryByTestId, rerender } = render(
      <PlayerErrorBoundary resetKey={0} onReload={() => {}}>
        <Boom />
      </PlayerErrorBoundary>,
    );
    expect(queryByTestId('preview-crash')).not.toBeNull();
    rerender(
      <PlayerErrorBoundary resetKey={1} onReload={() => {}}>
        <Boom />
      </PlayerErrorBoundary>,
    );
    expect(queryByTestId('preview-crash')).not.toBeNull();
  });

  it('落ちていなければ子をそのまま描く', () => {
    shouldThrow = false;
    const { queryByTestId } = render(
      <PlayerErrorBoundary resetKey={0} onReload={() => {}}>
        <Boom />
      </PlayerErrorBoundary>,
    );
    expect(queryByTestId('preview-crash')).toBeNull();
    expect(queryByTestId('player-ok')).not.toBeNull();
  });
});
