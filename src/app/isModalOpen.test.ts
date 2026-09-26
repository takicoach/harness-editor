/**
 * @vitest-environment jsdom
 *
 * チュートリアル表示中にショートカットが死ぬ回帰（サイクル 2 レビュー Important）の固定。
 *
 * チュートリアルの暗幕（.tut）は pointer-events:none の指さしオーバーレイで、
 * 「実操作ステップでは照準のボタンをそのまま押せる」設計（TutorialOverlay.tsx）。
 * ここを isModalOpen() が「前面モーダル」と判定していたため、save ステップが
 * 案内している ⌘S も ⌘Z も無反応になっていた。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isAgentEditBlocked, isModalOpen, MODAL_SELECTOR } from './isModalOpen';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isModalOpen', () => {
  it('チュートリアルの暗幕（.tut）はモーダルではない', () => {
    document.body.innerHTML = '<div class="tut" data-step="save"><div class="tut-hole"></div></div>';
    expect(isModalOpen()).toBe(false);
  });

  it('MODAL_SELECTOR に .tut を含めない（App / Timeline 双方の判定が同じ定義を使う）', () => {
    expect(MODAL_SELECTOR).not.toContain('.tut');
  });

  it('前面を塞ぐダイアログはモーダルとして扱う', () => {
    for (const cls of ['help-overlay', 'export-overlay', 'hjc-overlay', 'diff-review-overlay', 'preference-overlay', 'native-style-overlay']) {
      document.body.innerHTML = `<div class="${cls}"></div>`;
      expect(isModalOpen()).toBe(true);
    }
  });

  it('他のダイアログの後ろで待機中（hidden）の学習パネルはモーダルに数えない（AIの作業の閲覧中に AI の編集を止めない）', () => {
    document.body.innerHTML = '<div class="diff-review-overlay" hidden inert></div>'
      + '<div class="preference-overlay" data-editor-activity="viewing"></div>';
    expect(isAgentEditBlocked()).toBe(false);
    document.body.innerHTML = '<div class="diff-review-overlay" hidden inert></div>';
    expect(isModalOpen()).toBe(false);
  });

  it('何も出ていなければ false', () => {
    expect(isModalOpen()).toBe(false);
  });
});
