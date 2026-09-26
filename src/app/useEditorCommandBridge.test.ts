/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { EditorProject } from '../core/types';
import type { SaveMeta } from './useEditorProject';
import { useEditSession } from './useEditSession';
import { useEditorCommandBridge } from './useEditorCommandBridge';
import { setTelopText } from './edit/textOps';
import { AgentActivityDialog } from './panels/AgentActivityDialog';
import { isModalOpen } from './isModalOpen';

function project(): EditorProject {
  return { videoConfig: { format: 'short', fps: 30, durationFrames: 900, videoFile: 'main.mp4', resolution: { width: 1080, height: 1920 },
    orientation: 'portrait', titleStyle: { top: 60, left: 30, fontSize: 30 } }, projectConfig: null,
    transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [{ id: 1, originalStart: 30, originalEnd: 150, text: '素振りする' }],
    cutRegions: [{ start: 200, end: 230 }], se: [], images: [], bgm: [], titles: [],
    telopDataSource: 'export const telopData = [];\n', cutDataSource: null, seDataSource: null,
    insertImageDataSource: null, titleDataSource: null, mainSpeed: 1, segmentSpeeds: {} };
}
function meta(): SaveMeta {
  return { telopDataRelPath: 'src/telopData.ts', cutDataRelPath: 'src/cutData.ts', fingerprint: {
    telopData: { relPath: 'src/telopData.ts', size: 10, mtimeMs: 1 }, cutData: null, seData: null,
    insertImageData: null, videoInsertData: null, bgmData: null, titleData: null, shapeData: null,
    transitionData: null, mainLayoutData: null, speedData: null,
  } };
}
function setup() {
  const saveMeta = meta();
  return renderHook(({ id, source }: { id: string; source: EditorProject }) => {
    const session = useEditSession(id, source, saveMeta);
    return { session: session!, bridge: useEditorCommandBridge(session, id) };
  }, { initialProps: { id: 'video-a', source: project() } });
}
function request(revision: string) {
  return { schemaVersion: 1, projectId: 'video-a', operationId: 'op-a', baseRevision: revision,
    changes: [{ type: 'set_telop_text', elementId: '1', before: '素振りする', after: '素振りをする', sourceFrameRange: { start: 30, end: 150 } }] };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('型付き編集を既存のUI履歴と保存へ接続', () => {
  it('AI履歴を開いたまま反映・保存でき、背後のキー操作と別の編集ダイアログは保護する', async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/editor/operations')
      ? { operations: [], total: 0, nextOffset: null } : { ok: true, fingerprint: meta().fingerprint } }));
    vi.stubGlobal('fetch', fetch);
    const { result } = setup();
    render(createElement(AgentActivityDialog, { projectId: 'video-a', credentials: { sessionId: 'session', sessionKey: 'key' },
      connection: 'connected', connectionError: null, onClose: () => {} }));
    await screen.findByText('この動画には、まだAIの編集記録がありません。');
    expect(isModalOpen()).toBe(true);
    expect(result.current.bridge.read()?.humanBusy).toBe(false);
    const modal = document.createElement('div'); modal.className = 'diff-review-overlay'; document.body.appendChild(modal);
    expect(result.current.bridge.read()?.humanBusy).toBe(true);
    expect(() => result.current.bridge.apply(request(result.current.bridge.revision))).toThrow(/HUMAN_BUSY/);
    modal.remove();
    const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    await act(async () => { expect((await result.current.bridge.save(input)).saved).toBe(true); });
    expect(result.current.session.state.telops[0]?.text).toBe('素振りをする');
    expect(result.current.session.dirty).toBe(false);
    expect(screen.getByTestId('agent-activity-dialog')).toBeTruthy();
    expect(isModalOpen()).toBe(true);
  });
  it('一度適用・一度保存し、Undo後の同じ配信で再適用しない', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, fingerprint: meta().fingerprint }) });
    vi.stubGlobal('fetch', fetch);
    const { result } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    expect(result.current.session.state.telops[0]?.text).toBe('素振りをする');
    expect(result.current.session.dirty).toBe(true);
    await act(async () => {
      expect((await result.current.bridge.save(input, { runId: 'run-a', token: 'token-a' })).saved).toBe(true);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.project.telops[0].text).toBe('素振りをする');
    expect(body.project.cutRegions).toEqual([{ start: 200, end: 230 }]);
    expect(body.overwrite).toBeUndefined();
    expect(fetch.mock.calls[0]![1].headers['X-Harness-Editor-Run']).toBe('run-a');
    expect(fetch.mock.calls[0]![1].headers['X-Harness-Editor-Token']).toBe('token-a');
    act(() => { result.current.session.undo(); });
    expect(result.current.session.state.telops[0]?.text).toBe('素振りする');
    act(() => { result.current.bridge.apply(input); });
    await act(async () => { await result.current.bridge.save(input); });
    expect(result.current.session.state.telops[0]?.text).toBe('素振りする');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('人の未保存変更とダイアログを上書きしない', () => {
    const { result } = setup(); const input = request(result.current.bridge.revision);
    const modal = document.createElement('div'); modal.className = 'preference-overlay'; document.body.appendChild(modal);
    expect(() => result.current.bridge.apply(input)).toThrow(/HUMAN_BUSY/);
    modal.remove();
    act(() => { result.current.session.apply((state) => setTelopText(state, 1, '人が直している字幕')); });
    expect(() => result.current.bridge.apply(input)).toThrow(/UNSAVED_CHANGES/);
    expect(result.current.session.state.telops[0]?.text).toBe('人が直している字幕');
  });
  it('適用後に人がUndoした場合、古い配信から保存しない', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { result } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    act(() => { result.current.session.undo(); });
    expect(await result.current.bridge.save(input)).toMatchObject({ phase: 'failed', applied: true, saved: false, code: 'EDIT_CHANGED_BEFORE_SAVE' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('案件を切り替えた後の古い保存で新しい案件を書き換えない', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    rerender({ id: 'video-b', source: project() });
    expect(await result.current.bridge.save(input)).toMatchObject({ phase: 'failed', code: 'EDIT_CHANGED_BEFORE_SAVE' });
    expect(result.current.bridge.read()?.projectId).toBe('video-b');
    expect(result.current.session.state.telops[0]?.text).toBe('素振りする');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('保存の再送をまとめ、保存衝突後に上書き再試行しない', async () => {
    let finish!: (response: unknown) => void;
    const fetch = vi.fn(() => new Promise((resolve) => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const { result } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    let first!: ReturnType<typeof result.current.bridge.save>; let second!: typeof first;
    act(() => { first = result.current.bridge.save(input); second = result.current.bridge.save(input); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ok: false, status: 409, json: async () => ({ error: '別の画面が保存しました' }) });
      expect(await first).toMatchObject({ phase: 'failed', applied: true, saved: false });
      expect(await second).toEqual(await first);
    });
    expect(result.current.session.saveConflict).toBe(true);
    await result.current.bridge.save(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.session.dirty).toBe(true);
  });
  it.each([
    ['通信切断', () => Promise.reject(new TypeError('Failed to fetch after server committed'))],
    ['5xx', () => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'upstream unavailable' }) })],
    ['不正な2xx本文', () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })],
  ])('厳密保存の%sは結果不明を保ち、同じ操作を再送しない', async (_case, response) => {
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    const { result } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });

    await act(async () => {
      await expect(result.current.bridge.save(input)).rejects.toThrow(/SAVE_RESULT_UNKNOWN/);
    });
    await expect(result.current.bridge.save(input)).rejects.toThrow(/SAVE_RESULT_UNKNOWN/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.session.dirty).toBe(true);
  });
  it('案件切替中に厳密保存の応答が失われても結果不明を消さない', async () => {
    let rejectFetch!: (reason: unknown) => void;
    const fetch = vi.fn(() => new Promise((_resolve, reject) => { rejectFetch = reject; }));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    let saving!: ReturnType<typeof result.current.bridge.save>;
    act(() => { saving = result.current.bridge.save(input); });
    rerender({ id: 'video-b', source: project() });

    await act(async () => {
      rejectFetch(new TypeError('response lost'));
      await expect(saving).rejects.toThrow(/SAVE_RESULT_UNKNOWN/);
    });
    await expect(result.current.bridge.save(input)).rejects.toThrow(/SAVE_RESULT_UNKNOWN/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.bridge.read()?.projectId).toBe('video-b');
  });
  it('agent保存中の人編集を同じ配信から追い保存しない', async () => {
    const finishes: Array<(response: unknown) => void> = [];
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise((resolve) => finishes.push(resolve))); vi.stubGlobal('fetch', fetch);
    const { result } = setup(); const input = request(result.current.bridge.revision);
    act(() => { result.current.bridge.apply(input); });
    let saving!: ReturnType<typeof result.current.bridge.save>;
    act(() => { saving = result.current.bridge.save(input); });
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => { result.current.session.apply((state) => setTelopText(state, 1, '人の入力途中')); });
    await act(async () => {
      finishes[0]!({ ok: true, json: async () => ({ ok: true, fingerprint: meta().fingerprint }) });
      await Promise.race([saving, new Promise((resolve) => setTimeout(resolve, 50))]);
    });
    const submitted = fetch.mock.calls.map((call) => {
      const body = call[1]?.body;
      if (typeof body !== 'string') throw new Error('expected JSON request body');
      return JSON.parse(body).project.telops[0].text;
    });
    if (finishes[1]) {
      finishes[1]({ ok: true, json: async () => ({ ok: true, fingerprint: meta().fingerprint }) });
      await saving;
    }
    expect(submitted).toEqual(['素振りをする']);
    expect(await saving).toMatchObject({ phase: 'saved', code: 'SAVED_WITH_LATER_UI_CHANGES' });
    expect(result.current.session.state.telops[0]?.text).toBe('人の入力途中');
    expect(result.current.session.dirty).toBe(true);
  });
});
