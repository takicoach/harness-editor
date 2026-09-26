/**
 * @vitest-environment jsdom
 *
 * フレーム制御プロトコル（window.__capture）の状態機械 pin（M2b T2・設計判断2/7）。
 *
 * 実 React / 実ブラウザに依存しないよう、描画・コミットACK・rAF・fonts.ready・
 * img.decode() を deps として注入し、順序と失敗種別だけをここで固定する。
 * 実ブラウザ側の配線（flushSync + commit effect + document.fonts + <img>.decode）は
 * entry.tsx が担い、実機検証は T3/T4 の守備範囲。
 */
import { describe, expect, it } from 'vitest';
import { classifyRenderError, createCaptureController, type CaptureControllerDeps } from './protocol';

const SPEC = {
  layer: 'telop' as const,
  projectId: 'p1',
  videoConfig: { width: 1080, height: 1920, fps: 30, durationInFrames: 300 },
  data: { telops: [{ id: 1, startFrame: 0, endFrame: 60, text: 'テスト' }] },
};

interface Harness {
  deps: CaptureControllerDeps;
  log: string[];
}

function makeHarness(overrides: Partial<CaptureControllerDeps> = {}): Harness {
  const log: string[] = [];
  let rafCalls = 0;
  const deps: CaptureControllerDeps = {
    render: (view) => {
      log.push(`render:${view.frame}:${view.tick}`);
    },
    waitForCommit: async (tick) => {
      log.push(`commit:${tick}`);
    },
    requestAnimationFrame: (cb) => {
      rafCalls += 1;
      log.push(`raf:${rafCalls}`);
      setTimeout(cb, 0);
    },
    waitForFonts: async () => {
      log.push('fonts');
    },
    decodeImages: async () => {
      log.push('decode');
    },
    ...overrides,
  };
  return { deps, log };
}

