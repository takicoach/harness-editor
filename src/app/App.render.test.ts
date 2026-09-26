/**
 * App.tsx の書き出し開始判定（shouldProceedToRender）のユニットテスト。
 * useEditSession.save() が Promise<boolean>（保存成否）を返す契約になったことを受け、
 * 「dirty かつ保存失敗」では render を開始しないことを固定する。
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { shouldProceedToRender, switchProjectWithSave, isConvertingSelected, installingKindFor, exportNoticeProps } from './App';
import { INITIAL_RENDER_STATE, type UseRenderJobReturn } from './useRenderJob';

describe('shouldProceedToRender', () => {
  it('dirty でなければ save 結果に関わらず開始する', () => {
    expect(shouldProceedToRender(false, true)).toBe(true);
    expect(shouldProceedToRender(false, false)).toBe(true);
  });

  it('dirty かつ保存成功なら開始する', () => {
    expect(shouldProceedToRender(true, true)).toBe(true);
  });

  it('dirty かつ保存失敗なら開始しない（stale saveError 対策の核心）', () => {
    expect(shouldProceedToRender(true, false)).toBe(false);
  });
});

describe('isConvertingSelected', () => {
  it('converting が選択中プロジェクトと一致すれば true', () => {
    expect(isConvertingSelected('proj-a', 'proj-a')).toBe(true);
  });

  it('converting が別プロジェクトなら false（切替時の誤スピナー防止）', () => {
    expect(isConvertingSelected('proj-a', 'proj-b')).toBe(false);
  });

  it('converting が null なら false', () => {
    expect(isConvertingSelected(null, 'proj-a')).toBe(false);
  });

  it('selectedId が null なら false', () => {
    expect(isConvertingSelected('proj-a', null)).toBe(false);
  });
});

describe('installingKindFor', () => {
  it('installing が選択中プロジェクト向けなら kind を返す', () => {
    expect(installingKindFor({ kind: 'bgm', projectId: 'proj-a' }, 'proj-a')).toBe('bgm');
  });

  it('installing が別プロジェクト向けなら null（切替時の誤スピナー防止）', () => {
    expect(installingKindFor({ kind: 'bgm', projectId: 'proj-a' }, 'proj-b')).toBeNull();
  });

  it('installing が null なら null', () => {
    expect(installingKindFor(null, 'proj-a')).toBeNull();
  });

  it('selectedId が null なら null', () => {
    expect(installingKindFor({ kind: 'bgm', projectId: 'proj-a' }, null)).toBeNull();
  });
});

/**
 * App が ExportNotices へ渡す render 由来 props の組み立て（M2d T2 修正2 I-2）。
 * render(<App>) は依存が重いため、props 組み立て部分を純関数へ切り出して pin する。
 * useRenderJob.fastCutFallbackMessage を通知側へそのまま透過することが本題
 * （表示層のテスト＝ExportNotices.render.test.tsx と対になる、App 側の配線テスト）。
 */
describe('exportNoticeProps', () => {
  function fakeRender(overrides: Partial<UseRenderJobReturn> = {}): UseRenderJobReturn {
    return {
      state: INITIAL_RENDER_STATE,
      start: async () => {},
      cancel: async () => null,
      reveal: async () => null,
      reset: () => {},
      heavyJobConfirm: { pendingConfirm: null, start: async () => 'cancelled', confirm: () => {}, dismiss: () => {} },
      fastCutFallbackNotice: false,
      fastCutFallbackMessage: null,
      ...overrides,
    };
  }

  it('renderState / fastCutFallbackNotice / fastCutFallbackMessage をそのまま透過する', () => {
    const render = fakeRender({
      state: { status: 'running', phase: 'rendering', percent: 50, startedAt: 0 },
      fastCutFallbackNotice: true,
      fastCutFallbackMessage: '環境変数 HARNESS_CHROMIUM のパスが見つかりません',
    });
    expect(exportNoticeProps(render)).toEqual({
      renderState: render.state,
      fastCutFallbackNotice: true,
      fastCutFallbackMessage: '環境変数 HARNESS_CHROMIUM のパスが見つかりません',
    });
  });

  it('fastCutFallbackMessage=null（理由なし）もそのまま透過する（?? で握り潰さない）', () => {
    const render = fakeRender({ fastCutFallbackNotice: true, fastCutFallbackMessage: null });
    expect(exportNoticeProps(render).fastCutFallbackMessage).toBeNull();
  });
});

