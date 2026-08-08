/**
 * Toolbar 書き出しボタンの表示ロジック（describeRenderView / renderPhaseLabel）の
 * ユニットテスト。Toolbar.shape.test.ts と同じく DOM レンダリングを伴わない
 * 純関数の確認に徹する。
 */
import { describe, it, expect } from 'vitest';
import { describeRenderView, describeSaveButton, renderPhaseLabel, warnBadgeLabel } from './Toolbar';
import type { RenderState } from '../useRenderJob';

describe('warnBadgeLabel', () => {
  it('warnings があると件数付きのラベルを返す・0件なら null', () => {
    expect(warnBadgeLabel(['a', 'b'])).toBe('⚠ 2');
    expect(warnBadgeLabel([])).toBeNull();
  });

  it('古い部品の件数を合算する（通知の一本化）', () => {
    expect(warnBadgeLabel(['a'], 2)).toBe('⚠ 3');
    expect(warnBadgeLabel([], 1)).toBe('⚠ 1');
    expect(warnBadgeLabel([], 0)).toBeNull();
  });
});

describe('renderPhaseLabel', () => {
  it('percent が非 null なら「書き出し中 N%」（四捨五入）を返す', () => {
    expect(renderPhaseLabel('rendering', 45)).toBe('書き出し中 45%');
    expect(renderPhaseLabel('rendering', 45.6)).toBe('書き出し中 46%');
    // percent 優先: preparing でも percent があれば % 表示
    expect(renderPhaseLabel('preparing', 0)).toBe('書き出し中 0%');
  });

  it('100% 到達後は「仕上げ中…」を表示する', () => {
    expect(renderPhaseLabel('rendering', 100)).toBe('仕上げ中…');
    expect(renderPhaseLabel('rendering', 99.6)).toBe('仕上げ中…'); // 四捨五入で100
    expect(renderPhaseLabel('rendering', 99.4)).toBe('書き出し中 99%');
  });

  it('percent が null のとき phase 文言を返す', () => {
    expect(renderPhaseLabel('preparing', null)).toBe('準備中（初回は数分かかります）');
    expect(renderPhaseLabel('bundling', null)).toBe('バンドル中…');
    expect(renderPhaseLabel('rendering', null)).toBe('書き出し中…');
  });

  it('未知の phase かつ percent null は「書き出し中…」にフォールバック', () => {
    expect(renderPhaseLabel('something-else', null)).toBe('書き出し中…');
  });
});

describe('describeSaveButton', () => {
  it('dirty のとき活性化し「保存 (⌘S)」を表示する', () => {
    const view = describeSaveButton(true, true, false);
    expect(view.label).toBe('保存 (⌘S)');
    expect(view.disabled).toBe(false);
    expect(view.className).toContain('enabled');
    expect(view.className).toContain('dirty');
  });

  it('保存済み（dirty=false）のとき無効化し「保存済み ✓」を表示する', () => {
    const view = describeSaveButton(true, false, false);
    expect(view.label).toBe('保存済み ✓');
    expect(view.disabled).toBe(true);
    expect(view.className).not.toContain('enabled');
    expect(view.className).not.toContain('dirty');
  });

  it('保存中は無効化し「保存中…」を表示する（dirty でも活性化しない）', () => {
    const view = describeSaveButton(true, true, true);
    expect(view.label).toBe('保存中…');
    expect(view.disabled).toBe(true);
    expect(view.className).not.toContain('enabled');
    // dirty の見た目（ドット色）は維持する
    expect(view.className).toContain('dirty');
  });

  it('編集セッションが無い（読取専用）ときは無効化し「読取専用」を表示する', () => {
    const view = describeSaveButton(false, false, false);
    expect(view.label).toBe('読取専用');
    expect(view.disabled).toBe(true);
    expect(view.className).not.toContain('enabled');
  });
});

describe('describeRenderView', () => {
  it('idle', () => {
    const view = describeRenderView({ status: 'idle' });
    expect(view).toEqual({ kind: 'idle' });
  });

  it('running（percent あり）はバー表示ありでラベルに % を含む', () => {
    const state: RenderState = {
      status: 'running',
      phase: 'rendering',
      percent: 45,
      startedAt: 0,
    };
    const view = describeRenderView(state);
    expect(view).toEqual({
      kind: 'running',
      label: '書き出し中 45%',
      percent: 45,
      showBar: true,
    });
  });

  it('running（percent null）はバー非表示で phase 文言', () => {
    const state: RenderState = {
      status: 'running',
      phase: 'preparing',
      percent: null,
      startedAt: 0,
    };
    const view = describeRenderView(state);
    expect(view).toEqual({
      kind: 'running',
      label: '準備中（初回は数分かかります）',
      percent: null,
      showBar: false,
    });
  });

  it('done', () => {
    expect(describeRenderView({ status: 'done' })).toEqual({ kind: 'done' });
  });

  it('error はメッセージを含む', () => {
    const state: RenderState = {
      status: 'error',
      error: { code: 'boom', message: '書き出しに失敗しました' },
    };
    expect(describeRenderView(state)).toEqual({
      kind: 'error',
      message: '書き出しに失敗しました',
    });
  });
});
