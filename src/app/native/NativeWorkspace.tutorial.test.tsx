/** @vitest-environment jsdom */
import { forwardRef, useImperativeHandle } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_TEXT_APPEARANCE } from '../../core/sequence/model';
import { rational } from '../../core/sequence/time';
import { NativeWorkspace } from './NativeWorkspace';

/**
 * 新画面のチュートリアルの結合（jsdom）。ここで確かめるのは「整えた後の画面状態」と「進み方」。
 * jsdom はレイアウトを持たないので、照らす枠が対象と重なるか・押せるかは tests/native-tutorial.spec.ts で確かめる。
 */
const session = vi.hoisted(() => ({
  doc: null as unknown,
  loading: false,
  error: null as string | null,
  dirty: false,
  externalChange: null as unknown,
  execute: undefined as unknown as ReturnType<typeof vi.fn>,
  save: undefined as unknown as ReturnType<typeof vi.fn>,
  reloadExternal: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('./NativePreview', () => ({ NativePreview: forwardRef(({ addBar }: any, ref) => {
  useImperativeHandle(ref, () => ({ pause: () => {}, flushManipulation: async () => true, cancelManipulation: () => {} }));
  return <div>{addBar}</div>;
}) }));
vi.mock('./NativeInspector', () => ({ NativeInspector: forwardRef((_props: any, ref) => {
  useImperativeHandle(ref, () => ({ blurDraft: () => {}, flush: async () => true }));
  return null;
}) }));
vi.mock('./NativeTimeline', () => ({ NativeTimeline: forwardRef((_props: any, ref) => {
  useImperativeHandle(ref, () => ({ flush: async () => true, restoreCut: async () => true, fitZoom: () => {} }));
  return null;
}) }));
vi.mock('./NativeScriptPanel', () => ({ NativeScriptPanel: forwardRef(() => null) }));
vi.mock('./NativeExportControl', () => ({ NativeExportControl: () => null }));
vi.mock('./NativeProjectList', () => ({ NativeProjectList: ({ onPick }: { onPick(id: string): void }) => <button onClick={() => onPick('other')}>別の作品を開く</button> }));
vi.mock('./NativeTranscribeControl', () => ({ NativeTranscribeControl: () => null }));
vi.mock('../useAutoSave', () => ({ useAutoSave: () => {} }));
vi.mock('../layout/useTheme', () => ({ useTheme: () => ({ theme: 'dark', toggle: () => {}, preference: 'dark', setPreference: () => {} }) }));
vi.mock('../useEditorAgentConnection', () => ({ useEditorAgentConnection: () => ({ connection: 'disconnected', clearError: () => {} }) }));
vi.mock('./useNativeEditorBridge', () => ({ useNativeEditorBridge: () => ({ bridge: {}, busy: false, resumeAutoSave: () => {}, pauseAutoSave: () => {}, release: () => {} }) }));
vi.mock('./useCutSourcePreview', () => ({ useCutSourcePreview: () => ({ active: null, owners: [], clipId: '', pending: false,
  choose: () => {}, open: async () => {}, stop: () => {}, seekProgram: () => {}, onFrame: () => {}, marker: undefined }) }));
vi.mock('./useNativeSession', () => ({ useNativeSession: () => ({
  state: session.doc ? { sessionId: 'test', dirty: session.dirty, canUndo: true, canRedo: false, document: session.doc, externalChange: session.externalChange } : null,
  loading: session.loading, error: session.error, busy: false, saveProgress: null,
  execute: session.execute, save: session.save, reloadExternal: session.reloadExternal,
  readCurrent: () => (session.doc ? { sessionId: 'test', dirty: session.dirty, document: session.doc } : null),
  retry: () => {}, migrate: async () => true, clearError: () => {}, accept: () => {}, prepareTextStyles: async () => true,
}) }));

const DOC = {
  schemaVersion: 2, id: 'tut-doc', revision: 1, name: 'tut', fps: { num: 30, den: 1 }, resolution: { width: 320, height: 180 },
  sequenceEndFrame: 90, background: '#000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [],
  ducking: { enabled: false, strength: 'mid' },
};
const AI_TRACK = { id: 'ai-track', kind: 'visual', enabled: true, name: 'AI' };
const AI_CLIP = {
  id: 'ai-clip', trackId: 'ai-track', name: 'AI', startFrame: 0, durationFrames: 30,
  clock: { offset: rational(0), rate: rational(1), duration: rational(30) },
  content: { kind: 'telop', data: { text: 'AI が足した字幕', animation: 'none', manual: true, position: { x: 0, y: -0.5 } }, appearance: { ...DEFAULT_TEXT_APPEARANCE } },
  anchor: { kind: 'timeline' },
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  session.doc = DOC;
  session.loading = false;
  session.error = null;
  session.dirty = false;
  session.externalChange = null;
  session.execute = vi.fn(async () => true);
  session.save = vi.fn(async () => true);
  session.reloadExternal = vi.fn(async () => false);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'unchanged', autoSaveDefaultEnabled: false, tutorialEnabled: false }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stepId = (): string | null => document.querySelector('.tut')?.getAttribute('data-step') ?? null;
async function startFromHelp(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '使い方（ヘルプ）' }));
  fireEvent.click(await screen.findByRole('button', { name: /もう一度最初から見る/ }));
  await waitFor(() => expect(stepId()).toBe('welcome'));
  expect(document.querySelector('[data-testid="help-dialog"]')).toBeNull();
}
/** 整えている間は .tut が消えるので、「次へ」が出るのを待ってから判定する（途中で飛ばさない）。 */
async function advanceTo(id: string): Promise<void> {
  for (let i = 0; i < 16; i++) {
    await waitFor(() => expect(document.querySelector('.tut .tut-next')).not.toBeNull());
    if (stepId() === id) return;
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tut .tut-next')!);
  }
  throw new Error(`手順 ${id} に届きませんでした（現在 ${stepId()}）`);
}
function addedBatch(): { commands: Array<{ type: string; track?: { id: string }; clips?: Array<{ id: string }> }> } {
  const found = session.execute.mock.calls.map((call) => call[0]).find((command) => command.type === 'batch');
  if (!found) throw new Error('追加の batch が実行されていません');
  return found;
}

