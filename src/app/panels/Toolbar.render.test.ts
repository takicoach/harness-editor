/**
 * @vitest-environment jsdom
 */
/**
 * Toolbar 書き出しボタンの表示ロジック（describeRenderView / renderPhaseLabel）の
 * ユニットテスト。Toolbar.shape.test.ts と同じく DOM レンダリングを伴わない
 * 純関数の確認に徹する。
 * 書き出し中の通知（fastCutFallbackNotice / warning）の表示テストは、通知の置き場を
 * ツールバー直下のバナー枠へ移した H-3 に合わせて ExportNotices.render.test.tsx へ移設した
 * （移設先で「2 件同時」「title の実在」を足してある）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  Toolbar,
  describeRenderView,
  describeSaveButton,
  renderErrorHint,
  renderPhaseLabel,
  warnBadgeLabel,
} from './Toolbar';
import type { RenderState } from '../useRenderJob';

afterEach(cleanup);

/** Toolbar を実 DOM で描くための最小 props（書き出し状態だけを差し替えて使う）。 */
const toolbarBaseProps = {
  projectName: 'p',
  canUndo: false,
  canRedo: false,
  dirty: false,
  saving: false,
  active: true,
  onUndo: () => {},
  onRedo: () => {},
  onSave: () => {},
  theme: 'dark' as const,
  onToggleTheme: () => {},
  layout: 'standard' as const,
  onLayoutChange: () => {},
  ducking: { enabled: false, strength: 'mid' as const },
  onDuckingChange: () => {},
  onRenderStart: () => {},
  onRenderCancel: () => {},
  onRenderReveal: () => {},
  onRenderDismiss: () => {},
  warnings: [],
};

describe('warnBadgeLabel（status-ia-4）', () => {
  it('警告だけなら「警告 N 件」・0件なら null', () => {
    expect(warnBadgeLabel(['a', 'b'])).toEqual({
      label: '⚠ 警告 2 件',
      aria: '検証の警告 2 件。押すと内容を表示',
    });
    expect(warnBadgeLabel([])).toBeNull();
    expect(warnBadgeLabel([], 0)).toBeNull();
  });

  it('部品の更新だけなら「更新 N 件」（警告と言わない）', () => {
    const view = warnBadgeLabel([], 1);
    expect(view?.label).toBe('⚠ 更新 1 件');
    expect(view?.aria).toContain('部品の更新 1 件');
    expect(view?.label).not.toContain('警告');
  });

  it('両方あるときは内訳を並べる（合算した記号にしない）', () => {
    expect(warnBadgeLabel(['a'], 2)).toEqual({
      label: '⚠ 警告 1・更新 2',
      aria: '検証の警告 1 件、部品の更新 2 件。押すと内容を表示',
    });
  });

  it('控えがあるだけなら警告色・⚠ を付けず中立の文言にする（戻せることは伝える）', () => {
    // 更新も警告も 0 件の案件に ⚠ が出たままになるのを避ける（Task 10 レビュー I3）。
    // 入口としてのバッジは残す（消すと「更新前に戻す」へ到達できない・B10-2）。
    const view = warnBadgeLabel([], 0, true)!;
    expect(view.label).toBe('更新前に戻せます');
    expect(view.label).not.toContain('⚠');
    expect(view.tone).toBe('info');
    // 復元に成功すると控えは畳まれ（revertable:false）、バッジ自体が消える。
    expect(warnBadgeLabel([], 0, false)).toBeNull();
    // 警告・更新がある側は従来どおり ⚠ のまま（tone は付けない）。
    expect(warnBadgeLabel([], 1, true)!.tone).toBeUndefined();
  });

  it('バッジは data-testid と aria-label を持ち、更新のみでも「警告」と表示しない', () => {
    const { getByTestId } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: { status: 'idle' } as RenderState,
        warnings: [],
        stalePacks: ['telop'],
        onPackUpgrade: async () => true,
      }),
    );
    const badge = getByTestId('toolbar-warn-badge');
    expect(badge.textContent).toBe('⚠ 更新 1 件');
    expect(badge.getAttribute('aria-label')).toContain('部品の更新 1 件');
    expect(badge.textContent).not.toContain('警告');
  });
});

