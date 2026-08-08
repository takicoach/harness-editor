/**
 * @vitest-environment jsdom
 */
/**
 * useEditSession の保存経路（save()）のユニットテスト。
 * D-2 自動保存導入に伴う公開前レビューで指摘された2点を固定する:
 *  - I-1: 保存失敗（saveStatus:'error'）後も、新しい編集（apply）が入ったら
 *    「新しい保存対象」として自動保存が再開できるよう saveStatus を 'idle' へ戻す
 *    （同じ失敗コンテンツへの盲目的リトライではなく、新編集は別の保存試行として扱う）。
 *  - I-2: save() の二重起動防止を同期的な in-flight ロックにする。同時に 2 箇所から
 *    save() を呼んでも PUT は 1 回だけ・両呼び出し元は同じ結果を受け取る
 *    （state ベースのガードだと同一レンダー内の連続呼び出しをすり抜けたり、
 *    「保存中なので false」を誤って返して呼び出し元の遷移を阻害したりする）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditSession } from './useEditSession';
import type { EditorProject } from '../core/types';
import type { SaveMeta } from './useEditorProject';
import { insertTelop } from './edit/cutOps';

function sampleProject(): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 900,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [{ id: 1, originalStart: 30, originalEnd: 150, text: 'ゆる素振り' }],
    cutRegions: [],
    se: [],
    images: [],
    bgm: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

function sampleSaveMeta(): SaveMeta {
  return {
    telopDataRelPath: 'src/テロップテンプレート/telopData.ts',
    cutDataRelPath: 'src/cutData.ts',
    fingerprint: {
      telopData: { relPath: 'src/テロップテンプレート/telopData.ts', size: 10, mtimeMs: 1 },
      cutData: null,
      seData: null,
      insertImageData: null,
      videoInsertData: null,
      bgmData: null,
      titleData: null,
      shapeData: null,
      transitionData: null,
      mainLayoutData: null,
      speedData: null,
    },
  };
}

describe('useEditSession.save', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('I-1: 保存失敗後に新しい編集（apply）が入ると saveStatus が idle へ戻る（自動保存の再開余地を残す）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: '指紋不一致' }),
    });
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    await act(async () => {
      await result.current!.save();
    });
    expect(result.current!.saveStatus).toBe('error');

    act(() => {
      result.current!.apply(insertTelop(result.current!.state, null, 500, 600));
    });
    expect(result.current!.saveStatus).toBe('idle');
    expect(result.current!.saveError).toBeNull();
  });

  it('I-2: 同時に 2 回 save() を呼んでも PUT は 1 回だけ・両方とも同じ結果を受け取る', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let p1!: Promise<boolean>;
    let p2!: Promise<boolean>;
    act(() => {
      p1 = result.current!.save();
      p2 = result.current!.save();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ fingerprint: { telopData: 'fp-telop-2', cutData: 'fp-cut-2' } }),
      });
      await Promise.all([p1, p2]);
    });

    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('I-2: 保存進行中に呼ばれた save() は false を早期に返さず、完了結果を待って返す', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let firstSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current!.save();
    });
    expect(result.current!.saveStatus).toBe('saving');

    // 進行中に「ホームへ戻る」等が save() を呼ぶケースを模す。
    let secondSave!: Promise<boolean>;
    act(() => {
      secondSave = result.current!.save();
    });

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ fingerprint: { telopData: 'fp-telop-2', cutData: 'fp-cut-2' } }),
      });
      await Promise.all([firstSave, secondSave]);
    });

    // 進行中に割り込んだ save() が誤って false を返し、呼び出し元の遷移を阻害しないこと。
    expect(await secondSave).toBe(true);
  });

  it('C-1: save() が in-flight のまま apply(B) → 2回目の save() を await すると B の PUT が発行され最終 savedContent が B になる', async () => {
    let resolveFirstFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstFetch = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ fingerprint: { telopData: 'fp-telop-3', cutData: 'fp-cut-3' } }),
    }));
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let p1!: Promise<boolean>;
    act(() => {
      // 1回目の save() = スナップショット A（元のテロップ1件）が in-flight になる。
      p1 = result.current!.save();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 窓の中で編集 B（テロップ追加）が入る。
    act(() => {
      result.current!.apply(insertTelop(result.current!.state, null, 500, 600));
    });

    let p2!: Promise<boolean>;
    act(() => {
      p2 = result.current!.save();
    });

    await act(async () => {
      resolveFirstFetch({
        ok: true,
        json: async () => ({ fingerprint: { telopData: 'fp-telop-2', cutData: 'fp-cut-2' } }),
      });
      await Promise.all([p1, p2]);
    });

    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    // A の PUT（1回目）＋ B の再保存（2回目）で計2回発行される。
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(secondCallBody.project.telops).toHaveLength(2);
    expect(secondCallBody.fingerprint).toEqual({ telopData: 'fp-telop-2', cutData: 'fp-cut-2' });

    // 最終的に dirty=false（保存済み内容 = B）になっていること。
    expect(result.current!.dirty).toBe(false);
  });
});