it('「？」は通知・エラー履歴の右隣（設定の左）にあり、ヘルプの「もう一度最初から見る」で始まる', async () => {
  render(<NativeWorkspace projectId="tut" />);
  const help = screen.getByRole('button', { name: '使い方（ヘルプ）' });
  expect(help.previousElementSibling).toBe(screen.getByRole('button', { name: '通知・エラー履歴' }));
  expect(help.nextElementSibling).toBe(screen.getByRole('button', { name: '設定' }));
  await startFromHelp();
});

it('設定内の「使い方を見る」も残り、同じヘルプを開く', async () => {
  render(<NativeWorkspace projectId="tut" />);
  fireEvent.click(screen.getByRole('button', { name: '設定' }));
  fireEvent.click(screen.getByRole('button', { name: '使い方を見る' }));
  expect(await screen.findByRole('button', { name: /もう一度最初から見る/ })).toBeTruthy();
});

it('確認モード・左右パネルを畳んだ状態から始めても、手順に入ると整えてから照らす', async () => {
  sessionStorage.setItem('harness-native-view:tut', JSON.stringify({ mode: 'review', leftHidden: true, rightHidden: true }));
  const view = render(<NativeWorkspace projectId="tut" />);
  const workspace = view.container.querySelector('.native-workspace')!;
  expect(workspace.className).toContain('native-mode-review');
  expect(view.container.querySelector('[data-tutorial="add-telop"]')).toBeNull(); // 前提: 確認モードでは描画されない
  await startFromHelp();
  await advanceTo('modes');
  await waitFor(() => expect(workspace.className).toContain('native-mode-edit'));
  await advanceTo('materials');
  await waitFor(() => expect(workspace.className).not.toContain('native-hide-left'));
  const materials = view.container.querySelector<HTMLElement>('[data-tutorial="materials"]');
  expect(materials).not.toBeNull();
  expect(materials!.closest('[hidden]')).toBeNull();
  await advanceTo('ai-panel');
  await waitFor(() => expect(workspace.className).not.toContain('native-hide-right'));
  expect(view.container.querySelector('[data-tutorial="ai-panel"]')).not.toBeNull();
  await advanceTo('add-button');
  const add = view.container.querySelector<HTMLButtonElement>('[data-tutorial="add-telop"]');
  expect(add).not.toBeNull();
  expect(add!.disabled).toBe(false);
});

it('体験: AI の追加（文書の変化だけ）では進まず、Undo の後でも本人の「＋ テロップ」で進む', async () => {
  const view = render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  await advanceTo('telop-try');
  session.doc = { ...DOC, revision: 2, tracks: [AI_TRACK], clips: [AI_CLIP] };
  view.rerender(<NativeWorkspace projectId="tut" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
  expect(stepId()).toBe('telop-try');
  fireEvent.click(screen.getByRole('button', { name: '元に戻す' }));
  await waitFor(() => expect(session.execute).toHaveBeenCalledWith({ type: 'undo' }));
  fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-tutorial="add-telop"]')!);
  await waitFor(() => expect(stepId()).toBe('telop-done'));
  expect(addedBatch().commands.map((command) => command.type)).toEqual(['add-track', 'insert']);
});

it('「取り除く」は記録した1件と空になったトラックだけを消し、ほかの編集は残して保存の手順へ', async () => {
  const view = render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  await advanceTo('telop-try');
  fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-tutorial="add-telop"]')!);
  await waitFor(() => expect(stepId()).toBe('telop-done'));
  const batch = addedBatch();
  const track = batch.commands[0]!.track!;
  const clip = batch.commands[1]!.clips![0]!;
  session.doc = { ...DOC, revision: 3, tracks: [track, AI_TRACK], clips: [clip, AI_CLIP] };
  view.rerender(<NativeWorkspace projectId="tut" />);
  fireEvent.click(screen.getByRole('button', { name: '取り除く' }));
  await waitFor(() => expect(stepId()).toBe('save'));
  expect(session.execute).toHaveBeenLastCalledWith({
    type: 'batch', commands: [{ type: 'delete', clipIds: [clip.id] }, { type: 'remove-track', trackId: track.id }],
  });
});