describe('確認／仕上げの主操作', () => {
  it('現在モードを読み上げ可能に示し、仕上げと案件一覧の操作を通知する', () => {
    const onMode = vi.fn();
    const onHome = vi.fn();
    const { getByTestId, getByRole } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: { status: 'idle' } as RenderState,
        workspaceMode: 'review',
        onWorkspaceModeChange: onMode,
        onGoHome: onHome,
      }),
    );

    expect(getByTestId('workspace-mode-review').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(getByTestId('workspace-mode-finish'));
    expect(onMode).toHaveBeenCalledWith('finish');
    fireEvent.click(getByRole('button', { name: '案件一覧へ戻る' }));
    expect(onHome).toHaveBeenCalledOnce();
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

  it('capturing（テロップ等の撮影中）は専用文言（M2c）', () => {
    expect(renderPhaseLabel('capturing', null)).toBe('テロップなどを描画中…');
    // 撮影中は ffmpeg の進捗がまだ出ないが、直前ジョブの percent が残っていても phase を優先する。
    expect(renderPhaseLabel('capturing', 40)).toBe('テロップなどを描画中…');
  });

  it('capturing で capture 見積り判明後は「約N分・M枚」を添える（I-3）', () => {
    // 枚数は撮影 run 総数 capturedTotal（C-1）。distinctFrames（一意シグネチャ数）ではない。
    expect(renderPhaseLabel('capturing', null, { distinctFrames: 118, capturedTotal: 120, estimatedMs: 60_000 })).toBe(
      'テロップなどを描画中…（約1分・120枚）',
    );
    // 分は四捨五入。0分にはせず最低1分にする（「約0分」は誤解を招くため）。
    expect(renderPhaseLabel('capturing', null, { distinctFrames: 2, capturedTotal: 3, estimatedMs: 4_000 })).toBe(
      'テロップなどを描画中…（約1分・3枚）',
    );
    expect(renderPhaseLabel('capturing', null, { distinctFrames: 499, capturedTotal: 500, estimatedMs: 150_000 })).toBe(
      'テロップなどを描画中…（約3分・500枚）',
    );
  });

  it('capturing で capturedFrames が判明していれば「n/N枚・残り約M分」を出す（M2d T3・分母は capturedTotal）', () => {
    expect(
      renderPhaseLabel('capturing', null, {
        distinctFrames: 9,
        capturedTotal: 10,
        estimatedMs: 60_000,
        capturedFrames: 3,
      }),
    ).toBe('テロップなどを描画中…（3/10枚・残り約1分）');
    // distinctFrames に到達しても最終ではない（分母は capturedTotal）。
    expect(
      renderPhaseLabel('capturing', null, {
        distinctFrames: 9,
        capturedTotal: 10,
        estimatedMs: 68.23,
        capturedFrames: 9,
      }),
    ).toBe('テロップなどを描画中…（9/10枚・残り約1分）');
  });

  it('capturing で残り 0 枚（capturedFrames===capturedTotal）は「まもなく完了」（M-1）', () => {
    expect(
      renderPhaseLabel('capturing', null, {
        distinctFrames: 9,
        capturedTotal: 10,
        estimatedMs: 0,
        capturedFrames: 10,
      }),
    ).toBe('テロップなどを描画中…（10/10枚・まもなく完了）');
  });

  it('capturing で capturedFrames 未指定なら従来文言のまま（回帰ガード）', () => {
    expect(renderPhaseLabel('capturing', null, { distinctFrames: 118, capturedTotal: 120, estimatedMs: 60_000 })).toBe(
      'テロップなどを描画中…（約1分・120枚）',
    );
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

  it('running の warning は帯の view に載せない（描くのは ExportNotices・E-2）', () => {
    // H-3 で Toolbar が running の warning を描くのをやめた。view に載せたままだと
    // 「ここに出ている＝表示される」と誤読させるデッドフィールドになるため落とした。
    // 警告そのものが消えていないことは ExportNotices 側で固定している
    // （ExportNotices.render.test.tsx「退避通知だけ・警告だけ・両方、をこの順で並べる」）。
    const withWarning: RenderState = {
      status: 'running',
      phase: 'rendering',
      percent: 30,
      startedAt: 0,
      warning: '互換(Remotion)経路でやり直しています',
    };
    expect(describeRenderView(withWarning)).toEqual({
      kind: 'running',
      label: '書き出し中 30%',
      percent: 30,
      showBar: true,
    });
    expect(describeRenderView(withWarning)).not.toHaveProperty('warning');
  });

  it('done の warning は帯が実際に描くので view に載る', () => {
    expect(describeRenderView({ status: 'done', warning: '音声が無音でした' })).toEqual({
      kind: 'done',
      warning: '音声が無音でした',
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
      hint: null,
    });
  });
});


describe('書き出し失敗の表示と再試行（status-ia-2）', () => {
  it('renderErrorHint は既知の code を非エンジニア向けの文にする・未知は null', () => {
    expect(renderErrorHint('render-failed')).toContain('書き出しの途中で止まりました');
    expect(renderErrorHint('rename-failed')).toContain('空き容量');
    expect(renderErrorHint('network')).toContain('通信');
    expect(renderErrorHint('no-such-code')).toBeNull();
  });

  it('describeRenderView は error に hint を載せる', () => {
    const state: RenderState = { status: 'error', error: { code: 'render-failed', message: 'exit 1' } };
    expect(describeRenderView(state)).toEqual({
      kind: 'error',
      message: 'exit 1',
      hint: renderErrorHint('render-failed'),
    });
  });

  it('失敗時は理由がホバーせずに読め、「もう一度書き出す」で onRenderStart が呼ばれる', () => {
    const onRenderStart = vi.fn();
    const { getByTestId } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: { status: 'error', error: { code: 'render-failed', message: 'exit 1' } },
        onRenderStart,
      }),
    );
    // 本文（title 属性ではなく可視テキスト）に理由が出ている。
    expect(getByTestId('render-error').textContent).toContain('書き出しの途中で止まりました');
    fireEvent.click(getByTestId('render-retry'));
    expect(onRenderStart).toHaveBeenCalledTimes(1);
  });

  it('対処法つきの失敗は、その対処法がホバーせずに本文で読める（サイクル 3 Important）', () => {
    const { getByTestId } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: {
          status: 'error',
          error: {
            code: 'render-no-output',
            message:
              '書き出しプロセスは正常終了しましたが、出力ファイルが生成されませんでした。' +
              'プロジェクトの node_modules/.remotion を削除して再実行してください。',
          },
        },
      }),
    );
    const text = getByTestId('render-error').textContent ?? '';
    // 汎用文だけにせず、唯一の対処法（.remotion の削除）を可視テキストに出す。
    expect(text).toContain('動画ファイルができていませんでした');
    expect(text).toContain('.remotion');
  });

  it('未知の code では生のメッセージを本文に出す', () => {
    const { getByTestId } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: { status: 'error', error: { code: 'no-such-code', message: '謎の失敗' } },
      }),
    );
    expect(getByTestId('render-error').textContent).toContain('謎の失敗');
  });
});

