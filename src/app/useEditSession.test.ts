/**
 * @vitest-environment jsdom
 */
/**
 * useEditSession の保存経路（save()）のユニットテスト。
 * D-2 自動保存導入に伴い code-reviewer から指摘された2点を固定する:
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
import { setTelopText } from './edit/textOps';
import { setShootingScriptText } from './edit/scriptOps';
import {
  retimeVideoInsert,
  setVideoInsertFile,
  setVideoInsertInPoint,
  setVideoInsertPlaybackRate,
} from './edit/videoInsertOps';

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

/** サブ動画インサートを1件持つプロジェクト（C-2: 保存時クランプの合流テスト用）。 */
function sampleProjectWithVideoInsert(): EditorProject {
  return {
    ...sampleProject(),
    videoInserts: [
      { id: 1, originalStart: 0, originalEnd: 100, file: 'sub/cam2.mp4', sourceInFrame: 0 },
    ],
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

  it.each([undefined, null, { relPath: 'shooting-script.json', size: 'bad', mtimeMs: 1 }])(
    '台本保存の2xxでも指紋が欠落・不正なら保存済みにしない (%j)', async (scriptDocument) => {
      const project = sampleProject();
      const meta = sampleSaveMeta();
      const { result } = renderHook(() => useEditSession('p1', project, meta));
      act(() => result.current!.apply(setShootingScriptText(result.current!.state, '撮影台本')));
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
        ok: true, fingerprint: { ...meta.fingerprint, scriptDocument },
      }) });
      let saved: boolean | undefined;
      await act(async () => { saved = await result.current!.save(); });
      expect(saved).toBe(false);
      expect(result.current!.dirty).toBe(true);
      expect(result.current!.saveStatus).toBe('error');
    },
  );

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

  /**
   * 保存衝突（409）からの復帰（2026-09-04 のデータ損失）。
   * 別の画面が保存すると指紋が食い違い 409 になる。従来は「開き直してください」しか
   * 出口が無く、開き直すと未保存の編集が消えた。衝突だけを他のエラーと区別して
   * 検知し、利用者が選んだときだけ overwrite で再送する。
   */
  it('409 は saveConflict を立てる（通常のエラーとは区別する）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'telopData.ts が読み込み後に外部で変更されています' }),
    });
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let conflictAtAwait = false;
    const session = result.current!;
    await act(async () => {
      await session.save();
      // await 直後（再レンダー前）に読める形でも衝突が分かること。
      // 保存直後の分岐（再読込ガード）はこちらを見る。
      conflictAtAwait = session.isSaveConflict();
    });
    expect(conflictAtAwait).toBe(true);
    expect(result.current!.saveStatus).toBe('error');
    expect(result.current!.saveConflict).toBe(true);
  });

  it('409 以外のエラーでは saveConflict を立てない', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: '保存データの生成に失敗しました' }),
    });
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    await act(async () => {
      await result.current!.save();
    });
    expect(result.current!.saveStatus).toBe('error');
    expect(result.current!.saveConflict).toBe(false);
  });

  it('通常UIのsaveは通信結果不明でもrejectせずfalseを返す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const source = sampleProject(); const saveMeta = sampleSaveMeta();
    const { result } = renderHook(() => useEditSession('p1', source, saveMeta));

    await act(async () => {
      await expect(result.current!.save()).resolves.toBe(false);
    });
    expect(result.current!.saveStatus).toBe('error');
    expect(result.current!.dirty).toBe(false);
  });

  it('saveOverwrite() は overwrite:true を送り、成功したら衝突状態を解除する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: '外部で変更されています' }),
    });
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));
    await act(async () => {
      await result.current!.save();
    });
    expect(result.current!.saveConflict).toBe(true);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }),
    });
    await act(async () => {
      await result.current!.saveOverwrite();
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body)) as { overwrite?: boolean };
    expect(body.overwrite).toBe(true);
    expect(result.current!.saveConflict).toBe(false);
    expect(result.current!.saveStatus).toBe('idle');
  });

  it('通常の save() は overwrite を送らない（自動保存が黙って他方を消さない）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }),
    });
    const project = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));
    await act(async () => {
      await result.current!.save();
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { overwrite?: boolean };
    expect(body.overwrite).toBeUndefined();
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
        json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }),
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
        json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }),
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
      json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }),
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
        json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }),
      });
      await Promise.all([p1, p2]);
    });

    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    // A の PUT（1回目）＋ B の再保存（2回目）で計2回発行される。
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(secondCallBody.project.telops).toHaveLength(2);
    expect(secondCallBody.fingerprint).toEqual(sampleSaveMeta().fingerprint);

    // 最終的に dirty=false（保存済み内容 = B）になっていること。
    expect(result.current!.dirty).toBe(false);
  });

  it('指定stateの厳密保存は往復中の人編集を追いPUTせず、未保存のまま残す', async () => {
    const finishes: Array<(response: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const source = sampleProject(); const saveMeta = sampleSaveMeta();
    const { result } = renderHook(() => useEditSession('p1', source, saveMeta));
    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'agent edit')); });
    const expectedState = result.current!.state;
    let saving!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      saving = result.current!.save({ expectedState });
      duplicate = result.current!.save({ expectedState });
    });
    expect(duplicate).toBe(saving);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'human partial edit')); });
    await act(async () => {
      finishes[0]!({ ok: true, json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }) });
      await Promise.race([saving, new Promise((resolve) => setTimeout(resolve, 50))]);
    });
    const submitted = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).project.telops[0].text);
    if (finishes[1]) {
      finishes[1]({ ok: true, json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }) });
      await saving;
    }
    expect(submitted).toEqual(['agent edit']);
    expect(result.current!.state.telops[0]?.text).toBe('human partial edit');
    expect(result.current!.dirty).toBe(true);
  });

  it('指定stateが保存開始前に現stateでなくなっていればPUTしない', async () => {
    const source = sampleProject(); const saveMeta = sampleSaveMeta();
    const { result } = renderHook(() => useEditSession('p1', source, saveMeta));
    const expectedState = result.current!.state;
    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'later edit')); });

    expect(await result.current!.save({ expectedState })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current!.dirty).toBe(true);
  });

  it('厳密保存中に人が通常保存を要求したら、その人編集は別の追いPUTで保存する', async () => {
    const finishes: Array<(response: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const source = sampleProject(); const saveMeta = sampleSaveMeta();
    const { result } = renderHook(() => useEditSession('p1', source, saveMeta));
    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'agent edit')); });
    const expectedState = result.current!.state;
    let exact!: Promise<boolean>;
    act(() => { exact = result.current!.save({ expectedState }); });
    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'human edit')); });
    let humanSave!: Promise<boolean>;
    act(() => { humanSave = result.current!.save(); });
    expect(humanSave).not.toBe(exact);

    await act(async () => {
      finishes[0]!({ ok: true, json: async () => ({ ok: true, fingerprint: saveMeta.fingerprint }) });
      expect(await exact).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishes[1]!({ ok: true, json: async () => ({ ok: true, fingerprint: saveMeta.fingerprint }) });
      expect(await humanSave).toBe(true);
    });
    const submitted = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).project.telops[0].text);
    expect(submitted).toEqual(['agent edit', 'human edit']);
    expect(result.current!.dirty).toBe(false);
  });

  it('厳密保存が結果不明でも人の通常保存chainはrejectせず、deliveryヘッダを引き継がない', async () => {
    let rejectExact!: (reason: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectExact = reject; }));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: '最初のPUTが反映済みの可能性があります' }),
    });
    const saveMeta = sampleSaveMeta();
    const source = sampleProject();
    const { result } = renderHook(() => useEditSession('p1', source, saveMeta));
    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'agent edit')); });
    const expectedState = result.current!.state;
    let exact!: Promise<boolean>;
    act(() => {
      exact = result.current!.save({ expectedState, delivery: { runId: 'run-1', token: 'secret-1' } });
    });
    act(() => { result.current!.apply((state) => setTelopText(state, 1, 'human edit')); });
    let humanSave!: Promise<boolean>;
    act(() => { humanSave = result.current!.save(); });

    await act(async () => {
      rejectExact(new TypeError('response lost'));
      await expect(exact).rejects.toThrow(/response lost/);
      await expect(humanSave).resolves.toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const strictHeaders = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    const humanHeaders = fetchMock.mock.calls[1]![1].headers as Record<string, string>;
    expect(strictHeaders['X-Harness-Editor-Run']).toBe('run-1');
    expect(strictHeaders['X-Harness-Editor-Token']).toBe('secret-1');
    expect(humanHeaders['X-Harness-Editor-Run']).toBeUndefined();
    expect(humanHeaders['X-Harness-Editor-Token']).toBeUndefined();
    expect(result.current!.state.telops[0]?.text).toBe('human edit');
    expect(result.current!.dirty).toBe(true);
    expect(result.current!.saveConflict).toBe(true);
  });

  /**
   * C-2: 保存時クランプがエディタの状態と無言で食い違う（Codex 指摘）。
   * サーバが videoInserts.originalEnd をクランプしても、応答が fingerprint しか返さないと
   * クライアントはクランプ前のスナップショットを「保存済み」として確定してしまい、
   * タイムライン・プレビュー・超過警告が画面上ではクランプ前のまま残る。
   */
  it('independent placement returned by save updates the displayed and saved subvideo together', async () => {
    const timelinePlacement = { startFrame: 101, endFrame: 121 };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true,
      fingerprint: { ...sampleSaveMeta().fingerprint, editorTimeline: { relPath: 'editor-timeline.json', size: 100, mtimeMs: 1 } }, clampedVideoInserts: [{ id: 1, originalEnd: 100, timelinePlacement }] }) });
    const project = sampleProjectWithVideoInsert();
    project.videoInserts![0]!.timelinePlacement = { startFrame: 101, endFrame: 141 };
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));
    await act(async () => { await result.current!.save(); });
    expect(result.current!.state.videoInserts[0]?.timelinePlacement).toEqual(timelinePlacement);
    expect(result.current!.dirty).toBe(false);
  });

  it('does not claim an independent placement was saved when the server omits its binding fingerprint', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, fingerprint: sampleSaveMeta().fingerprint }) });
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));
    act(() => result.current!.apply(s => ({ ...s, videoInserts: s.videoInserts.map(v => ({ ...v, timelinePlacement: { startFrame: 101, endFrame: 141 } })) })));
    let saved: boolean | undefined;
    await act(async () => { saved = await result.current!.save(); });
    expect(saved).toBe(false);
    expect(result.current!.dirty).toBe(true);
    expect(result.current!.saveStatus).toBe('error');
  });

  it('a delayed clamp response cannot overwrite a newer independent placement', async () => {
    let respond!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const project = sampleProjectWithVideoInsert();
    project.videoInserts![0]!.timelinePlacement = { startFrame: 101, endFrame: 141 };
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current!.save(); });
    act(() => result.current!.apply(s => ({ ...s, videoInserts: s.videoInserts.map(v => ({ ...v, timelinePlacement: { startFrame: 201, endFrame: 211 } })) })));
    await act(async () => {
      respond({ ok: true, status: 200, json: async () => ({ ok: true,
        fingerprint: { ...sampleSaveMeta().fingerprint, editorTimeline: { relPath: 'editor-timeline.json', size: 100, mtimeMs: 1 } },
        clampedVideoInserts: [{ id: 1, originalEnd: 100, timelinePlacement: { startFrame: 101, endFrame: 121 } }] }) });
      await pending;
    });
    expect(result.current!.state.videoInserts[0]?.timelinePlacement).toEqual({ startFrame: 201, endFrame: 211 });
    expect(result.current!.dirty).toBe(true);
  });

  it('C-2: 保存でクランプが起きたら画面の videoInserts へも反映し、通知を出す', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        fingerprint: sampleSaveMeta().fingerprint,
        // サーバが originalEnd:100 → 40 へクランプした。
        clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
      }),
    });
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    await act(async () => {
      await result.current!.save();
    });

    // 画面の videoInserts がクランプ後の値へ更新されている（無言で食い違わない）。
    const vi = result.current!.state.videoInserts.find((v) => v.id === 1);
    expect(vi?.originalEnd).toBe(40);
    // クランプが起きたことが利用者へ伝わる。
    expect(result.current!.saveClampNotice).not.toBeNull();
    // 反映済みなので dirty=false（保存済み内容と画面が一致）。
    expect(result.current!.dirty).toBe(false);
  });

  /**
   * X-2(a): クランプでは直せない「再生可能フレームが1枚も残っていない」サブ動画。
   * 従来はサーバが unplayableIds を集めていたのに応答へ載せず握り潰していたため、
   * 利用者には何も伝わらず、書き出しで初めて壊れていることに気づく状態だった。
   */
  it('X-2(a): 再生できる範囲が残っていないサブ動画があれば通知に出す', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        fingerprint: sampleSaveMeta().fingerprint,
        unplayableVideoInserts: [{ id: 1, file: 'sub/cam2.mp4' }],
      }),
    });
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    await act(async () => {
      await result.current!.save();
    });

    const notice = result.current!.saveClampNotice;
    expect(notice).not.toBeNull();
    expect(notice).toContain('再生できる範囲');
    expect(notice).toContain('sub/cam2.mp4');
    // 非破壊: 勝手に消したり値を変えたりしない（伝えるだけ）。
    expect(result.current!.state.videoInserts.find((v) => v.id === 1)?.originalEnd).toBe(100);
  });

  it('X-2(a): クランプと再生不能が同時に起きたら両方伝える（片方に埋もれさせない）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        fingerprint: sampleSaveMeta().fingerprint,
        clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
        unplayableVideoInserts: [{ id: 2, file: 'sub/other.mp4' }],
      }),
    });
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    await act(async () => {
      await result.current!.save();
    });

    const notice = result.current!.saveClampNotice;
    expect(notice).toContain('自動調整');
    expect(notice).toContain('再生できる範囲');
    expect(notice).toContain('sub/other.mp4');
  });

  it('C-2: 保存往復中に同じクリップをさらに編集していたら、その編集をクランプで上書きしない（編集消失防止）', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let p!: Promise<boolean>;
    act(() => {
      // originalEnd:100 のスナップショットが in-flight で送信される。
      p = result.current!.save();
    });

    // 往復中に利用者がさらに終了位置を編集（originalEnd: 100 → 80）。
    act(() => {
      result.current!.apply(retimeVideoInsert(result.current!.state, 1, 0, 80));
    });

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          ok: true,
          fingerprint: sampleSaveMeta().fingerprint,
          // サーバは送信時点のスナップショット（originalEnd:100）を 40 へクランプして返す。
          clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
        }),
      });
      await p;
    });

    // 往復中の編集（80）が失われていないこと（40 で上書きされない）。
    const vi = result.current!.state.videoInserts.find((v) => v.id === 1);
    expect(vi?.originalEnd).toBe(80);
    // ディスク上はクランプ後の 40 で保存されているため、画面(80)とはまだ食い違いが残る
    // ＝ dirty=true として次の保存が必要なことが分かる（黙って揃えない）。
    expect(result.current!.dirty).toBe(true);
  });
  /**
   * D-1（Codex 指摘・P1）: クランプ適用の照合が originalEnd だけでは足りない。
   * クランプ結果は「送信時の file / sourceInFrame / playbackRate / originalStart」を前提に
   * 計算された値であり、往復中にその前提が動いたら、もうそのクリップには当てはまらない。
   * originalEnd の一致だけで同一視すると、利用者が自分で超過を解消した編集を
   * 遅れて届いた応答が黙って切り詰め、次の保存でその意図しないトリムが永続化される。
   */
  it('D-1: 保存往復中にイン点(sourceInFrame)を動かしたら、古いクランプ応答を適用しない', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let p!: Promise<boolean>;
    act(() => {
      // sourceInFrame:0 / originalEnd:100 のスナップショットが in-flight で送信される。
      p = result.current!.save();
    });

    // 往復中に利用者がイン点を前へ動かして自分で超過を解消した（originalEnd は動かない）。
    act(() => {
      result.current!.apply(setVideoInsertInPoint(result.current!.state, 1, 20));
    });

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          ok: true,
          fingerprint: sampleSaveMeta().fingerprint,
          // サーバは送信時点（sourceInFrame:0）を前提に 100 → 40 へクランプして返した。
          clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
        }),
      });
      await p;
    });

    const vi = result.current!.state.videoInserts.find((v) => v.id === 1);
    expect(vi?.sourceInFrame).toBe(20);
    // 前提が変わったクランプは当てはまらない＝画面のクリップを短くしない。
    expect(vi?.originalEnd).toBe(100);
    // ディスク（40）と画面（100）は食い違ったままなので、次の保存が要ることが分かる。
    expect(result.current!.dirty).toBe(true);
  });

  it('D-1: 保存往復中に file を差し替えたら、古いクランプ応答を適用しない', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let p!: Promise<boolean>;
    act(() => {
      p = result.current!.save();
    });

    // 往復中に別ファイル（長さが違いうる）へ差し替えた。
    act(() => {
      result.current!.apply(setVideoInsertFile(result.current!.state, 1, 'sub/cam3.mp4'));
    });

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          ok: true,
          fingerprint: sampleSaveMeta().fingerprint,
          // 旧ファイル sub/cam2.mp4 の実長を前提にしたクランプ。
          clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
        }),
      });
      await p;
    });

    const vi = result.current!.state.videoInserts.find((v) => v.id === 1);
    expect(vi?.file).toBe('sub/cam3.mp4');
    expect(vi?.originalEnd).toBe(100);
    expect(result.current!.dirty).toBe(true);
  });

  it('D-1: 保存往復中に playbackRate を変えたら、古いクランプ応答を適用しない', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const project = sampleProjectWithVideoInsert();
    const { result } = renderHook(() => useEditSession('p1', project, sampleSaveMeta()));

    let p!: Promise<boolean>;
    act(() => {
      p = result.current!.save();
    });

    // 速度だけ変わり、丸めの結果 originalEnd は 100 のまま（100/1.005≒99.5 → round → 100）。
    // 消費ソースフレーム数は変わるのでクランプの前提は動いている。
    act(() => {
      result.current!.apply(setVideoInsertPlaybackRate(result.current!.state, 1, 1.005));
    });

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          ok: true,
          fingerprint: sampleSaveMeta().fingerprint,
          clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
        }),
      });
      await p;
    });

    const vi = result.current!.state.videoInserts.find((v) => v.id === 1);
    expect(vi?.playbackRate).toBe(1.005);
    expect(vi?.originalEnd).toBe(100);
  });

  /**
   * D-2（Codex 指摘・P1）: 差し替わった編集セッションの応答を受け付けてしまう。
   * 保存応答の往復中にプロジェクトが再読込されると（外部変更バナーの「読み込み直す」等）、
   * クランプ合流は差し替わった後のセッションの history を触る。id と originalEnd が
   * たまたま一致すれば、このリクエストが送っていない新しい内容を古い応答がトリムしうる。
   * C-2 以前は応答が history を書き換えなかったため、これは C-2 が持ち込んだ新規の退行。
   */
  it('D-2: 保存往復中にプロジェクトが再読込されたら、古い応答で新セッションの history を書き換えない', async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const oldProject = sampleProjectWithVideoInsert();
    // 再読込後の新しい EditorProject。同じ id・同じ originalEnd だが中身は別（テロップが増えている）。
    const reloadedProject: EditorProject = {
      ...sampleProjectWithVideoInsert(),
      telops: [
        { id: 1, originalStart: 30, originalEnd: 150, text: 'ゆる素振り' },
        { id: 2, originalStart: 200, originalEnd: 260, text: '再読込で入った新しい内容' },
      ],
    };
    const { result, rerender } = renderHook(
      ({ project }: { project: EditorProject }) => useEditSession('p1', project, sampleSaveMeta()),
      { initialProps: { project: oldProject } },
    );

    let p!: Promise<boolean>;
    act(() => {
      p = result.current!.save();
    });

    // 往復中にプロジェクトを読み込み直す（= セッションが差し替わる）。
    act(() => {
      rerender({ project: reloadedProject });
    });
    expect(result.current!.state.telops).toHaveLength(2);

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          ok: true,
          fingerprint: sampleSaveMeta().fingerprint,
          clampedVideoInserts: [{ id: 1, originalEnd: 40 }],
        }),
      });
      await p;
    });

    // 新しいセッションの内容は古い応答に触られない。
    expect(result.current!.state.telops).toHaveLength(2);
    expect(result.current!.state.videoInserts.find((v) => v.id === 1)?.originalEnd).toBe(100);
    // 送っていない内容に対する通知も出さない（別セッションの結果を混ぜない）。
    expect(result.current!.saveClampNotice).toBeNull();
    // 読込直後のまま＝未編集。
    expect(result.current!.dirty).toBe(false);
  });
});

describe('sessionGuard（保存してから遷移する着地の世代照合・マージレビュー Codex P1）', () => {
  it('作った時点のセッションが続く限り true、baseProject が差し替わる（開き直し）と false になる', () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: EditorProject }) => useEditSession('p1', p, sampleSaveMeta()),
      { initialProps: { p: sampleProject() } },
    );
    const guard = result.current!.sessionGuard();
    expect(guard()).toBe(true);
    // 同じ案件でも開き直すと baseProject が新しいオブジェクトになり、セッションは作り直される。
    rerender({ p: sampleProject() });
    expect(guard()).toBe(false);
    // 新しいセッションで作り直した guard は true。
    expect(result.current!.sessionGuard()()).toBe(true);
  });
});
