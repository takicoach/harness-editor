/**
 * captureDriver.ts のユニットテスト（deps 注入・実 Chromium なし）。
 * 実 Chromium での撮影は T4（captureSmoke.e2e.test.ts）の守備範囲。
 */
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { captureOverlaySequence, captureSpecifiedRuns, type CaptureDeps, type CapturePage } from './captureDriver';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  return Buffer.concat([len, typeBuf, data, Buffer.alloc(4)]); // CRC 不使用（デコーダは検査しない）
}

function ihdrChunk(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(8, 8); // bitDepth
  data.writeUInt8(6, 9); // colorType RGBA
  data.writeUInt8(0, 10);
  data.writeUInt8(0, 11);
  data.writeUInt8(0, 12); // interlace
  return chunk('IHDR', data);
}

/** width x height の単色 RGBA PNG（filter 0）を作る。 */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const stride = width * 4;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride + 1);
    row[0] = 0; // filter none
    for (let x = 0; x < width; x++) {
      row[1 + x * 4] = rgba[0];
      row[1 + x * 4 + 1] = rgba[1];
      row[1 + x * 4 + 2] = rgba[2];
      row[1 + x * 4 + 3] = rgba[3];
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw);
  return Buffer.concat([SIG, ihdrChunk(width, height), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

const W = 4;
const H = 4;

function baseRequest(overrides: Partial<Parameters<typeof captureOverlaySequence>[0]> = {}) {
  return {
    serverUrl: 'http://127.0.0.1:9999',
    layer: 'telop' as const,
    projectId: 'proj-1',
    data: { telops: [] },
    width: W,
    height: H,
    fps: 30,
    durationInFrames: 300,
    frames: { start: 0, end: 4 },
    outDir: '/tmp/does-not-matter',
    ...overrides,
  };
}

/**
 * screenshot 呼び出しごとに異なる PNG を返せるモック CapturePage を作る。
 * init/setFrame の判別は fn.toString() ではなく **呼び出し順**（最初の evaluate = init、
 * それ以降 = setFrame）で行う（レビュー指摘#7: 実装詳細に依存しない判別方式にする）。
 */
function makePage(screenshots: Buffer[], opts: { initResult?: unknown; setFrameResults?: unknown[] } = {}) {
  const evaluateArgs: unknown[] = [];
  const screenshotCalls: Array<{ omitBackground: boolean }> = [];
  const gotoCalls: string[] = [];
  let evaluateCallIndex = 0;
  const page: CapturePage = {
    goto: vi.fn(async (url: string) => {
      gotoCalls.push(url);
    }),
    evaluate: (vi.fn(async (_fn: (arg: unknown) => unknown, arg: unknown) => {
      evaluateArgs.push(arg);
      const isInit = evaluateCallIndex === 0;
      evaluateCallIndex += 1;
      if (isInit) {
        return opts.initResult ?? { ok: true };
      }
      const setFrameIndex = evaluateCallIndex - 2;
      return opts.setFrameResults?.[setFrameIndex] ?? { ok: true };
    }) as unknown) as CapturePage['evaluate'],
    screenshot: vi.fn(async (o: { omitBackground: boolean }) => {
      screenshotCalls.push(o);
      const idx = screenshotCalls.length - 1;
      const buf = screenshots[idx];
      if (buf === undefined) throw new Error('screenshot mock: フレームが足りません');
      return buf;
    }),
  };
  return { page, evaluateArgs, screenshotCalls, gotoCalls };
}

function makeDeps(
  page: CapturePage,
  opts: { launchThrows?: boolean; closeThrows?: boolean; mkdirThrows?: boolean; writeFileFailsOnCall?: number } = {},
): {
  deps: CaptureDeps;
  writes: Array<{ path: string; data: Buffer }>;
  unlinks: string[];
  launchArgs: unknown[];
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const writes: Array<{ path: string; data: Buffer }> = [];
  const unlinks: string[] = [];
  const launchArgs: unknown[] = [];
  let writeCallCount = 0;
  const closeSpy = vi.fn(async () => {
    if (opts.closeThrows) throw new Error('close 失敗（テスト）');
  });
  const deps: CaptureDeps = {
    launchChromium: vi.fn(async (launchOpts: unknown) => {
      launchArgs.push(launchOpts);
      if (opts.launchThrows) {
        throw new Error('chromium 起動失敗（テスト）');
      }
      return { page, close: closeSpy };
    }),
    mkdir: vi.fn(async () => {
      if (opts.mkdirThrows) throw new Error('mkdir 失敗（テスト）');
    }),
    writeFile: vi.fn(async (path: string, data: Buffer) => {
      writeCallCount += 1;
      if (opts.writeFileFailsOnCall !== undefined && writeCallCount === opts.writeFileFailsOnCall) {
        throw new Error(`writeFile 失敗（テスト・${writeCallCount}回目）`);
      }
      writes.push({ path, data });
    }),
    unlink: vi.fn(async (path: string) => {
      unlinks.push(path);
    }),
  };
  return { deps, writes, unlinks, launchArgs, closeSpy };
}

describe('captureOverlaySequence: 正常系', () => {
  it('[同一2][変化1][同一2] の5フレームが3 run に圧縮され、代表フレームのみ書き出す', async () => {
    const a = solidPng(W, H, [10, 20, 30, 255]);
    const a2 = solidPng(W, H, [10, 20, 30, 255]);
    const b = solidPng(W, H, [200, 0, 0, 255]);
    const { page } = makePage([a, a2, b, a, a2]);
    const { deps, writes, closeSpy } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.runs).toEqual([
      { pngFileIndex: 0, startFrame: 0, endFrame: 2 },
      { pngFileIndex: 1, startFrame: 2, endFrame: 3 },
      { pngFileIndex: 2, startFrame: 3, endFrame: 5 },
    ]);
    expect(result.manifest.pngFiles).toHaveLength(3);
    // I-6: パスは join() で組まれること（生 `/` 連結だと Windows でセパレータ混在）。
    expect(result.manifest.pngFiles[0]).toBe(join('/tmp/does-not-matter', '000000.png'));
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => w.path)).toEqual(result.manifest.pngFiles);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('正規化が撮影経路で実際に通っている: A=0 で RGB だけ違う2フレームが1 runに融合する', async () => {
    const transparent1 = solidPng(W, H, [10, 20, 30, 0]);
    const transparent2 = solidPng(W, H, [90, 5, 200, 0]);
    const { page } = makePage([transparent1, transparent2]);
    const { deps } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 1 } }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.runs).toEqual([{ pngFileIndex: 0, startFrame: 0, endFrame: 2 }]);
  });

  it('omitBackground:true・deviceScaleFactor:1・viewport 実値が page 操作モックに渡る（clip は渡さない）', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page, screenshotCalls, gotoCalls } = makePage([solo]);
    const { deps, launchArgs, closeSpy } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 0 } }), deps);

    expect(result.ok).toBe(true);
    expect(launchArgs).toEqual([{ viewport: { width: W, height: H }, deviceScaleFactor: 1 }]);
    expect(screenshotCalls).toEqual([{ omitBackground: true }]);
    expect(screenshotCalls[0]).not.toHaveProperty('clip');
    expect(gotoCalls).toEqual(['http://127.0.0.1:9999/capture']);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('durationInFrames は frames.end から推定せず、req の値をそのまま videoConfig に渡す（部分範囲でも）', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page, evaluateArgs } = makePage([solo]);
    const { deps } = makeDeps(page);

    // 300フレームの合成のうち、途中の1フレーム（frame 50）だけを撮る部分範囲撮影。
    const result = await captureOverlaySequence(
      baseRequest({ durationInFrames: 300, frames: { start: 50, end: 50 } }),
      deps,
    );

    expect(result.ok).toBe(true);
    const initArg = evaluateArgs[0] as { videoConfig: { durationInFrames: number }; initialFrame: number };
    expect(initArg.videoConfig.durationInFrames).toBe(300);
    // I-2: initialFrame は撮影範囲の start（部分範囲撮影の絶対フレーム番号）をそのまま渡す。
    // 変異 0 は「常に先頭から撮る」退行であり、この assert が落として検出する。
    expect(initArg.initialFrame).toBe(50);
  });
});

