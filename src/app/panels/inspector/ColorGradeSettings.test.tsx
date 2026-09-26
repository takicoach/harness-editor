/**
 * @vitest-environment jsdom
 *
 * F-2: カラー補正の設定面。非エンジニアが触る面なので
 * 「スライダー 1 本で 4 項目」「1 ボタンで無補正へ戻る」を固定する。
 *
 * とくに重要なのが**注意書きの出方**。旧版の部品を持つ案件では補正が書き出しに出ないので、
 * そのとき黙って何も言わないと「プレビューだけ変わる」事故になる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MainVideoSettingsTab } from './MainVideoSettingsTab';
import { initialEditState, type EditState } from '../../edit/editState';
import { COLOR_GRADE_UNSUPPORTED } from '../../../shared/colorGradeSupport';

afterEach(cleanup);

function setup(over: Partial<EditState> = {}, colorGradeSupported = true) {
  const state: EditState = { ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }), ...over };
  const onEdit = vi.fn();
  render(
    <MainVideoSettingsTab
      state={state}
      onEdit={onEdit}
      installing={null}
      installErrors={{}}
      dirty={false}
      onInstall={vi.fn()}
      colorGradeSupported={colorGradeSupported}
    />,
  );
  return onEdit;
}

describe('カラー補正の設定面', () => {
  it('4 項目のスライダーと数値ボックスが出る', () => {
    setup();
    for (const key of ['brightness', 'contrast', 'saturation', 'temperature']) {
      expect(document.querySelector(`#ins-color-${key}`), key).not.toBeNull();
      expect(document.querySelector(`#ins-color-${key}-num`), `${key}-num`).not.toBeNull();
    }
  });

  it('スライダーを動かすと補正値が変わった state が返る', () => {
    const onEdit = setup();
    fireEvent.change(document.querySelector('#ins-color-brightness')!, { target: { value: '35' } });
    const next = onEdit.mock.calls[0]![0] as EditState;
    expect(next.colorGrade?.brightness).toBe(35);
    // 他の項目は動かない（1 本のスライダーが 1 項目だけを触る）。
    expect(next.colorGrade?.contrast).toBe(0);
  });

  it('「補正なしに戻す」で全項目 0 に戻る', () => {
    const onEdit = setup({ colorGrade: { brightness: 20, contrast: 10, saturation: -5, temperature: 30 } });
    fireEvent.click(screen.getByRole('button', { name: '補正なしに戻す' }));
    const next = onEdit.mock.calls[0]![0] as EditState;
    expect(next.colorGrade).toEqual({ brightness: 0, contrast: 0, saturation: 0, temperature: 0 });
  });

  it('対応済みの案件では注意書きを出さない', () => {
    setup({ colorGrade: { brightness: 20, contrast: 0, saturation: 0, temperature: 0 } }, true);
    expect(screen.queryByText(COLOR_GRADE_UNSUPPORTED)).toBeNull();
  });

  it('未対応の案件で補正を掛けていたら注意書きを出す（黙って食い違わせない）', () => {
    setup({ colorGrade: { brightness: 20, contrast: 0, saturation: 0, temperature: 0 } }, false);
    expect(screen.queryByText(COLOR_GRADE_UNSUPPORTED)).not.toBeNull();
  });

  it('未対応なら、まだ何も動かしていなくても注意書きを出す（操作前に分かる）', () => {
    // 旧: 非既定値を入れて初めて出していた＝「動かしてから反映されないと知る」順序だった。
    setup({}, false);
    expect(screen.queryByText(COLOR_GRADE_UNSUPPORTED)).not.toBeNull();
  });

  it('見出しは適用範囲（メイン動画・サブ動画）を名乗る', () => {
    setup({}, true);
    expect(screen.queryByText('カラー補正（メイン動画・サブ動画）')).not.toBeNull();
  });
});
