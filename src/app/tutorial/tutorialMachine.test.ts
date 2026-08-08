import { describe, it, expect } from 'vitest';
import {
  firstApplicable,
  isApplicable,
  resolveTarget,
  resolveText,
  shouldAutoAdvance,
  takeSnapshot,
} from './tutorialMachine';
import { TUTORIAL_STEPS, type TutorialCtx } from './tutorialSteps';

function ctx(over: Partial<TutorialCtx> = {}): TutorialCtx {
  return {
    home: true,
    hasProjects: true,
    editorReady: false,
    telopCount: 0,
    dirty: false,
    domHas: () => false,
    ...over,
  };
}

function idx(id: string): number {
  const i = TUTORIAL_STEPS.findIndex((s) => s.id === id);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

describe('firstApplicable（when フィルタ）', () => {
  it('ホームでは welcome から順に進む', () => {
    expect(firstApplicable(TUTORIAL_STEPS, 0, ctx())).toBe(idx('welcome'));
  });

  it('プロジェクト0件のとき board（進行ボード）は飛ぶ', () => {
    const c = ctx({ hasProjects: false });
    const afterMcp = firstApplicable(TUTORIAL_STEPS, idx('mcp') + 1, c);
    expect(TUTORIAL_STEPS[afterMcp]?.id).toBe('create');
  });

  it('create をスキップしてホームのままだと、エディタ系を全部飛ばして finish に着地', () => {
    const c = ctx({ editorReady: false });
    const after = firstApplicable(TUTORIAL_STEPS, idx('create') + 1, c);
    expect(TUTORIAL_STEPS[after]?.id).toBe('finish');
  });

  it('エディタ表示中に再実行すると、ホーム系を飛ばして editor-left から', () => {
    const c = ctx({ home: false, editorReady: true });
    const after = firstApplicable(TUTORIAL_STEPS, idx('welcome') + 1, c);
    expect(TUTORIAL_STEPS[after]?.id).toBe('editor-left');
  });

  it('どのステップも表示できなければ steps.length（finish は常に適用可なので通常到達しない）', () => {
    const only = TUTORIAL_STEPS.filter((s) => s.when !== undefined);
    const c = ctx({ home: false, editorReady: false });
    expect(firstApplicable(only, 0, c)).toBe(only.length);
  });
});

describe('shouldAutoAdvance（実操作の完了検知）', () => {
  it('create: エディタが開いたら前進', () => {
    const step = TUTORIAL_STEPS[idx('create')]!;
    const snap = takeSnapshot(ctx());
    expect(shouldAutoAdvance(step, ctx({ editorReady: false }), snap)).toBe(false);
    expect(shouldAutoAdvance(step, ctx({ editorReady: true }), snap)).toBe(true);
  });

  it('telop-try: テロップ数が入場時より増えたら前進', () => {
    const step = TUTORIAL_STEPS[idx('telop-try')]!;
    const snap = takeSnapshot(ctx({ telopCount: 31 }));
    expect(shouldAutoAdvance(step, ctx({ telopCount: 31 }), snap)).toBe(false);
    expect(shouldAutoAdvance(step, ctx({ telopCount: 32 }), snap)).toBe(true);
  });

  it('save: dirty→保存済みへの遷移で前進（最初から保存済みなら自動前進しない）', () => {
    const step = TUTORIAL_STEPS[idx('save')]!;
    const dirtySnap = takeSnapshot(ctx({ dirty: true }));
    expect(shouldAutoAdvance(step, ctx({ dirty: true }), dirtySnap)).toBe(false);
    expect(shouldAutoAdvance(step, ctx({ dirty: false }), dirtySnap)).toBe(true);
    const cleanSnap = takeSnapshot(ctx({ dirty: false }));
    expect(shouldAutoAdvance(step, ctx({ dirty: false }), cleanSnap)).toBe(false);
  });

  it('advanceWhen の無いステップは自動前進しない', () => {
    const step = TUTORIAL_STEPS[idx('add-button')]!;
    expect(shouldAutoAdvance(step, ctx(), takeSnapshot(ctx()))).toBe(false);
  });
});

describe('resolveTarget / resolveText（動的解決）', () => {
  it('create の照準は作成ダイアログの有無で切り替わる', () => {
    const step = TUTORIAL_STEPS[idx('create')]!;
    expect(resolveTarget(step, ctx())).toBe('.home-create-btn');
    expect(resolveTarget(step, ctx({ domHas: (s) => s === '.home-create-dialog' }))).toBe(
      '.home-create-dialog',
    );
  });

  it('home-intro の照準と本文はプロジェクト有無で変わる', () => {
    const step = TUTORIAL_STEPS[idx('home-intro')]!;
    expect(resolveTarget(step, ctx({ hasProjects: true }))).toBe('.home-grid');
    expect(resolveTarget(step, ctx({ hasProjects: false }))).toBe('.home');
    expect(resolveText(step, ctx({ hasProjects: true }))).toContain('追加されましたね');
  });

  it('finish の本文はエディタ到達の有無で変わる', () => {
    const step = TUTORIAL_STEPS[idx('finish')]!;
    expect(resolveText(step, ctx({ editorReady: true }))).toContain('何でも聞いてみてね');
    expect(resolveText(step, ctx({ editorReady: false }))).toContain('チュートリアル図鑑');
  });

  it('welcome は常に適用可能（画面を問わず出せる）', () => {
    expect(isApplicable(TUTORIAL_STEPS[idx('welcome')]!, ctx({ home: false }))).toBe(true);
  });
});