describe('captureOverlaySequence: 失敗伝播', () => {
  it('init が {ok:false, kind} を返したら CaptureResult にそのまま写る', async () => {
    const { page } = makePage([], { initResult: { ok: false, kind: 'asset-decode-failed', message: '画像だめ' } });
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'asset-decode-failed', message: '画像だめ' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('init が capture-runtime-unsupported を返したらそのまま写る', async () => {
    const { page } = makePage([], {
      initResult: { ok: false, kind: 'capture-runtime-unsupported', message: 'captureRuntime: 非対応' },
    });
    const { deps } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'capture-runtime-unsupported' });
  });

  it('setFrame が {ok:false, kind} を返したら CaptureResult にそのまま写り、frame を伴う', async () => {
    const a = solidPng(W, H, [1, 1, 1, 255]);
    const { page } = makePage([a], {
      setFrameResults: [{ ok: true }, { ok: false, kind: 'render-error', message: '描画失敗' }],
    });
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 1 } }), deps);

    expect(result).toMatchObject({ ok: false, kind: 'render-error', message: '描画失敗', frame: 1 });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('screenshot が throw したら screenshot-failed に写り、frame を伴う', async () => {
    const page: CapturePage = {
      goto: vi.fn(async () => {}),
      evaluate: (vi.fn(async () => ({ ok: true })) as unknown) as CapturePage['evaluate'],
      screenshot: vi.fn(async () => {
        throw new Error('screenshot クラッシュ');
      }),
    };
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 0 } }), deps);

    expect(result).toMatchObject({ ok: false, kind: 'screenshot-failed', frame: 0 });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('decodePngRgba が throw する不正 PNG なら decode-failed に写り、frame を伴う（M-1: screenshot-failed と区別）', async () => {
    const notAPng = Buffer.from('これはPNGではない');
    const { page } = makePage([notAPng]);
    const { deps } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 0 } }), deps);

    expect(result).toMatchObject({ ok: false, kind: 'decode-failed', frame: 0 });
  });

  it('chromium 起動が throw したら launch-failed に写り、close は呼ばれない', async () => {
    const { page } = makePage([]);
    const { deps, closeSpy } = makeDeps(page, { launchThrows: true });

    const result = await captureOverlaySequence(baseRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'launch-failed' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('goto が throw したら launch-failed に写り、close は呼ばれる（残留対策）', async () => {
    const page: CapturePage = {
      goto: vi.fn(async () => {
        throw new Error('goto 失敗（テスト）');
      }),
      evaluate: (vi.fn(async () => ({ ok: true })) as unknown) as CapturePage['evaluate'],
      screenshot: vi.fn(async () => {
        throw new Error('screenshot は呼ばれないはず');
      }),
    };
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureOverlaySequence(baseRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'launch-failed' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('close() が throw しても、既に確定した成功結果を握り潰さない', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page } = makePage([solo]);
    const { deps, closeSpy } = makeDeps(page, { closeThrows: true });

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 0 } }), deps);

    expect(result.ok).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('captureOverlaySequence: 書き出し失敗の fail-loud', () => {
  it('mkdir が throw したら write-failed に写る（screenshot 済みでもファイルは残らない）', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page } = makePage([solo]);
    const { deps, writes, unlinks } = makeDeps(page, { mkdirThrows: true });

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 0 } }), deps);

    expect(result).toMatchObject({ ok: false, kind: 'write-failed' });
    expect(writes).toHaveLength(0);
    expect(unlinks).toHaveLength(0);
  });

  it('2本目の run の writeFile が失敗したら write-failed に写り、1本目の書き出し済み PNG を削除する', async () => {
    const a = solidPng(W, H, [10, 20, 30, 255]);
    const a2 = solidPng(W, H, [10, 20, 30, 255]);
    const b = solidPng(W, H, [200, 0, 0, 255]);
    // [同一2][変化] の3フレーム: run1 (frame0-1) が frame2 で flush され writeFile 1回目成功、
    // run2 の flush はループ終端 or 次回変化時 — ここでは run1 flush 成功後、2回目の writeFile
    // （run2 の最終 flush）で失敗させる。
    const { page } = makePage([a, a2, b]);
    const { deps, writes, unlinks } = makeDeps(page, { writeFileFailsOnCall: 2 });

    const result = await captureOverlaySequence(baseRequest({ frames: { start: 0, end: 2 } }), deps);

    expect(result).toMatchObject({ ok: false, kind: 'write-failed' });
    expect(writes).toHaveLength(1);
    expect(unlinks).toEqual(writes.map((w) => w.path));
  });
});