describe('書き出し領域の live region とアイコンボタンの命名（status-ia-3 / -11）', () => {
  it('tb-render は role="status" の live region で、状態を data-state に出す', () => {
    const { getByTestId } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: { status: 'running', phase: 'rendering', percent: 50, startedAt: 0 },
      }),
    );
    const region = getByTestId('render-status');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('data-state')).toBe('running');
  });

  it('失敗は割り込みで伝える別ノード（assertive）に入る', () => {
    const { getByTestId } = render(
      createElement(Toolbar, {
        ...toolbarBaseProps,
        renderState: { status: 'error', error: { code: 'render-failed', message: 'x' } },
      }),
    );
    expect(getByTestId('render-status').getAttribute('data-state')).toBe('error');
    expect(getByTestId('render-error').getAttribute('aria-live')).toBe('assertive');
  });

  it('tb-icon-btn は例外なく aria-label を持つ（undo/redo の取りこぼし検出）', () => {
    const { container } = render(
      createElement(Toolbar, { ...toolbarBaseProps, renderState: { status: 'idle' } as RenderState }),
    );
    const icons = Array.from(container.querySelectorAll('button.tb-icon-btn'));
    expect(icons.length).toBeGreaterThan(0);
    const missing = icons.filter((b) => (b.getAttribute('aria-label') ?? '') === '');
    expect(missing.map((b) => b.getAttribute('title'))).toEqual([]);
  });
});
