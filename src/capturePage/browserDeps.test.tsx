/**
 * @vitest-environment jsdom
 *
 * 撮影ページの React/DOM 配線の pin（R1/R2/R4 修正・entry.tsx に単体テストが1本も
 * 無かったことが欠陥を素通しさせた根本なので、配線層を分離してここで実 React ごと検証する）。
 *
 * 'remotion' の差し替えは撮影ページの importmap と同じ構造（captureRuntime バレルへ解決）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('remotion', async () => await import('../captureRuntime'));

const { createBrowserCaptureDeps, installAsyncErrorTrap } = await import('./browserDeps');
const { createCaptureController } = await import('./protocol');
const { staticFile, setStaticFileResolver } = await import('../captureRuntime');
import type { CaptureSpec } from './protocol';
import type { TelopComponent } from '../preview/loadTelopComponent';

const VIDEO_CONFIG = { width: 1080, height: 1920, fps: 30, durationInFrames: 300 };
const TELOPS = [{ id: 1, startFrame: 0, endFrame: 60, text: 'てすと' }];

function specOf(overrides: Partial<CaptureSpec> = {}): CaptureSpec {
  return {
    layer: 'telop',
    projectId: 'p1',
    videoConfig: VIDEO_CONFIG,
    data: { telops: TELOPS },
    ...overrides,
  };
}

let container: HTMLElement;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'capture-root';
  document.body.appendChild(container);
  // React の ErrorBoundary は捕捉した例外を console.error へ出す（想定内なので黙らせる）。
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  container.remove();
  setStaticFileResolver(null);
});

const OK_TELOP: TelopComponent = ({ segment }) => (
  <span data-testid="telop">{(segment as { text: string }).text}</span>
);

function depsFor(overrides: Parameters<typeof createBrowserCaptureDeps>[0] | null = null) {
  return createBrowserCaptureDeps(
    overrides ?? { container, loadTelop: async () => OK_TELOP },
  );
}

describe('createBrowserCaptureDeps — 描画とコミット ACK', () => {
  it('render 後に waitForCommit が解決し、DOM にレイヤが出る', async () => {
    const deps = depsFor();
    await deps.prepare?.(specOf());
    deps.render({ spec: specOf(), frame: 10, tick: 1 });
    await expect(deps.waitForCommit(1)).resolves.toBeUndefined();
    expect(container.textContent).toContain('てすと');
  });

  it('コントローラ経由で init → setFrame が通り、フレームが反映される', async () => {
    const frames: number[] = [];
    const Probe: TelopComponent = ({ segment }) => {
      frames.push((segment as { startFrame: number }).startFrame);
      return <span data-testid="telop">x</span>;
    };
    const controller = createCaptureController(
      createBrowserCaptureDeps({ container, loadTelop: async () => Probe }),
    );
    expect(await controller.init(specOf())).toEqual({ ok: true });
    expect(await controller.setFrame(20)).toEqual({ ok: true });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(await controller.setFrame(70)).toEqual({ ok: true });
    // 70 は表示区間外（endFrame=60 排他）なので描かれない。
    expect(container.querySelector('[data-testid="telop"]')).toBeNull();
  });
});

describe('prepare — telop-title（統合レイヤ）は telop と同じく Telop 部品をロードする（M2c T3）', () => {
  it('layer:"telop-title" でも loadTelop が呼ばれ、telop・title の両方が描かれる', async () => {
    const titles = [{ id: 2, startFrame: 0, endFrame: 60, text: 'たいとる' }];
    const spec = specOf({ layer: 'telop-title', data: { telops: TELOPS, titles } });
    const controller = createCaptureController(
      createBrowserCaptureDeps({ container, loadTelop: async () => OK_TELOP }),
    );
    expect(await controller.init(spec)).toEqual({ ok: true });
    expect(container.querySelector('[data-testid="telop"]')?.textContent).toBe('てすと');
    expect(container.textContent).toContain('たいとる');
  });

  it('Telop 未ロード（loadTelop が throw）は component-load-failed（未ロードのまま黙って描かない）', async () => {
    const controller = createCaptureController(
      createBrowserCaptureDeps({
        container,
        loadTelop: async () => {
          throw new Error('テロップパック読み込み失敗（テスト）');
        },
      }),
    );
    const titles = [{ id: 2, startFrame: 0, endFrame: 60, text: 'たいとる' }];
    expect(
      await controller.init(specOf({ layer: 'telop-title', data: { telops: TELOPS, titles } })),
    ).toMatchObject({ ok: false, kind: 'component-load-failed' });
  });
});

describe('CaptureErrorBoundary — 描画例外の捕捉（R2）', () => {
  const BOOM = 'テロップ部品が壊れています';
  const Broken: TelopComponent = () => {
    throw new Error(BOOM);
  };

  it('描画中の例外は render() から同期 throw される（握り潰さない）', async () => {
    const deps = createBrowserCaptureDeps({ container, loadTelop: async () => Broken });
    await deps.prepare?.(specOf());
    expect(() => deps.render({ spec: specOf(), frame: 0, tick: 1 })).toThrow(BOOM);
  });

  it('コントローラは render-error 種別で返す', async () => {
    const controller = createCaptureController(
      createBrowserCaptureDeps({ container, loadTelop: async () => Broken }),
    );
    expect(await controller.init(specOf())).toMatchObject({ ok: false, kind: 'render-error' });
  });

  it('captureRuntime: 接頭辞の例外は capture-runtime-unsupported として返る', async () => {
    const Unsupported: TelopComponent = () => {
      throw new Error('captureRuntime Sequence: 未対応の props です（premountFor）。');
    };
    const controller = createCaptureController(
      createBrowserCaptureDeps({ container, loadTelop: async () => Unsupported }),
    );
    expect(await controller.init(specOf())).toMatchObject({
      ok: false,
      kind: 'capture-runtime-unsupported',
    });
  });

  it('例外の後に正常なフレームを描けば復帰する（失敗状態が tick で解除される）', async () => {
    let broken = true;
    const Flaky: TelopComponent = ({ segment }) => {
      if (broken) throw new Error(BOOM);
      return <span data-testid="telop">{(segment as { text: string }).text}</span>;
    };
    const controller = createCaptureController(
      createBrowserCaptureDeps({ container, loadTelop: async () => Flaky }),
    );
    expect(await controller.init(specOf())).toMatchObject({ ok: false, kind: 'render-error' });
    broken = false;
    expect(await controller.init(specOf())).toEqual({ ok: true });
    expect(container.textContent).toContain('てすと');
  });
});

describe('decodeImages — fail-loud（M2a 申し送り）', () => {
  it('1枚でも decode() が失敗したら asset-decode-failed', async () => {
    const bad = {
      decode: () => Promise.reject(new Error('The source image cannot be decoded.')),
    } as unknown as HTMLImageElement;
    const good = { decode: () => Promise.resolve() } as unknown as HTMLImageElement;
    const controller = createCaptureController(
      createBrowserCaptureDeps({
        container,
        loadTelop: async () => OK_TELOP,
        collectImages: () => [good, bad],
      }),
    );
    expect(await controller.init(specOf())).toMatchObject({
      ok: false,
      kind: 'asset-decode-failed',
    });
  });

  it('全部成功すれば init は通る', async () => {
    const good = { decode: () => Promise.resolve() } as unknown as HTMLImageElement;
    const controller = createCaptureController(
      createBrowserCaptureDeps({
        container,
        loadTelop: async () => OK_TELOP,
        collectImages: () => [good, good],
      }),
    );
    expect(await controller.init(specOf())).toEqual({ ok: true });
  });
});

describe('installAsyncErrorTrap（R4）', () => {
  it('window の error イベントを1件ずつ取り出せる', () => {
    const trap = installAsyncErrorTrap(window);
    expect(trap.take()).toBeNull();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('非同期で落ちた') }));
    expect((trap.take() as Error).message).toBe('非同期で落ちた');
    // 取り出したら消える（同じ失敗を二重に報告しない）。
    expect(trap.take()).toBeNull();
    trap.dispose();
  });

  it('dispose 後は拾わない', () => {
    const trap = installAsyncErrorTrap(window);
    trap.dispose();
    // 誰も拾わない error イベントは jsdom が「未捕捉」として報告するため、
    // このテストでは既定動作だけ止める（trap が拾わないことの検査は下の take()）。
    window.addEventListener('error', (e) => e.preventDefault(), { once: true });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('後の祭り') }));
    expect(trap.take()).toBeNull();
  });

  it('非同期例外があると setFrame は async-error で返る（ok:true で欠けたフレームを撮らない）', async () => {
    const trap = installAsyncErrorTrap(window);
    const controller = createCaptureController(
      createBrowserCaptureDeps({ container, loadTelop: async () => OK_TELOP, asyncErrors: trap }),
    );
    expect(await controller.init(specOf())).toEqual({ ok: true });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('画像の onload で落ちた') }));
    expect(await controller.setFrame(5)).toMatchObject({
      ok: false,
      kind: 'async-error',
      message: '画像の onload で落ちた',
    });
    // 消費済みなので次は通る。
    expect(await controller.setFrame(6)).toEqual({ ok: true });
    trap.dispose();
  });
});

describe('prepare — staticFile リゾルバの設定', () => {
  it('init の下準備で staticFile が /api/asset へ解決するようになる', async () => {
    expect(() => staticFile('images/a.png')).toThrow(/リゾルバ未設定/);
    const deps = depsFor();
    await deps.prepare?.(specOf({ projectId: 'proj 1' }));
    expect(staticFile('images/a b.png')).toBe('/api/asset?id=proj%201&path=images%2Fa%20b.png');
  });
});