describe('createCaptureController', () => {
  it('init 前の setFrame は not-initialized で拒否する（黙って成功しない）', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    const result = await c.setFrame(3);
    expect(result).toEqual({ ok: false, kind: 'not-initialized', message: expect.any(String) });
    expect(h.log).toEqual([]);
  });

  it('init は 描画→コミットACK→fonts.ready→img.decode の順に待つ', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    const result = await c.init(SPEC);
    expect(result).toEqual({ ok: true });
    expect(h.log).toEqual(['render:0:1', 'commit:1', 'fonts', 'decode']);
  });

  it('setFrame は コミットACK の後に rAF を必ず2回まわしてから resolve する', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    h.log.length = 0;
    const result = await c.setFrame(42);
    expect(result).toEqual({ ok: true });
    expect(h.log).toEqual(['render:42:2', 'commit:2', 'fonts', 'decode', 'raf:1', 'raf:2']);
  });

  it('同じフレームを2回指定しても tick が進み、コミットACK と rAF×2 が再実行される', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    await c.setFrame(7);
    h.log.length = 0;
    await c.setFrame(7);
    // raf の番号は累積（1回目の setFrame で 1,2 を使い切っている）。
    expect(h.log).toEqual(['render:7:3', 'commit:3', 'fonts', 'decode', 'raf:3', 'raf:4']);
  });

  it('captureRuntime: 接頭辞の throw は capture-runtime-unsupported で返す', async () => {
    const h = makeHarness({
      render: () => {
        throw new Error('captureRuntime Sequence: 未対応の props です（premountFor）。');
      },
    });
    const c = createCaptureController(h.deps);
    const result = await c.init(SPEC);
    expect(result).toEqual({
      ok: false,
      kind: 'capture-runtime-unsupported',
      message: expect.stringContaining('premountFor'),
    });
  });

  it('それ以外の描画例外は render-error で返す', async () => {
    // init は成功させ、以降のフレームだけ描画が壊れる状況（実際に起きるのはこの形）。
    let broken = false;
    const h = makeHarness({
      render: () => {
        if (broken) throw new Error('Cannot read properties of undefined');
      },
    });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    broken = true;
    const result = await c.setFrame(1);
    expect(result).toEqual({ ok: false, kind: 'render-error', message: expect.any(String) });
  });

  it('M-2: videoConfig の数値が非有限・0以下なら invalid-spec で拒否する', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const result = await c.init({
        ...SPEC,
        videoConfig: { ...SPEC.videoConfig, width: bad },
      });
      expect(result).toMatchObject({ ok: false, kind: 'invalid-spec' });
    }
  });

  it('img.decode() の失敗は fail-loud（asset-decode-failed）で init を失敗させる', async () => {
    const h = makeHarness({
      decodeImages: async () => {
        throw new Error('The source image cannot be decoded.');
      },
    });
    const c = createCaptureController(h.deps);
    const result = await c.init(SPEC);
    expect(result).toEqual({
      ok: false,
      kind: 'asset-decode-failed',
      message: expect.stringContaining('decoded'),
    });
    // 初期化に失敗したら setFrame も通さない（空フレームを撮らせない）。
    expect(await c.setFrame(1)).toMatchObject({ ok: false, kind: 'not-initialized' });
  });

  it('setFrame は 描画→コミットACK→fonts→img.decode→rAF×2 の順で待つ', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    h.log.length = 0;
    const result = await c.setFrame(42);
    expect(result).toEqual({ ok: true });
    expect(h.log).toEqual(['render:42:2', 'commit:2', 'fonts', 'decode', 'raf:1', 'raf:2']);
  });

  it('setFrame の font 失敗は撮影ACKを返さず、修復後の再要求を受け付ける', async () => {
    let failed = false;
    const h = makeHarness({ waitForFonts: async () => { if (failed) throw new Error('late font failed'); } });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    failed = true; h.log.length = 0;
    expect(await c.setFrame(20)).toMatchObject({ ok: false, kind: 'font-load-failed' });
    expect(h.log).toEqual(['render:20:2', 'commit:2']);
    failed = false;
    expect(await c.setFrame(20)).toEqual({ ok: true });
  });

  it('setFrame の font 待ちは fontsMs で終了し、待機中の次要求は busy とする', async () => {
    let pending = false;
    const h = makeHarness({ waitForFonts: () => pending ? new Promise(() => {}) : Promise.resolve(), timeouts: { fontsMs: 20 } });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    pending = true; h.log.length = 0;
    const waiting = c.setFrame(20);
    expect(await c.setFrame(21)).toMatchObject({ ok: false, kind: 'busy' });
    expect(await waiting).toMatchObject({ ok: false, kind: 'timeout', message: expect.stringContaining('document.fonts.ready') });
    expect(h.log).toEqual(['render:20:2', 'commit:2']);
    pending = false;
    expect(await c.setFrame(21)).toEqual({ ok: true });
  });

  it('C-1: setFrame 中の img.decode() 失敗は fail-loud（asset-decode-failed）で返す（init 済みでも黙殺しない）', async () => {
    let frameFails = false;
    const h = makeHarness({
      decodeImages: async () => {
        if (frameFails) throw new Error('The source image cannot be decoded.');
      },
    });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    frameFails = true;
    const result = await c.setFrame(20);
    expect(result).toEqual({
      ok: false,
      kind: 'asset-decode-failed',
      message: expect.stringContaining('decoded'),
    });
  });

  it('C-1: setFrame の decode がタイムアウトすれば timeout で返す', async () => {
    const NEVER = new Promise<void>(() => {});
    let frameHangs = false;
    const h = makeHarness({
      decodeImages: () => (frameHangs ? NEVER : Promise.resolve()),
      timeouts: { decodeMs: 20 },
    });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    frameHangs = true;
    expect(await c.setFrame(1)).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('prepare は描画より前に1回だけ走る（init のみ・setFrame では走らない）', async () => {
    const h = makeHarness({
      prepare: async () => {
        h.log.push('prepare');
      },
    });
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    expect(h.log).toEqual(['prepare', 'render:0:1', 'commit:1', 'fonts', 'decode']);
    h.log.length = 0;
    await c.setFrame(1);
    expect(h.log).not.toContain('prepare');
  });

  it('prepare の失敗は component-load-failed で返す', async () => {
    const h = makeHarness({
      prepare: async () => {
        throw new Error('テロップ部品を読み込めませんでした');
      },
    });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toMatchObject({
      ok: false,
      kind: 'component-load-failed',
      message: 'テロップ部品を読み込めませんでした',
    });
    expect(h.log).toEqual([]);
  });

  it('fonts.ready の失敗は font-load-failed で返す', async () => {
    const h = makeHarness({
      waitForFonts: async () => {
        throw new Error('font timeout');
      },
    });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toMatchObject({ ok: false, kind: 'font-load-failed' });
  });

  it('負数・非整数・非有限のフレームは invalid-frame で拒否する', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    h.log.length = 0;
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await c.setFrame(bad)).toMatchObject({ ok: false, kind: 'invalid-frame' });
    }
    expect(h.log).toEqual([]);
  });

  it('init は再実行でき、2回目のフレームは初期フレームから始まる', async () => {
    const h = makeHarness();
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    await c.setFrame(5);
    h.log.length = 0;
    expect(await c.init({ ...SPEC, initialFrame: 12 })).toEqual({ ok: true });
    expect(h.log).toEqual(['render:12:3', 'commit:3', 'fonts', 'decode']);
  });
});

