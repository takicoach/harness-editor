/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_CREATE_BAND_TEXT, NATIVE_UNAVAILABLE_TEXT, NATIVE_WAITING_TEXT, type NativeStepPrep } from './nativeTutorialSteps';
import { NATIVE_TUTORIAL_DONE_KEY, NATIVE_TUTORIAL_RESUME_KEY } from './nativeTutorialStorage';
import { useNativeTutorial, type NativeTutorialApi, type NativeTutorialInputs } from './useNativeTutorial';

const RESUME = NATIVE_TUTORIAL_RESUME_KEY;
const record = { documentId: 'd1', clipId: 'c1', trackId: 't1' };

function inputs(over: Partial<NativeTutorialInputs> = {}): NativeTutorialInputs {
  return { scene: 'home', projectId: null, documentId: null, hasProjects: true, ready: true, loadFailed: false, dirty: false, ...over };
}
function edit(over: Partial<NativeTutorialInputs> = {}): NativeTutorialInputs {
  return inputs({ scene: 'edit', projectId: 'p1', documentId: 'd1', ...over });
}
function stubConfig(tutorialEnabled: boolean): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tutorialEnabled }) })));
}
async function flush(ms = 0): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function mount(initial: NativeTutorialInputs) {
  return renderHook((props: NativeTutorialInputs) => useNativeTutorial(props), { initialProps: initial });
}
function advanceTo(result: { current: NativeTutorialApi }, id: string): void {
  for (let i = 0; i < 20 && result.current.step?.id !== id; i++) act(() => result.current.next());
  expect(result.current.step?.id).toBe(id);
}
async function atTelopTry(over: Partial<NativeTutorialInputs> = {}) {
  stubConfig(false);
  const hook = mount(edit(over));
  await flush();
  act(() => hook.result.current.start());
  advanceTo(hook.result, 'telop-try');
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('自動で出す相手（初回自動）', () => {
  it('ホーム: 設定が有効で未完了なら welcome から出る', async () => {
    stubConfig(true);
    const { result } = mount(inputs());
    await flush();
    expect(result.current.active).toBe(true);
    expect(result.current.step?.id).toBe('welcome');
  });
  it('旧キーだけなら出る。新キーで完了済みなら出ない', async () => {
    stubConfig(true);
    localStorage.setItem('sme-tutorial-done', 'x');
    const first = mount(inputs());
    await flush();
    expect(first.result.current.active).toBe(true);
    first.unmount();
    localStorage.setItem(NATIVE_TUTORIAL_DONE_KEY, 'x');
    const second = mount(inputs());
    await flush();
    expect(second.result.current.active).toBe(false);
  });
  it('設定の取得前は出さない', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result } = mount(inputs());
    await flush(2000);
    expect(result.current.active).toBe(false);
  });
  it('設定が無効（SME_TUTORIAL=0）なら出ない', async () => {
    stubConfig(false);
    const { result } = mount(inputs());
    await flush();
    expect(result.current.active).toBe(false);
  });
  it('localStorage が拒否されると自動で出さない（拒否が本当に起きたことも確かめる）', async () => {
    stubConfig(true);
    expect(Object.getPrototypeOf(localStorage)).toBe(Storage.prototype);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = mount(inputs());
    await flush();
    expect(spy).toHaveBeenCalledWith(NATIVE_TUTORIAL_DONE_KEY);
    expect(result.current.active).toBe(false);
  });
  it('編集画面を直接開いても出て、ホームの手順は飛ばす', async () => {
    stubConfig(true);
    const { result } = mount(edit());
    await flush();
    expect(result.current.step?.id).toBe('welcome');
    act(() => result.current.next());
    expect(result.current.step?.id).toBe('modes');
  });
});