// ---------------------------------------------------------------------------
// captureSpecifiedRuns: run 指定撮影モード（M2c T3・設計判断1の完成形）
// captureRunPlanner が事前計算した run 列（代表フレームの集合）だけを撮影し、
// run 検出（隣接フレーム比較）・decode/正規化/比較を一切行わない。
// ---------------------------------------------------------------------------

function baseRunsRequest(overrides: Partial<Parameters<typeof captureSpecifiedRuns>[0]> = {}) {
  return {
    serverUrl: 'http://127.0.0.1:9999',
    layer: 'telop' as const,
    projectId: 'proj-1',
    data: { telops: [] },
    width: W,
    height: H,
    fps: 30,
    durationInFrames: 300,
    runs: [
      { representativeFrame: 0, startFrame: 0, endFrame: 2 },
      { representativeFrame: 2, startFrame: 2, endFrame: 5 },
    ],
    outDir: '/tmp/does-not-matter-runs',
    ...overrides,
  };
}

describe('captureSpecifiedRuns: runs 入力検証（fail-loud・T3 追補・レビュー Minor①）', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2, .3])('rejects invalid or fractional-pixel density %s before launch', async pixelRatio => {
    const { page } = makePage([]); const { deps } = makeDeps(page);
    await expect(captureSpecifiedRuns(baseRunsRequest({ pixelRatio }), deps)).rejects.toThrow(/pixelRatio/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });
  it('keeps composition dimensions while capturing fewer physical pixels', async () => {
    const { page } = makePage([solidPng(W / 2, H / 2, [1, 2, 3, 255])]);
    const { deps, launchArgs, writes } = makeDeps(page);
    const result = await captureSpecifiedRuns(baseRunsRequest({ pixelRatio: .5, runs: [{ representativeFrame: 0, startFrame: 0, endFrame: 1 }] }), deps);
    expect(result.ok).toBe(true);
    expect(launchArgs).toEqual([{ viewport: { width: W, height: H }, deviceScaleFactor: .5 }]);
    expect(writes[0]!.data.readUInt32BE(16)).toBe(W / 2);
    expect(writes[0]!.data.readUInt32BE(20)).toBe(H / 2);
  });
  it('rejects an unexpected physical PNG size and cleans prior captures', async () => {
    const { page } = makePage([solidPng(W / 2, H / 2, [1, 2, 3, 255]), solidPng(W, H, [1, 2, 3, 255])]);
    const { deps, writes, unlinks } = makeDeps(page);
    const result = await captureSpecifiedRuns(baseRunsRequest({ pixelRatio: .5 }), deps);
    expect(result).toMatchObject({ ok: false, kind: 'decode-failed', frame: 2 });
    expect(writes).toHaveLength(1);
    expect(unlinks).toEqual([writes[0]!.path]);
  });
  it('非整数フレームは throw し、chromium は起動しない', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    await expect(
      captureSpecifiedRuns(
        baseRunsRequest({ runs: [{ representativeFrame: 0.5, startFrame: 0, endFrame: 2 }] }),
        deps,
      ),
    ).rejects.toThrow(/整数/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });

  it('endFrame<=startFrame（縮退区間）は throw する', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    await expect(
      captureSpecifiedRuns(
        baseRunsRequest({ runs: [{ representativeFrame: 5, startFrame: 5, endFrame: 5 }] }),
        deps,
      ),
    ).rejects.toThrow(/endFrame/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });

  it('representativeFrame が [startFrame,endFrame) の範囲外なら throw する', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    await expect(
      captureSpecifiedRuns(
        baseRunsRequest({ runs: [{ representativeFrame: 10, startFrame: 0, endFrame: 2 }] }),
        deps,
      ),
    ).rejects.toThrow(/representativeFrame/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });

  it('未整列（start が降順）は throw する', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    await expect(
      captureSpecifiedRuns(
        baseRunsRequest({
          runs: [
            { representativeFrame: 10, startFrame: 10, endFrame: 15 },
            { representativeFrame: 0, startFrame: 0, endFrame: 5 },
          ],
        }),
        deps,
      ),
    ).rejects.toThrow(/昇順/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });

  it('重複（隣接 run が重なる）は throw する', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    await expect(
      captureSpecifiedRuns(
        baseRunsRequest({
          runs: [
            { representativeFrame: 0, startFrame: 0, endFrame: 5 },
            { representativeFrame: 3, startFrame: 3, endFrame: 8 },
          ],
        }),
        deps,
      ),
    ).rejects.toThrow(/昇順/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });

  it('負の startFrame は throw する', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    await expect(
      captureSpecifiedRuns(
        baseRunsRequest({ runs: [{ representativeFrame: 0, startFrame: -1, endFrame: 2 }] }),
        deps,
      ),
    ).rejects.toThrow(/0以上/);
    expect(deps.launchChromium).not.toHaveBeenCalled();
  });

  it('正当な runs（隣接・非重複・昇順）はそのまま撮影が進む（誤検知しないことの対照）', async () => {
    const a = solidPng(W, H, [1, 2, 3, 255]);
    const b = solidPng(W, H, [4, 5, 6, 255]);
    const { page } = makePage([a, b]);
    const { deps } = makeDeps(page);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({
        runs: [
          { representativeFrame: 0, startFrame: 0, endFrame: 5 },
          { representativeFrame: 5, startFrame: 5, endFrame: 10 },
        ],
      }),
      deps,
    );
    expect(result.ok).toBe(true);
  });
});