it('設定などのダイアログ表示中は案内を隠し、閉じると同じ手順に戻す', async () => {
  render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  await advanceTo('modes');
  fireEvent.click(screen.getByRole('button', { name: '設定' }));
  await waitFor(() => expect(document.querySelector('.tut')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
  await waitFor(() => expect(stepId()).toBe('modes'));
});

it('文書の読み込み中は編集の手順を「読み込み中…」で保留し、読み込み後に同じ手順を見せる', async () => {
  session.doc = null;
  session.loading = true;
  const view = render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  fireEvent.click(document.querySelector<HTMLButtonElement>('.tut .tut-next')!); // はじめる
  await waitFor(() => expect(document.querySelector('.tut[data-step="modes"]')?.getAttribute('data-waiting')).toBe('true'));
  expect(document.querySelector('.tut')?.textContent).toContain('読み込み中…');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); });
  expect(stepId()).toBe('modes');
  session.doc = DOC;
  session.loading = false;
  view.rerender(<NativeWorkspace projectId="tut" />);
  await waitFor(() => expect(document.querySelector('.tut[data-step="modes"]:not([data-waiting])')).not.toBeNull());
});

it('読み込みに失敗したら既存のエラー表示を優先して案内を隠し、読み込めたら同じ手順から見せる', async () => {
  session.doc = null;
  session.error = '編集データを読み込めません';
  const view = render(<NativeWorkspace projectId="tut" />);
  fireEvent.click(screen.getByRole('button', { name: '使い方（ヘルプ）' }));
  fireEvent.click(await screen.findByRole('button', { name: /もう一度最初から見る/ }));
  await waitFor(() => expect(document.querySelector('[data-testid="help-dialog"]')).toBeNull());
  // welcome（場面 any）も、エラー表示の上には暗幕と吹き出しを出さない。
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(document.querySelector('.tut')).toBeNull();
  expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy();
  session.doc = DOC;
  session.error = null;
  view.rerender(<NativeWorkspace projectId="tut" />);
  await waitFor(() => expect(stepId()).toBe('welcome'));
  fireEvent.click(document.querySelector<HTMLButtonElement>('.tut .tut-next')!); // はじめる
  await waitFor(() => expect(stepId()).toBe('modes'));
});

it('「次へ」の後は吹き出しにフォーカスを残さず、背景の ⌘S がそのまま保存になる', async () => {
  render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  await advanceTo('ai-panel');
  // ai-panel → ai-work は整える処理が無く、吹き出しのボタン要素がそのまま残る（フォーカスが残りうる）経路。
  const next = document.querySelector<HTMLButtonElement>('.tut .tut-next')!;
  next.focus();
  expect(document.activeElement).toBe(next);
  fireEvent.click(next);
  await waitFor(() => expect(stepId()).toBe('ai-work'));
  expect(document.activeElement?.closest('.tut-bubble') ?? null).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 's', metaKey: true });
  await waitFor(() => expect(session.save).toHaveBeenCalled());
});

it('案内の表示中に別の作品へ切り替えると、保存してから今の編集画面の手順を残す（遷移先で同じ手順から続ける）', async () => {
  let resumeAtSaveTime: string | null = 'unset';
  session.save = vi.fn(async () => {
    resumeAtSaveTime = sessionStorage.getItem('harness-native-tutorial-resume'); // 保存が先。まだ再開情報は無いはず
    return true;
  });
  render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  await advanceTo('timeline');
  fireEvent.click(screen.getByRole('tab', { name: 'プロジェクト' }));
  fireEvent.click(await screen.findByRole('button', { name: '別の作品を開く' }));
  await waitFor(() => expect(JSON.parse(sessionStorage.getItem('harness-native-tutorial-resume') ?? 'null'))
    .toEqual({ projectId: 'other', stepId: 'timeline' }));
  expect(session.save).toHaveBeenCalled();
  expect(resumeAtSaveTime).toBeNull();
});

it('案内の表示中に外部変更を再読み込みすると、同じ作品の同じ手順を残す', async () => {
  session.externalChange = { summary: '字幕が変わりました' };
  session.reloadExternal = vi.fn(async () => true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<NativeWorkspace projectId="tut" />);
  await startFromHelp();
  await advanceTo('ai-work');
  fireEvent.click(screen.getByRole('button', { name: '保存内容を再読み込み' }));
  await waitFor(() => expect(session.reloadExternal).toHaveBeenCalled());
  await waitFor(() => expect(JSON.parse(sessionStorage.getItem('harness-native-tutorial-resume') ?? 'null'))
    .toEqual({ projectId: 'tut', stepId: 'ai-work' }));
});
