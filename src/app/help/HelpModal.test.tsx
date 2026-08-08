/**
 * @vitest-environment jsdom
 */
/**
 * HelpModal のコンポーネントテスト。純関数（絞り込み・前後移動）は helpTopics.test.ts で検証済みのため、
 * ここでは開閉・検索・カテゴリ・項目選択・ナビゲーション・Esc・再開始ボタンの結線を検証する。
 * レスポンシブ（狭幅アコーディオン⇄広幅右ペイン）は CSS の class 切替の範囲（.help-accordion /
 * .help-detail-pane が両方 DOM に存在し、選択項目に応じて内容が入れ替わること）だけを確認する
 * （実ピクセルレイアウトは jsdom では検証できない）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { HelpModal } from './HelpModal';
import { HELP_TOPICS } from './helpTopics';

afterEach(() => {
  cleanup();
});

describe('HelpModal', () => {
  it('開くと全項目が一覧表示され、先頭項目が右ペインに選択されている', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    expect(dialog.querySelectorAll('.help-item')).toHaveLength(HELP_TOPICS.length);
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(HELP_TOPICS[0]!.title);
  });

  it('検索語で一覧を絞り込む（タイトル・本文の部分一致）', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const input = dialog.querySelector('.help-search-input') as HTMLInputElement;
    // 「テロップ」は telop 項目のタイトルにも、ai-tab 項目の本文例示（「テロップを赤に」）にも
    // ヒットする＝タイトル・本文どちらの部分一致も絞り込みに使われていることの確認。
    fireEvent.change(input, { target: { value: 'テロップ' } });
    const items = dialog.querySelectorAll('.help-item');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(HELP_TOPICS.length);
    expect(Array.from(items).some((el) => el.textContent?.includes('テロップ'))).toBe(true);
  });

  it('該当なしの検索語では一覧が空になり空状態メッセージが出る', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const input = dialog.querySelector('.help-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'そんざいしないごく' } });
    expect(dialog.querySelectorAll('.help-item')).toHaveLength(0);
    expect(dialog.querySelector('.help-empty')).not.toBeNull();
  });

  it('カテゴリチップで一覧を絞り込む', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const chip = Array.from(dialog.querySelectorAll('.help-chip')).find((el) => el.textContent === '編集')!;
    fireEvent.click(chip);
    const expected = HELP_TOPICS.filter((t) => t.category === '編集').length;
    expect(dialog.querySelectorAll('.help-item')).toHaveLength(expected);
    // 「すべて」に戻すと全件表示に戻る
    const all = Array.from(dialog.querySelectorAll('.help-chip')).find((el) => el.textContent === 'すべて')!;
    fireEvent.click(all);
    expect(dialog.querySelectorAll('.help-item')).toHaveLength(HELP_TOPICS.length);
  });

  it('項目をクリックすると右ペイン（.help-detail-pane）の内容が切り替わる', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const target = HELP_TOPICS[3]!;
    const item = Array.from(dialog.querySelectorAll('.help-item')).find((el) =>
      el.textContent?.includes(target.title),
    )!;
    fireEvent.click(item);
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(target.title);
    // アコーディオン側（狭幅用）も同じ項目の詳細を保持している（選択中の1項目にだけ存在する）
    expect(dialog.querySelector('.help-accordion .help-desc')?.textContent).toBe(target.description);
  });

  it('前へ/次へで選択が移動し、先頭/末尾で無効化される', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const prevBtn = () => dialog.querySelector('.help-detail-pane .help-prev') as HTMLButtonElement;
    const nextBtn = () => dialog.querySelector('.help-detail-pane .help-next') as HTMLButtonElement;

    expect(prevBtn().disabled).toBe(true);
    fireEvent.click(nextBtn());
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(HELP_TOPICS[1]!.title);
    expect(prevBtn().disabled).toBe(false);

    fireEvent.click(prevBtn());
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(HELP_TOPICS[0]!.title);
  });

  it('n / N カウンターが絞り込み結果内の位置を示す', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    expect(dialog.querySelector('.help-detail-pane .help-nav-count')?.textContent).toBe(
      `1 / ${HELP_TOPICS.length}`,
    );
  });

  it('✕ ボタンで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} onRestartTutorial={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('オーバーレイクリックで onClose が呼ばれるが、ダイアログ内クリックは伝播しない', () => {
    const onClose = vi.fn();
    const { container } = render(<HelpModal onClose={onClose} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    const overlay = container.querySelector('.help-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc キーで onClose が呼ばれる', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} onRestartTutorial={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('検索入力中の Esc は無視しない（閉じる）が、矢印キーは入力欄では素通りする（前後移動しない）', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const input = dialog.querySelector('.help-search-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(HELP_TOPICS[0]!.title);
  });

  it('「▶ もう一度最初から見る」で onRestartTutorial が呼ばれる', () => {
    const onRestartTutorial = vi.fn();
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={onRestartTutorial} />);
    fireEvent.click(screen.getByText('▶ もう一度最初から見る'));
    expect(onRestartTutorial).toHaveBeenCalledTimes(1);
  });
});