describe('captureSpecifiedRuns: 正常系（run 検出なし・decode/正規化/比較なし）', () => {
  it('指定フレームのみ setFrame される（回数と順序 pin）', async () => {
    const a = solidPng(W, H, [1, 2, 3, 255]);
    const b = solidPng(W, H, [4, 5, 6, 255]);
    const { page, evaluateArgs } = makePage([a, b]);
    const { deps } = makeDeps(page);

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.runs).toEqual([
      { pngFileIndex: 0, startFrame: 0, endFrame: 2 },
      { pngFileIndex: 1, startFrame: 2, endFrame: 5 },
    ]);
    // evaluateArgs[0] = init の spec、以降は setFrame(frame) の引数。
    // representativeFrame（0, 2）の順に、かつそれだけ呼ばれることを pin する
    // （run 検出なし = 隣接フレームの中間を撮らない）。
    expect(evaluateArgs.slice(1)).toEqual([0, 2]);
  });

  it('decode/正規化/比較を行わない: screenshot が decode 不能な PNG でも成功しそのまま書き出す', async () => {
    // captureOverlaySequence なら decodePngRgba が throw して decode-failed になるはずの入力。
    // run 指定モードは decode を一切行わないので、そのまま素通りで書き出される。
    const garbage1 = Buffer.from('not-a-png-1');
    const garbage2 = Buffer.from('not-a-png-2');
    const { page } = makePage([garbage1, garbage2]);
    const { deps, writes } = makeDeps(page);

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result.ok).toBe(true);
    expect(writes.map((w) => w.data)).toEqual([garbage1, garbage2]);
  });

  it('runs が空なら1件も撮影せず、mkdir も呼ばれない', async () => {
    const { page } = makePage([]);
    const { deps } = makeDeps(page);

    const result = await captureSpecifiedRuns(baseRunsRequest({ runs: [] }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.runs).toEqual([]);
    expect(result.manifest.pngFiles).toEqual([]);
    expect(deps.mkdir).not.toHaveBeenCalled();
  });

  it('init の initialFrame は先頭 run の representativeFrame（durationInFrames はそのまま渡す）', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page, evaluateArgs } = makePage([solo]);
    const { deps } = makeDeps(page);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({
        durationInFrames: 300,
        runs: [{ representativeFrame: 50, startFrame: 50, endFrame: 51 }],
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    const initArg = evaluateArgs[0] as { videoConfig: { durationInFrames: number }; initialFrame: number };
    expect(initArg.videoConfig.durationInFrames).toBe(300);
    expect(initArg.initialFrame).toBe(50);
  });

  it('omitBackground:true・deviceScaleFactor:1・viewport 実値が page 操作モックに渡る（clip は渡さない）', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page, screenshotCalls, gotoCalls } = makePage([solo]);
    const { deps, launchArgs, closeSpy } = makeDeps(page);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({ runs: [{ representativeFrame: 0, startFrame: 0, endFrame: 1 }] }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(launchArgs).toEqual([{ viewport: { width: W, height: H }, deviceScaleFactor: 1 }]);
    expect(screenshotCalls).toEqual([{ omitBackground: true }]);
    expect(screenshotCalls[0]).not.toHaveProperty('clip');
    expect(gotoCalls).toEqual(['http://127.0.0.1:9999/capture']);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('captureSpecifiedRuns: onProgress（M2d T3・撮影枚数の途中経過報告）', () => {
  it('run 3本を撮影すると onProgress 呼び出し列が (1,3)(2,3)(3,3) になる', async () => {
    const a = solidPng(W, H, [1, 2, 3, 255]);
    const b = solidPng(W, H, [4, 5, 6, 255]);
    const c = solidPng(W, H, [7, 8, 9, 255]);
    const { page } = makePage([a, b, c]);
    const { deps } = makeDeps(page);
    const calls: Array<[number, number]> = [];
    deps.onProgress = (captured, total) => calls.push([captured, total]);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({
        runs: [
          { representativeFrame: 0, startFrame: 0, endFrame: 2 },
          { representativeFrame: 2, startFrame: 2, endFrame: 5 },
          { representativeFrame: 5, startFrame: 5, endFrame: 8 },
        ],
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  /**
   * I-3（T3 レビュー）: 「未指定ならコストゼロ」は `toBeUndefined()` を見るだけでは
   * 空振りする（production 側が run ごとに `deps.onProgress` を読み直しても緑のまま）。
   * getter の**読み取り回数**を数え、run 本数に比例しないこと（撮影開始時の1回だけ）を pin する。
   */
  it('deps.onProgress は撮影開始時に1回だけ読む（run ごとに読み直さない・コストゼロの実測）', async () => {
    const a = solidPng(W, H, [1, 2, 3, 255]);
    const b = solidPng(W, H, [4, 5, 6, 255]);
    const c = solidPng(W, H, [7, 8, 9, 255]);
    const { page } = makePage([a, b, c]);
    const { deps } = makeDeps(page);
    let reads = 0;
    const noop = (): void => {};
    Object.defineProperty(deps, 'onProgress', {
      configurable: true,
      get() {
        reads += 1;
        return noop;
      },
    });

    const result = await captureSpecifiedRuns(
      baseRunsRequest({
        runs: [
          { representativeFrame: 0, startFrame: 0, endFrame: 2 },
          { representativeFrame: 2, startFrame: 2, endFrame: 5 },
          { representativeFrame: 5, startFrame: 5, endFrame: 8 },
        ],
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
  });

  it('onProgress 未指定なら呼び出し自体を行わない（コストゼロ・回帰ガード）', async () => {
    const a = solidPng(W, H, [1, 2, 3, 255]);
    const b = solidPng(W, H, [4, 5, 6, 255]);
    const { page } = makePage([a, b]);
    const { deps } = makeDeps(page);
    expect(deps.onProgress).toBeUndefined();

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result.ok).toBe(true);
  });

  it('陰性対照: 2本目の writeFile が失敗したら onProgress は (1,3) のみで止まり、結果は ok:false（失敗後に進捗が進まない）', async () => {
    const a = solidPng(W, H, [1, 2, 3, 255]);
    const b = solidPng(W, H, [4, 5, 6, 255]);
    const c = solidPng(W, H, [7, 8, 9, 255]);
    const { page } = makePage([a, b, c]);
    const { deps } = makeDeps(page, { writeFileFailsOnCall: 2 });
    const calls: Array<[number, number]> = [];
    deps.onProgress = (captured, total) => calls.push([captured, total]);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({
        runs: [
          { representativeFrame: 0, startFrame: 0, endFrame: 2 },
          { representativeFrame: 2, startFrame: 2, endFrame: 5 },
          { representativeFrame: 5, startFrame: 5, endFrame: 8 },
        ],
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(calls).toEqual([[1, 3]]);
  });
});

describe('captureSpecifiedRuns: 失敗種別・close 保証・部分書き出し削除（既存モード同等）', () => {
  it('init が {ok:false, kind} を返したら CaptureResult にそのまま写る', async () => {
    const { page } = makePage([], { initResult: { ok: false, kind: 'asset-decode-failed', message: '画像だめ' } });
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'asset-decode-failed', message: '画像だめ' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('setFrame が {ok:false, kind} を返したら CaptureResult にそのまま写り、frame を伴う', async () => {
    const a = solidPng(W, H, [1, 1, 1, 255]);
    const { page } = makePage([a], {
      setFrameResults: [{ ok: false, kind: 'render-error', message: '描画失敗' }],
    });
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({ runs: [{ representativeFrame: 5, startFrame: 5, endFrame: 6 }] }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'render-error', message: '描画失敗', frame: 5 });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('screenshot が throw したら screenshot-failed に写り、frame を伴う', async () => {
    const page: CapturePage = {
      goto: vi.fn(async () => {}),
      evaluate: (vi.fn(async () => ({ ok: true })) as unknown) as CapturePage['evaluate'],
      screenshot: vi.fn(async () => {
        throw new Error('screenshot クラッシュ');
      }),
    };
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureSpecifiedRuns(
      baseRunsRequest({ runs: [{ representativeFrame: 0, startFrame: 0, endFrame: 1 }] }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'screenshot-failed', frame: 0 });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('chromium 起動が throw したら launch-failed に写り、close は呼ばれない', async () => {
    const { page } = makePage([]);
    const { deps, closeSpy } = makeDeps(page, { launchThrows: true });

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'launch-failed' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('goto が throw したら launch-failed に写り、close は呼ばれる（残留対策）', async () => {
    const page: CapturePage = {
      goto: vi.fn(async () => {
        throw new Error('goto 失敗（テスト）');
      }),
      evaluate: (vi.fn(async () => ({ ok: true })) as unknown) as CapturePage['evaluate'],
      screenshot: vi.fn(async () => {
        throw new Error('screenshot は呼ばれないはず');
      }),
    };
    const { deps, closeSpy } = makeDeps(page);

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'launch-failed' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('resolveChromium が fail したら launchChromium 未注入の既定経路が chromium-missing を返す（launch-failed に畳まれない）', async () => {
    // M-3/M-5: deps.launchChromium は注入せず既定の defaultLaunchChromium を通しつつ、
    // 実体解決だけ fake に差し替える（process.env を触らない＝環境非依存で pin できる）。
    let called = 0;
    const result = await captureSpecifiedRuns(baseRunsRequest(), {
      resolveChromium: () => {
        called += 1;
        return { ok: false, kind: 'chromium-missing', message: '撮影エンジンが見つかりません（fake）' };
      },
    });

    expect(called).toBe(1);
    expect(result).toMatchObject({ ok: false, kind: 'chromium-missing' });
    expect(result.ok === false && result.message).toContain('fake');
  });

  it('resolveChromium が ok を返せば起動を試み、失敗は launch-failed になる（chromium-missing と区別される）', async () => {
    // 陰性対照: 解決は成功しているので「実体が無い」ではなく「起動に失敗した」に落ちる。
    const result = await captureSpecifiedRuns(baseRunsRequest(), {
      resolveChromium: () => ({ ok: true, bin: '/definitely/does/not/exist/chrome-headless-shell', source: 'env' }),
    });

    expect(result).toMatchObject({ ok: false, kind: 'launch-failed' });
  });

  it('2本目の writeFile が失敗したら write-failed に写り、1本目の書き出し済み PNG を削除する', async () => {
    const a = solidPng(W, H, [10, 20, 30, 255]);
    const b = solidPng(W, H, [200, 0, 0, 255]);
    const { page } = makePage([a, b]);
    const { deps, writes, unlinks } = makeDeps(page, { writeFileFailsOnCall: 2 });

    const result = await captureSpecifiedRuns(baseRunsRequest(), deps);

    expect(result).toMatchObject({ ok: false, kind: 'write-failed' });
    expect(writes).toHaveLength(1);
    expect(unlinks).toEqual(writes.map((w) => w.path));
  });

  it('mkdir が throw したら write-failed に写る（screenshot 済みでもファイルは残らない）', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page } = makePage([solo]);
    const { deps, writes, unlinks } = makeDeps(page, { mkdirThrows: true });

    const result = await captureSpecifiedRuns(
      baseRunsRequest({ runs: [{ representativeFrame: 0, startFrame: 0, endFrame: 1 }] }),
      deps,
    );

    expect(result).toMatchObject({ ok: false, kind: 'write-failed' });
    expect(writes).toHaveLength(0);
    expect(unlinks).toHaveLength(0);
  });

  it('close() が throw しても、既に確定した成功結果を握り潰さない', async () => {
    const solo = solidPng(W, H, [1, 2, 3, 255]);
    const { page } = makePage([solo]);
    const { deps, closeSpy } = makeDeps(page, { closeThrows: true });

    const result = await captureSpecifiedRuns(
      baseRunsRequest({ runs: [{ representativeFrame: 0, startFrame: 0, endFrame: 1 }] }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