describe('時限（タイムアウト）— 唯一の観測不能な失敗形を塞ぐ', () => {
  const NEVER = new Promise<void>(() => {});

  it('コミット ACK が返らなければ timeout で返す（永久に待たない）', async () => {
    const h = makeHarness({ waitForCommit: () => NEVER, timeouts: { commitMs: 20 } });
    const c = createCaptureController(h.deps);
    const result = await c.init(SPEC);
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
    expect((result as { message: string }).message).toContain('コミット ACK');
  });

  it('fonts.ready が返らなければ timeout', async () => {
    const h = makeHarness({ waitForFonts: () => NEVER, timeouts: { fontsMs: 20 } });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('decode が返らなければ timeout', async () => {
    const h = makeHarness({ decodeImages: () => NEVER, timeouts: { decodeMs: 20 } });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('rAF が来なければ setFrame は timeout（不可視タブ等で止まるケース）', async () => {
    const h = makeHarness({ timeouts: { frameMs: 20 } });
    const c = createCaptureController(h.deps);
    await c.init(SPEC);
    // init 後に rAF を沈黙させる（init は rAF を使わないので順序の影響を受けない）。
    h.deps.requestAnimationFrame = () => {};
    expect(await c.setFrame(1)).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('時限内に返れば当然 ok（時限そのものが誤検知しないことの対照）', async () => {
    const h = makeHarness({ timeouts: { commitMs: 200, fontsMs: 200, decodeMs: 200, frameMs: 200 } });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    expect(await c.setFrame(1)).toEqual({ ok: true });
  });
});

describe('直列化（busy）', () => {
  it('前の呼び出しが終わる前の setFrame は busy で即返る（ACK の取り違えを防ぐ）', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const h = makeHarness({
      // 1回目の ACK だけ手動で解放する（2回目以降は即座に返す）。
      waitForCommit: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const c = createCaptureController(h.deps);
    const first = c.init(SPEC);
    // 1回目が ACK 待ちで止まっている間に重ねて呼ぶ。
    expect(await c.setFrame(1)).toMatchObject({ ok: false, kind: 'busy' });
    expect(await c.init(SPEC)).toMatchObject({ ok: false, kind: 'busy' });
    release?.();
    expect(await first).toEqual({ ok: true });
    // 解放後は通る。
    expect(await c.setFrame(1)).toEqual({ ok: true });
  });
});

describe('非同期例外（window.onerror / unhandledrejection）', () => {
  it('コミット後に非同期例外が溜まっていれば async-error で返す', async () => {
    let asyncErr: unknown = null;
    const h = makeHarness({ takeAsyncError: () => { const e = asyncErr; asyncErr = null; return e; } });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toEqual({ ok: true });
    asyncErr = new Error('画像の onload で落ちた');
    expect(await c.setFrame(1)).toMatchObject({ ok: false, kind: 'async-error', message: '画像の onload で落ちた' });
    expect(await c.setFrame(2)).toEqual({ ok: true });
  });

  it('init 中の非同期例外も init を失敗させる（初期化済みにしない）', async () => {
    const h = makeHarness({ takeAsyncError: () => new Error('init 中に落ちた') });
    const c = createCaptureController(h.deps);
    expect(await c.init(SPEC)).toMatchObject({ ok: false, kind: 'async-error' });
    expect(await c.setFrame(1)).toMatchObject({ ok: false, kind: 'not-initialized' });
  });
});

describe('classifyRenderError', () => {
  it('captureRuntime 接頭辞を種別へ写像する', () => {
    expect(classifyRenderError(new Error('captureRuntime staticFile: リゾルバ未設定です'))).toBe(
      'capture-runtime-unsupported',
    );
    expect(classifyRenderError(new Error('captureRuntime Sequence: ...'))).toBe(
      'capture-runtime-unsupported',
    );
    expect(classifyRenderError(new Error('boom'))).toBe('render-error');
    expect(classifyRenderError('boom')).toBe('render-error');
  });
});

describe('installCaptureApi', () => {
  it('window.__capture に init/setFrame を公開する', async () => {
    const { installCaptureApi } = await import('./protocol');
    const h = makeHarness();
    const controller = createCaptureController(h.deps);
    installCaptureApi(window as unknown as Record<string, unknown>, controller);
    const api = (window as unknown as Record<string, unknown>)['__capture'] as {
      init: (spec: unknown) => Promise<unknown>;
      setFrame: (n: number) => Promise<unknown>;
    };
    expect(typeof api.init).toBe('function');
    expect(typeof api.setFrame).toBe('function');
    expect(await api.init(SPEC)).toEqual({ ok: true });
    expect(await api.setFrame(1)).toEqual({ ok: true });
  });
});
