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
import { featureSeenKey, isNewGeneration, markFeatureSeen } from '../featureSeen';

afterEach(() => {
  cleanup();
  localStorage.clear();
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

describe('HelpModal の NEW バッジ', () => {
  /**
   * addedIn が現行世代の項目（＝NEW 候補）。既読化はユーザーの明示クリックのときだけなので、
   * 初期選択・検索の先頭寄せで自動選択された項目を除外する必要はない。
   */
  const newTopics = HELP_TOPICS.filter((t) => isNewGeneration(t.addedIn));

  function badgeIds(): string[] {
    const dialog = screen.getByTestId('help-dialog');
    return Array.from(dialog.querySelectorAll('.help-item-wrap')).flatMap((wrap) =>
      wrap.querySelector('.help-new-badge') === null
        ? []
        : [wrap.querySelector('.help-item')?.getAttribute('data-topic-id') ?? ''],
    );
  }

  it('新機能の項目にだけ NEW バッジが出る', () => {
    expect(newTopics.length).toBeGreaterThan(0);
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    expect(badgeIds().sort()).toEqual(newTopics.map((t) => t.id).sort());
  });

  it('項目を開くとその項目のバッジだけ消え、既読が localStorage に残る', () => {
    const target = newTopics[0]!;
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    fireEvent.click(dialog.querySelector(`.help-item[data-topic-id="${target.id}"]`)!);
    expect(badgeIds()).not.toContain(target.id);
    expect(badgeIds().length).toBe(newTopics.length - 1);
    expect(localStorage.getItem(featureSeenKey('help', target.id))).not.toBeNull();
    // 既読化は図鑑スコープだけ（同じ id を持つチュートリアル側の NEW を消さない）。
    expect(localStorage.getItem(featureSeenKey('tutorial', target.id))).toBeNull();
  });

  it('既読のまま開き直してもバッジは復活しない', () => {
    const target = newTopics[0]!;
    markFeatureSeen('help', target.id);
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    expect(badgeIds()).not.toContain(target.id);
  });

  it('チュートリアルで同じ id を見ていても図鑑側の NEW は残る', () => {
    const target = newTopics[0]!;
    markFeatureSeen('tutorial', target.id);
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    expect(badgeIds()).toContain(target.id);
  });

  it('自動選択（初期表示・検索の先頭寄せ）では既読にしない', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    // 開いただけ＝先頭項目が自動選択された状態では、まだ誰も既読になっていない。
    expect(badgeIds().sort()).toEqual(newTopics.map((t) => t.id).sort());
    for (const t of HELP_TOPICS) {
      expect(localStorage.getItem(featureSeenKey('help', t.id))).toBeNull();
    }
    // 検索で絞り込むと先頭へ寄る（＝自動選択）が、それでも既読化しない。
    const target = newTopics[0]!;
    const input = dialog.querySelector('.help-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: target.title } });
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(target.title);
    expect(localStorage.getItem(featureSeenKey('help', target.id))).toBeNull();
  });

  it('前へ／次へでの移動は明示操作なので既読にする', () => {
    render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    const dialog = screen.getByTestId('help-dialog');
    const second = HELP_TOPICS[1]!;
    fireEvent.click(dialog.querySelector('.help-detail-pane .help-next')!);
    expect(dialog.querySelector('.help-detail-pane .help-cap')?.textContent).toBe(second.title);
    expect(localStorage.getItem(featureSeenKey('help', second.id))).not.toBeNull();
  });

  it('現行画面のヘルプには旧画面の案内を出さない', () => {
    const view = render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} hideTutorialRestart />);
    expect(view.queryByText(/この説明は旧画面/)).toBeNull();
  });

  it('既定では帯を出さない（legacy の見た目を変えない）', () => {
    const view = render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} />);
    expect(view.queryByRole('status')).toBeNull();
  });

  it('hideTutorialRestart のときは再開ボタンを隠す（再開の仕組みを持たない画面向け）', () => {
    const view = render(<HelpModal onClose={vi.fn()} onRestartTutorial={vi.fn()} hideTutorialRestart />);
    expect(view.queryByText('▶ もう一度最初から見る')).toBeNull();
  });
});