describe('switchProjectWithSave（プロジェクト切替で未保存編集を捨てない）', () => {
  it('未保存なし: そのまま切り替える', async () => {
    const picked: string[] = [];
    const ok = await switchProjectWithSave('proj-b', { dirty: false, save: async () => false }, (id) => picked.push(id));
    expect(ok).toBe(true);
    expect(picked).toEqual(['proj-b']);
  });

  it('未保存あり: 先に保存し、成功したら切り替える', async () => {
    const picked: string[] = [];
    let saved = 0;
    const ok = await switchProjectWithSave(
      'proj-b',
      { dirty: true, save: async () => { saved++; return true; } },
      (id) => picked.push(id),
    );
    expect(saved).toBe(1);
    expect(ok).toBe(true);
    expect(picked).toEqual(['proj-b']);
  });

  it('未保存あり・保存失敗: 切り替えない（編集を黙って捨てない）', async () => {
    const picked: string[] = [];
    const ok = await switchProjectWithSave(
      'proj-b',
      { dirty: true, save: async () => false },
      (id) => picked.push(id),
    );
    expect(ok).toBe(false);
    expect(picked).toEqual([]);
  });

  it('セッション未確立（ホーム画面）でもそのまま切り替える', async () => {
    const picked: string[] = [];
    const ok = await switchProjectWithSave('proj-b', null, (id) => picked.push(id));
    expect(ok).toBe(true);
    expect(picked).toEqual(['proj-b']);
  });
});

/**
 * 配線を守る本体は `tests/project-switch-unsaved.spec.ts`（実機の往復:
 * 編集 → 別プロジェクトへ切替 → 戻ると編集が残っている）。
 * ここに残すのは**欠陥そのものの形**を弾く補助検査だけにする。
 * 「こう書いてある」ことを正規表現で固定すると、等価な書き換え（`void` の有無・変数名）で
 * 赤くなるうえ、別経路で selectProject を呼ぶ新コードは検出できない（＝挙動を守らない）。
 */
describe('App の配線: 左カラムのプロジェクト切替は保存ガードを通す（補助）', () => {
  it('LeftColumn の onPickProject に生の selectProject を渡していない', async () => {
    const src = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
    // 生の selectProject を渡すと、編集中に別プロジェクトを選んだ瞬間に
    // useEditSession がセッションを作り直し、未保存編集が黙って消える。
    expect(src).not.toMatch(/onPickProject=\{selectProject\}/);
  });
});

/**
 * 変換（handleConvert）の着地は実機テスト未整備のため、当面は文字列検査で守る。上と同じ弱さ（等価な書き換えで赤くなる／
 * 別経路は検出できない）を持つことを承知のうえで、無検査よりはましとして残す。
 */
describe('App の配線: 非同期処理の着地で未保存編集を捨てない（補助）', () => {
  it('再読込の入口は reloadProject に一本化され、pendingReload バナーも外部変更バナーと同じ 2 ボタンを持つ（マージレビュー P2-3/P2-4）', async () => {
    const src = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function App()'));
    // 生の reload を画面から直接呼ぶと、保留中の再読込案内（pendingReload）が再読込後に出てくる。
    expect(body).not.toMatch(/onReload=\{reload\}/);
    expect(body).not.toMatch(/onClick=\{reload\}/);
    expect(body).not.toMatch(/isCurrent\(id\)\) reload\(\)/);
    expect(body).toContain('const reloadProject = useCallback(() => {\n    setPendingReload(false);\n    reload();');
    const at = body.indexOf('title="更新の反映に再読込が必要です"');
    expect(at).toBeGreaterThan(0);
    const banner = body.slice(at, at + 400);
    expect(banner).toContain('onReload={reloadProject}');
    expect(banner).toContain('onSaveThenReload={() => void requestReload()}');
    expect(banner).toContain('onDiscardReload={discardAndReload}');
  });

  it('変換（handleConvert）の着地が reloadIfSafe を通る', async () => {
    const src = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async function handleConvert'), src.indexOf('async function handleConvert') + 1800);
    // 生の selectProject(id) で開き直すと、変換中に進んだ未保存編集が黙って消える。
    expect(body).not.toMatch(/isCurrent\(id\)\)\s*selectProject\(id\)/);
    expect(body).toMatch(/reloadIfSafe\(id, sessionRef\.current\?\.dirty \?\? false\)/);
  });
});
