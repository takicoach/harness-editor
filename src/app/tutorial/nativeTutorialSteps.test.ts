import { describe, expect, it } from 'vitest';
import { resolveTarget, resolveText, shouldAutoAdvance, takeSnapshot } from './tutorialMachine';
import type { TutorialCtx } from './tutorialSteps';
import { NATIVE_TUTORIAL_STEPS, tutorialTarget, type NativeTutorialStep } from './nativeTutorialSteps';

function ctx(over: Partial<TutorialCtx> = {}): TutorialCtx {
  return { home: false, hasProjects: true, editorReady: true, telopCount: 0, dirty: false, domHas: () => true, ...over };
}
function step(id: string): NativeTutorialStep {
  const found = NATIVE_TUTORIAL_STEPS.find((s) => s.id === id);
  if (!found) throw new Error(`手順 ${id} がありません`);
  return found;
}

describe('新画面の手順表（設計書の表どおり）', () => {
  it('16 手順がこの順に並ぶ', () => {
    expect(NATIVE_TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'welcome', 'home-intro', 'board', 'create', 'modes', 'materials', 'ai-panel', 'ai-work',
      'timeline', 'add-button', 'telop-try', 'telop-done', 'save', 'render', 'help', 'finish',
    ]);
  });

  it('場面: welcome と finish はどちらの画面でも、ホーム3つはホーム、残りは編集', () => {
    expect(Object.fromEntries(NATIVE_TUTORIAL_STEPS.map((s) => [s.id, s.scene]))).toEqual({
      welcome: 'any', 'home-intro': 'home', board: 'home', create: 'home', modes: 'edit', materials: 'edit',
      'ai-panel': 'edit', 'ai-work': 'edit', timeline: 'edit', 'add-button': 'edit', 'telop-try': 'edit',
      'telop-done': 'edit', save: 'edit', render: 'edit', help: 'edit', finish: 'any',
    });
  });

  it('照らす対象は data-tutorial の目印（表の列どおり）', () => {
    const expected: Record<string, string | null> = {
      welcome: null, board: 'home-view-switch', create: 'home-create', modes: 'modes', materials: 'materials',
      'ai-panel': 'ai-panel', 'ai-work': 'ai-work', timeline: 'timeline', 'add-button': 'add-telop',
      'telop-try': 'add-telop', 'telop-done': null, save: 'save', render: 'export', help: 'help', finish: null,
    };
    for (const [id, name] of Object.entries(expected)) {
      expect(resolveTarget(step(id), ctx()), id).toBe(name === null ? null : tutorialTarget(name));
    }
  });

  it('home-intro は作品一覧があればそれを、無ければホーム全体を照らす', () => {
    expect(resolveTarget(step('home-intro'), ctx({ hasProjects: true, domHas: () => true }))).toBe('[data-tutorial="home-grid"]');
    expect(resolveTarget(step('home-intro'), ctx({ hasProjects: true, domHas: () => false }))).toBe('[data-tutorial="home"]');
    expect(resolveTarget(step('home-intro'), ctx({ hasProjects: false }))).toBe('[data-tutorial="home"]');
  });

  it('前提の画面状態（編集モード・左パネルの素材・右パネル）', () => {
    expect(Object.fromEntries(NATIVE_TUTORIAL_STEPS.filter((s) => s.prep).map((s) => [s.id, s.prep]))).toEqual({
      modes: { mode: 'edit' },
      materials: { mode: 'edit', left: 'materials' },
      'ai-panel': { mode: 'edit', right: true },
      timeline: { mode: 'edit' },
      'add-button': { mode: 'edit' },
      'telop-try': { mode: 'edit' },
    });
  });

  it('welcome は「はじめる」「あとで」で、動画ファイルの用意を添える', () => {
    const welcome = step('welcome');
    expect(welcome.nextLabel).toBe('はじめる');
    expect(welcome.secondary).toEqual({ label: 'あとで', action: 'close' });
    expect(resolveText(welcome, ctx())).toContain('動画ファイルを1本');
  });

  it('create と telop-try は本人の操作待ち（「次へ」を出さない）', () => {
    expect(step('create').nextButton).toBe(false);
    expect(step('telop-try').nextButton).toBe(false);
    expect(step('telop-try').experience).toBe('telop');
  });

  it('telop-try は実際に追加されることと、あとで取り除けることを明記する', () => {
    expect(resolveText(step('telop-try'), ctx())).toContain('この動画に実際に追加されます。あとで取り除けます');
  });

  it('telop-done は本人の追加の記録があるときだけ出し、「残す」「取り除く」を選ばせる', () => {
    const done = step('telop-done');
    expect(done.requiresRecord).toBe(true);
    expect(done.body).toBe('party');
    expect(done.nextLabel).toBe('残す');
    expect(done.secondary).toEqual({ label: '取り除く', action: 'skip' });
  });

  it('board は作品があるときだけ', () => {
    expect(step('board').requiresProjects).toBe(true);
  });

  it('save は未保存→保存済みで自動前進し、最初から保存済みなら進まない', () => {
    const save = step('save');
    expect(shouldAutoAdvance(save, ctx({ dirty: false }), takeSnapshot(ctx({ dirty: true })))).toBe(true);
    expect(shouldAutoAdvance(save, ctx({ dirty: true }), takeSnapshot(ctx({ dirty: true })))).toBe(false);
    expect(shouldAutoAdvance(save, ctx({ dirty: false }), takeSnapshot(ctx({ dirty: false })))).toBe(false);
  });

  it('文面に旧画面の部品名（＋ 追加・タイムライン上部・チュートリアル図鑑の場所）を使わない', () => {
    for (const s of NATIVE_TUTORIAL_STEPS) {
      for (const c of [ctx({ dirty: true }), ctx({ dirty: false, editorReady: false, hasProjects: false })]) {
        const text = resolveText(s, c);
        expect(text, s.id).not.toContain('＋ 追加');
        expect(text, s.id).not.toContain('タイムライン上部');
        expect(text, s.id).not.toContain('⚙ 設定の「チュートリアル図鑑」');
      }
    }
  });

  it('finish は編集画面に着いたかで文面を変え、どちらも「？」を案内する', () => {
    const finish = step('finish');
    expect(finish.nextLabel).toBe('おわる');
    expect(finish.secondary).toBeNull();
    expect(resolveText(finish, ctx({ editorReady: true }))).toContain('「？」');
    expect(resolveText(finish, ctx({ editorReady: false }))).toContain('「もう一度最初から見る」');
  });
});