describe('ページをまたぐ再開（自動復元）', () => {
  it('同じ作品なら保存した手順から再開し、操作可能になるまで「読み込み中…」で待つ（飛ばさない）', async () => {
    stubConfig(true);
    sessionStorage.setItem(RESUME, JSON.stringify({ projectId: 'p1', stepId: 'modes' }));
    const { result, rerender } = mount(edit({ documentId: null, ready: false }));
    await flush();
    expect(result.current.step?.id).toBe('modes');
    expect(result.current.view).toEqual({ kind: 'waiting', text: NATIVE_WAITING_TEXT });
    expect(result.current.overlayOptions).toEqual({ waiting: NATIVE_WAITING_TEXT });
    expect(sessionStorage.getItem(RESUME)).toBeNull();
    await flush(3000);
    expect(result.current.step?.id).toBe('modes');
    rerender(edit());
    await flush(400);
    expect(result.current.step?.id).toBe('modes');
    expect(result.current.view).toEqual({ kind: 'step' });
  });
  it('設定が無効なら復元情報があっても始めず、消す', async () => {
    stubConfig(false);
    sessionStorage.setItem(RESUME, JSON.stringify({ projectId: 'p1', stepId: 'modes' }));
    const { result } = mount(edit());
    await flush();
    expect(result.current.active).toBe(false);
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it('別の作品では再開せず保存を消す', async () => {
    stubConfig(true);
    localStorage.setItem(NATIVE_TUTORIAL_DONE_KEY, 'x'); // 初回自動と区別するため完了済みにしておく
    sessionStorage.setItem(RESUME, JSON.stringify({ projectId: 'other', stepId: 'modes' }));
    const { result } = mount(edit());
    await flush();
    expect(result.current.active).toBe(false);
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it.each([
    ['壊れた JSON', '{'],
    ['未知の手順', JSON.stringify({ projectId: 'p1', stepId: 'no-such-step' })],
    ['記録が要る手順', JSON.stringify({ projectId: 'p1', stepId: 'telop-done' })],
    ['ホームの手順', JSON.stringify({ projectId: 'p1', stepId: 'create' })],
  ])('%s では再開せず保存を消す', async (_label, raw) => {
    stubConfig(true);
    localStorage.setItem(NATIVE_TUTORIAL_DONE_KEY, 'x');
    sessionStorage.setItem(RESUME, raw);
    const { result } = mount(edit());
    await flush();
    expect(result.current.active).toBe(false);
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it('ホームでは再開情報を使わずに消す（戻る操作で古い情報を残さない）', async () => {
    stubConfig(true);
    localStorage.setItem(NATIVE_TUTORIAL_DONE_KEY, 'x');
    sessionStorage.setItem(RESUME, JSON.stringify({ projectId: 'p1', stepId: 'modes' }));
    const { result } = mount(inputs());
    await flush();
    expect(result.current.active).toBe(false);
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
});

describe('作成手順', () => {
  async function atCreate() {
    stubConfig(false);
    const hook = mount(inputs({ hasProjects: false }));
    await flush();
    act(() => hook.result.current.start());
    advanceTo(hook.result, 'create');
    return hook;
  }
  it('作成に成功したら、遷移の直前に {projectId, stepId:"modes"} を保存する', async () => {
    const { result } = await atCreate();
    act(() => result.current.beforeNavigate('new-project'));
    expect(JSON.parse(sessionStorage.getItem(RESUME) ?? 'null')).toEqual({ projectId: 'new-project', stepId: 'modes' });
  });
  it('完了の手順（finish。先に編集画面の手順が無い）や停止中の遷移では保存しない', async () => {
    const { result } = await atCreate();
    act(() => result.current.skip()); // create を飛ばす → finish
    act(() => result.current.beforeNavigate('p9'));
    expect(sessionStorage.getItem(RESUME)).toBeNull();
    act(() => result.current.close());
    act(() => result.current.beforeNavigate('p9'));
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it('finish 表示中の遷移は再開情報を保存せず、完了だけ記録する（遷移先で「ようこそ」から出直さない）', async () => {
    const { result } = await atCreate();
    act(() => result.current.skip()); // create を飛ばす → finish
    expect(result.current.step?.id).toBe('finish');
    expect(localStorage.getItem(NATIVE_TUTORIAL_DONE_KEY)).toBeNull();
    act(() => result.current.beforeNavigate('p9'));
    expect(sessionStorage.getItem(RESUME)).toBeNull();
    expect(localStorage.getItem(NATIVE_TUTORIAL_DONE_KEY)).not.toBeNull();
  });
  it('作成が終わらない（失敗した）間は作成手順に留まる', async () => {
    const { result } = await atCreate();
    await flush(3000);
    expect(result.current.step?.id).toBe('create');
  });
  it('作成を飛ばすとホームのまま完了手順へ', async () => {
    const { result } = await atCreate();
    act(() => result.current.skip());
    expect(result.current.step?.id).toBe('finish');
  });
  it('sessionStorage が拒否されても遷移を止めない（拒否が本当に起きたことも確かめる）', async () => {
    const { result } = await atCreate();
    const proto = Object.getPrototypeOf(sessionStorage) as Storage;
    expect(proto === Storage.prototype).toBe(false); // toBe で比べると jsdom の prototype を表示しようとして Illegal invocation になる
    const spy = vi.spyOn(proto, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => act(() => result.current.beforeNavigate('new-project'))).not.toThrow();
    expect(spy).toHaveBeenCalledWith(RESUME, expect.any(String));
  });
});

describe('ページ遷移の直前（案内の表示中なら今の手順を残す）', () => {
  const saved = (): unknown => JSON.parse(sessionStorage.getItem(RESUME) ?? 'null');
  it('ホームの手順で作品カードを押すと、最初の編集画面の手順を残す', async () => {
    stubConfig(false);
    const { result } = mount(inputs());
    await flush();
    act(() => result.current.start());
    advanceTo(result, 'board');
    act(() => result.current.beforeNavigate('p2'));
    expect(saved()).toEqual({ projectId: 'p2', stepId: 'modes' });
  });
  it('案内を出していなければ何も残さない', async () => {
    stubConfig(false);
    const { result } = mount(inputs());
    await flush();
    act(() => result.current.beforeNavigate('p2'));
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it('編集画面の手順から別の作品へ切り替えると同じ手順を残し、再読み込み（同じ作品）ではそこから再開する', async () => {
    stubConfig(false);
    const first = mount(edit());
    await flush();
    act(() => first.result.current.start());
    advanceTo(first.result, 'timeline');
    act(() => first.result.current.beforeNavigate('p2'));
    expect(saved()).toEqual({ projectId: 'p2', stepId: 'timeline' });
    act(() => first.result.current.beforeNavigate('p1')); // 再読み込み
    expect(saved()).toEqual({ projectId: 'p1', stepId: 'timeline' });
    first.unmount();
    stubConfig(true);
    localStorage.setItem(NATIVE_TUTORIAL_DONE_KEY, 'x'); // 手動の再実行中（初回自動と区別する）
    const second = mount(edit());
    await flush();
    expect(second.result.current.step?.id).toBe('timeline');
  });
  it('記録が要る telop-done では、その次の編集画面の手順（保存）を残す', async () => {
    const { result } = await atTelopTry();
    act(() => result.current.recordTelopAdded(record));
    expect(result.current.step?.id).toBe('telop-done');
    act(() => result.current.beforeNavigate('p2'));
    expect(saved()).toEqual({ projectId: 'p2', stepId: 'save' });
  });
  it('welcome（場面 any）では最初の編集画面の手順を残す', async () => {
    stubConfig(false);
    const { result } = mount(inputs());
    await flush();
    act(() => result.current.start());
    expect(result.current.step?.id).toBe('welcome');
    act(() => result.current.beforeNavigate('p2'));
    expect(saved()).toEqual({ projectId: 'p2', stepId: 'modes' });
  });
});

describe('体験（本人の追加）と「取り除く」', () => {
  it('体験の手順で、同じ文書への本人の追加成功を受けたら telop-done へ', async () => {
    const { result } = await atTelopTry();
    act(() => result.current.recordTelopAdded(record));
    expect(result.current.step?.id).toBe('telop-done');
  });
  it('体験の手順以外の追加・別の文書の追加では進まない', async () => {
    stubConfig(false);
    const { result } = mount(edit());
    await flush();
    act(() => result.current.start());
    advanceTo(result, 'add-button');
    act(() => result.current.recordTelopAdded(record));
    expect(result.current.step?.id).toBe('add-button');
    act(() => result.current.next());
    act(() => result.current.recordTelopAdded({ ...record, documentId: 'other-doc' }));
    expect(result.current.step?.id).toBe('telop-try');
  });
  it('記録なしで telop-try を飛ばすと telop-done も出さない', async () => {
    const { result } = await atTelopTry();
    act(() => result.current.skip());
    expect(result.current.step?.id).toBe('save');
  });
  it('「取り除く」は記録した1件を渡し、成功したら保存の手順へ', async () => {
    const removeTelop = vi.fn(async () => true);
    const { result } = await atTelopTry({ removeTelop });
    act(() => result.current.recordTelopAdded(record));
    act(() => result.current.skip());
    await flush();
    expect(removeTelop).toHaveBeenCalledWith(record);
    expect(result.current.step?.id).toBe('save');
  });
  it('取り除けなかったら telop-done に留まる', async () => {
    const removeTelop = vi.fn(async () => false);
    const { result } = await atTelopTry({ removeTelop });
    act(() => result.current.recordTelopAdded(record));
    act(() => result.current.skip());
    await flush();
    expect(removeTelop).toHaveBeenCalledOnce();
    expect(result.current.step?.id).toBe('telop-done');
  });
  it('「取り除く」の処理中は二重に押しても1回しか消さず、終わると押し直せる', async () => {
    let settle: (ok: boolean) => void = () => {};
    const removeTelop = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const { result } = await atTelopTry({ removeTelop });
    act(() => result.current.recordTelopAdded(record));
    act(() => result.current.skip());
    act(() => result.current.skip());
    expect(removeTelop).toHaveBeenCalledOnce();
    await act(async () => { settle(false); await Promise.resolve(); });
    await flush();
    expect(result.current.step?.id).toBe('telop-done');
    act(() => result.current.skip());
    expect(removeTelop).toHaveBeenCalledTimes(2);
  });
  it('「取り除く」の処理中でも、telop-done 以外の手順に移っていれば skip は効く', async () => {
    let settle: (ok: boolean) => void = () => {};
    const removeTelop = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const { result } = await atTelopTry({ removeTelop });
    act(() => result.current.recordTelopAdded(record));
    act(() => result.current.skip()); // 取り除く開始（保留のまま removingRef が残る）
    expect(removeTelop).toHaveBeenCalledOnce();
    act(() => result.current.close());
    act(() => result.current.start());
    advanceTo(result, 'modes');
    act(() => result.current.skip()); // telop-done ではないので、除去が保留中でも進める
    expect(result.current.step?.id).toBe('materials');
    settle(true); // 後始末（未処理の Promise を残さない）
  });
  it('「取り除く」の処理中に「残す」（next）を押しても無視する（消えたまま save へ進めない）', async () => {
    let settle: (ok: boolean) => void = () => {};
    const removeTelop = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const { result } = await atTelopTry({ removeTelop });
    act(() => result.current.recordTelopAdded(record));
    act(() => result.current.skip()); // 取り除く開始
    act(() => result.current.next()); // 処理中は無視される
    expect(result.current.step?.id).toBe('telop-done');
    await act(async () => { settle(true); await Promise.resolve(); });
    await flush();
    expect(result.current.step?.id).toBe('save');
  });
  it('「残す」は何も消さずに保存の手順へ', async () => {
    const removeTelop = vi.fn(async () => true);
    const { result } = await atTelopTry({ removeTelop });
    act(() => result.current.recordTelopAdded(record));
    act(() => result.current.next());
    expect(removeTelop).not.toHaveBeenCalled();
    expect(result.current.step?.id).toBe('save');
  });
});

describe('保存の自動前進（現行と同じ判定）', () => {
  it('入ったとき未保存で、保存済みになったら書き出しへ', async () => {
    const hook = await atTelopTry({ dirty: true });
    act(() => hook.result.current.recordTelopAdded(record));
    act(() => hook.result.current.next());
    expect(hook.result.current.step?.id).toBe('save');
    // 基準値は入った後の最初の tick（350ms 以内）で取る。その時点で未保存であることを先に通す。
    await flush(400);
    expect(hook.result.current.step?.id).toBe('save');
    hook.rerender(edit({ dirty: false }));
    await flush(400);
    expect(hook.result.current.step?.id).toBe('render');
  });
  it('「取り除く」の完了が削除後の描画より先に届いても、基準値は保存の手順に入った後の描画から取る（自動保存 ON）', async () => {
    // 追加は自動保存で保存済み（dirty:false）。取り除くと未保存になるが、その描画は remove の then より後に来る。
    const removeTelop = vi.fn(async () => true);
    const hook = await atTelopTry({ removeTelop, dirty: false });
    act(() => hook.result.current.recordTelopAdded(record));
    act(() => hook.result.current.skip());
    await flush(); // remove の then で保存の手順へ（この時点の描画はまだ保存済み）
    expect(removeTelop).toHaveBeenCalledOnce();
    expect(hook.result.current.step?.id).toBe('save');
    hook.rerender(edit({ removeTelop, dirty: true })); // 削除で未保存になった描画
    await flush(400);
    expect(hook.result.current.step?.id).toBe('save');
    hook.rerender(edit({ removeTelop, dirty: false })); // 自動保存で保存済み
    await flush(400);
    expect(hook.result.current.step?.id).toBe('render');
  });
  it('入ったときから保存済みなら自動では進まない', async () => {
    const hook = await atTelopTry({ dirty: false });
    act(() => hook.result.current.recordTelopAdded(record));
    act(() => hook.result.current.next());
    await flush(1000);
    expect(hook.result.current.step?.id).toBe('save');
  });
});

describe('他の画面との重なり', () => {
  it('ダイアログ表示中は隠れ、閉じると戻る', async () => {
    stubConfig(false);
    const { result } = mount(edit());
    await flush();
    act(() => result.current.start());
    act(() => result.current.next());
    const overlay = document.createElement('div');
    overlay.className = 'help-overlay';
    document.body.append(overlay);
    await flush(400);
    expect(result.current.view).toEqual({ kind: 'hidden' });
    expect(result.current.overlayOptions).toEqual({ hidden: true });
    overlay.remove();
    await flush(400);
    expect(result.current.view).toEqual({ kind: 'step' });
    expect(result.current.overlayOptions.unavailableText).toBe(NATIVE_UNAVAILABLE_TEXT);
    expect(typeof result.current.overlayOptions.locate).toBe('function');
  });
  it('作成手順は作成ダイアログの表示中だけ案内帯、フォルダ選択など他のダイアログは隠す', async () => {
    stubConfig(false);
    const { result } = mount(inputs({ hasProjects: false }));
    await flush();
    act(() => result.current.start());
    advanceTo(result, 'create');
    // renderHook の描画先を消さないよう、innerHTML ではなく要素を足し引きする。
    const createOverlay = document.createElement('div');
    createOverlay.className = 'export-overlay';
    createOverlay.innerHTML = '<div class="export-dialog home-create-dialog"></div>';
    document.body.append(createOverlay);
    await flush(400);
    expect(result.current.view).toEqual({ kind: 'band', text: NATIVE_CREATE_BAND_TEXT });
    expect(result.current.overlayOptions).toEqual({ band: NATIVE_CREATE_BAND_TEXT });
    createOverlay.remove();
    const pickerOverlay = document.createElement('div');
    pickerOverlay.className = 'export-overlay';
    pickerOverlay.innerHTML = '<div class="export-dialog"></div>';
    document.body.append(pickerOverlay);
    await flush(400);
    expect(result.current.view).toEqual({ kind: 'hidden' });
    pickerOverlay.remove();
  });
  it('読み込みに失敗したら案内を隠す（手順は飛ばさない）', async () => {
    stubConfig(false);
    const { result } = mount(edit({ ready: false, loadFailed: true, documentId: null }));
    await flush();
    act(() => result.current.start());
    act(() => result.current.next());
    expect(result.current.step?.id).toBe('modes');
    expect(result.current.view).toEqual({ kind: 'hidden' });
  });
});

describe('前提の画面状態を整える', () => {
  it('編集画面で手順に入ると prep を渡して整え、整え終わるまで隠す', async () => {
    stubConfig(false);
    let finish: () => void = () => {};
    const prepare = vi.fn((_prep: NativeStepPrep) => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = mount(edit({ prepare }));
    await flush();
    act(() => result.current.start());
    act(() => result.current.next());
    expect(result.current.step?.id).toBe('modes');
    expect(prepare).toHaveBeenCalledWith({ mode: 'edit' });
    expect(result.current.view).toEqual({ kind: 'hidden' });
    await act(async () => { finish(); await Promise.resolve(); });
    await flush();
    expect(result.current.view).toEqual({ kind: 'step' });
  });
  it('文書の準備前は整えず、準備が済んでから整える', async () => {
    stubConfig(false);
    const prepare = vi.fn(async (_prep: NativeStepPrep) => {});
    const { result, rerender } = mount(edit({ prepare, ready: false, documentId: null }));
    await flush();
    act(() => result.current.start());
    act(() => result.current.next());
    expect(prepare).not.toHaveBeenCalled();
    rerender(edit({ prepare }));
    await flush();
    expect(prepare).toHaveBeenCalledWith({ mode: 'edit' });
  });
  it('prep の無い手順（ai-work）では整えない', async () => {
    stubConfig(false);
    const prepare = vi.fn(async (_prep: NativeStepPrep) => {});
    const { result } = mount(edit({ prepare }));
    await flush();
    act(() => result.current.start());
    advanceTo(result, 'ai-panel');
    await flush();
    prepare.mockClear();
    act(() => result.current.next());
    await flush();
    expect(result.current.step?.id).toBe('ai-work');
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('手動再実行・あとで・フォーカス', () => {
  it('設定が無効でも start() で welcome から始まり、残っていた再開情報は消す', async () => {
    stubConfig(false);
    const { result } = mount(inputs());
    await flush();
    sessionStorage.setItem(RESUME, JSON.stringify({ projectId: 'p1', stepId: 'modes' }));
    act(() => result.current.start());
    expect(result.current.step?.id).toBe('welcome');
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it('「あとで」（close）で新キーに完了を記録し、旧キーは触らず、再開情報を消す', async () => {
    stubConfig(false);
    const { result } = mount(inputs());
    await flush();
    act(() => result.current.start());
    sessionStorage.setItem(RESUME, JSON.stringify({ projectId: 'p1', stepId: 'modes' }));
    act(() => result.current.close());
    expect(result.current.active).toBe(false);
    expect(localStorage.getItem(NATIVE_TUTORIAL_DONE_KEY)).not.toBeNull();
    expect(localStorage.getItem('sme-tutorial-done')).toBeNull();
    expect(sessionStorage.getItem(RESUME)).toBeNull();
  });
  it('finish の「おわる」でも完了を記録する', async () => {
    stubConfig(false);
    const { result } = mount(inputs({ hasProjects: false }));
    await flush();
    act(() => result.current.start());
    advanceTo(result, 'create');
    act(() => result.current.skip());
    act(() => result.current.next());
    expect(result.current.active).toBe(false);
    expect(localStorage.getItem(NATIVE_TUTORIAL_DONE_KEY)).not.toBeNull();
  });
  it('「次へ」の後は吹き出しのボタンからフォーカスを外す（背景の ⌘S を効かせる）', async () => {
    stubConfig(false);
    const { result } = mount(edit());
    await flush();
    act(() => result.current.start());
    const bubble = document.createElement('div');
    bubble.className = 'tut-bubble';
    const button = document.createElement('button');
    bubble.append(button);
    document.body.append(bubble);
    button.focus();
    expect(document.activeElement).toBe(button);
    act(() => result.current.next());
    expect(document.activeElement).toBe(document.body);
  });
});
