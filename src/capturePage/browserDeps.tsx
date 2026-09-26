/**
 * 撮影ページの deps 配線（M2b T2・R2/R4 修正）。
 *
 * protocol.ts（判断・状態遷移）と React/DOM の間をつなぐ層。entry.tsx から分離して
 * jsdom で実 React ごとテストできるようにしてある（R1/R5 の欠陥を素通しさせた根本は
 * ここに単体テストが無かったこと）。
 *
 * コミット ACK の方式（設計判断2の「確実な方式」の選定）:
 *   root.render() を **flushSync** で包み、ツリー内の `useLayoutEffect` から tick を報告する。
 *   - flushSync: React 18 の並行スケジューラを迂回して同期的にレンダ→コミットまで進める。
 *     戻った時点でコミットは完了しており、時間で待つ必要がない。
 *   - useLayoutEffect: コミットフェーズ内で同期実行されるため「本当にこの tick がコミット
 *     された」ことの積極的な合図になる（useEffect（passive）は後段の別タスクへ回されうる）。
 *     tick は単調増加なので、同じフレームを再指定しても bailout で ACK が来なくなることがない。
 *   - 描画例外は ErrorBoundary が捕捉し（getDerivedStateFromError で状態を確定させてから
 *     componentDidCatch で通知）、flushSync から戻った直後に投げ直す。
 */
import React, { useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { CaptureFrameProvider, setStaticFileResolver } from './runtimeFace';
import { createAssetResolver } from './staticFileResolver';
import { renderCaptureLayer, type LoadedComponents } from './layers';
import type { CaptureControllerDeps, CaptureSpec, CaptureView } from './protocol';
import type { TelopComponent } from '../preview/loadTelopComponent';
import type { InsertImageComponent } from '../preview/loadInsertImageComponent';
import { loadCaptureTelop, loadCaptureImage } from './loadComponent';
import { applyLegacyCaptionFont } from '../preview/legacyCaptionFont';

/** コミット ACK（コミットフェーズ内で同期実行される useLayoutEffect）。 */
function CommitSignal({ tick, onCommit }: { tick: number; onCommit: (tick: number) => void }): null {
  useLayoutEffect(() => {
    onCommit(tick);
  }, [tick, onCommit]);
  return null;
}

interface BoundaryProps {
  tick: number;
  onError: (err: unknown) => void;
  children: React.ReactNode;
}
interface BoundaryState {
  tick: number;
  caught: boolean;
}

/**
 * 描画例外を捕捉して種別付きで返せるようにする（設計判断7: 黙って空レンダしない）。
 *
 * getDerivedStateFromError で**状態を確定させる**のが要点。null を返すと React は
 * 「この境界は状態を更新しない」とみなし、componentDidCatch まで到達しない
 * （= 例外が観測されないまま握り潰される）。R2 で実測して修正した。
 *
 * tick が変われば失敗状態を解除する（毎 tick の再マウントは <img> の再読込を招くため
 * key ではなく props 由来のリセットにする）。
 */
export class CaptureErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { tick: props.tick, caught: false };
  }
  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { caught: true };
  }
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): BoundaryState | null {
    if (props.tick !== state.tick) return { tick: props.tick, caught: false };
    return null;
  }
  override componentDidCatch(err: unknown): void {
    this.props.onError(err);
  }
  override render(): React.ReactNode {
    return this.state.caught ? null : this.props.children;
  }
}

export function CaptureTree({
  view,
  loaded,
  onCommit,
  onError,
}: {
  view: CaptureView;
  loaded: LoadedComponents;
  onCommit: (tick: number) => void;
  onError: (err: unknown) => void;
}): React.ReactElement {
  return (
    <CaptureFrameProvider frame={view.frame} videoConfig={view.spec.videoConfig}>
      <CommitSignal tick={view.tick} onCommit={onCommit} />
      <CaptureErrorBoundary tick={view.tick} onError={onError}>
        {renderCaptureLayer(view.spec, loaded)}
      </CaptureErrorBoundary>
    </CaptureFrameProvider>
  );
}

/**
 * 非同期例外の捕まえ役（R4）。React の描画スタックの外（画像の onload ハンドラ・
 * 未処理の Promise 拒否など）で落ちた例外は、放っておくと「フレームが欠けたまま
 * ok:true」になる。ここで溜めて、次の応答に kind:'async-error' として載せる。
 */
export interface AsyncErrorTrap {
  take(): unknown | null;
  dispose(): void;
}

export function installAsyncErrorTrap(target: Window): AsyncErrorTrap {
  let pending: unknown = null;
  const onError = (event: ErrorEvent): void => {
    pending ??= event.error ?? new Error(event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    pending ??= event.reason ?? new Error('unhandledrejection（理由なし）');
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  return {
    take(): unknown | null {
      const err = pending;
      pending = null;
      return err;
    },
    dispose(): void {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection as EventListener);
    },
  };
}

export interface BrowserCaptureDepsOptions {
  container: HTMLElement;
  /** 撮影対象部品のロード（テストでは差し替える）。 */
  loadTelop?: (projectId: string) => Promise<TelopComponent>;
  loadInsertImage?: (projectId: string) => Promise<InsertImageComponent>;
  /** 非同期例外の捕まえ役（既定は window に仕掛ける）。 */
  asyncErrors?: AsyncErrorTrap;
  /** decode 対象の <img> 収集（既定は document.images）。 */
  collectImages?: () => HTMLImageElement[];
}

/** 撮影ページ用の deps 一式を作る。 */
export function createBrowserCaptureDeps(options: BrowserCaptureDepsOptions): CaptureControllerDeps {
  const {
    container,
    loadTelop = loadCaptureTelop,
    loadInsertImage = loadCaptureImage,
    asyncErrors,
    collectImages = () => Array.from(document.images),
  } = options;

  const loaded: LoadedComponents = { Telop: null, InsertImage: null };
  /** tick → ACK 解決関数。解決したら必ず消す（溜め込まない）。 */
  const pendingCommits = new Map<number, () => void>();
  /** ACK が待ち受けより先に来た場合の受け皿。1件だけ持ち、消費したら消す。 */
  let committedAhead: number | null = null;
  let renderError: unknown = null;
  let root: Root | null = null;
  let restoreCaptionFonts: () => void = () => {};

  function onCommit(tick: number): void {
    const resolve = pendingCommits.get(tick);
    if (resolve !== undefined) {
      pendingCommits.delete(tick);
      resolve();
      return;
    }
    committedAhead = tick;
  }

  function onError(err: unknown): void {
    renderError = err;
  }

  function ensureRoot(): Root {
    root ??= createRoot(container);
    return root;
  }

  return {
    async prepare(spec: CaptureSpec): Promise<void> {
      setStaticFileResolver(createAssetResolver(spec.projectId));
      // M2c T3: 'telop-title'（telop+title 統合レイヤ）は CaptureTelopTitleLayer 経由で
      // Telop 部品を要求する（renderCaptureLayer の telop-title 分岐と同じ契約）。
      if (spec.layer === 'telop' || spec.layer === 'telop-title') {
        loaded.Telop = await loadTelop(spec.projectId);
      } else if (spec.layer === 'image') {
        loaded.InsertImage = await loadInsertImage(spec.projectId);
      }
    },

    render(view: CaptureView): void {
      restoreCaptionFonts(); restoreCaptionFonts = () => {};
      renderError = null;
      const target = ensureRoot();
      flushSync(() => {
        target.render(
          <CaptureTree view={view} loaded={loaded} onCommit={onCommit} onError={onError} />,
        );
      });
      if (renderError !== null) {
        const err = renderError;
        renderError = null;
        throw err;
      }
      const cleanups = Array.from(container.querySelectorAll('[data-sme-kind="telop"]')).map(applyLegacyCaptionFont);
      restoreCaptionFonts = () => cleanups.forEach(cleanup => cleanup());
    },

    waitForCommit(tick: number): Promise<void> {
      if (committedAhead === tick) {
        committedAhead = null;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        // timeout で打ち切られた過去 tick の resolve が残留しないよう、
        // 新しい待ち受けを登録するタイミングで古い entry を掃除する
        // （resolve されない Promise が残るだけで実害はないが、Map を有界に保つ）。
        for (const key of pendingCommits.keys()) {
          if (key < tick) pendingCommits.delete(key);
        }
        pendingCommits.set(tick, resolve);
      });
    },

    requestAnimationFrame(callback: () => void): void {
      window.requestAnimationFrame(() => callback());
    },

    async waitForFonts(): Promise<void> {
      // Chromium には必ずある。jsdom 等 FontFaceSet 非対応の環境では待つものが無いので
      // 素通しする（撮影の実機は Chromium なので実運用では常に待つ側を通る）。
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts === undefined) return;
      await fonts.ready;
    },

    /** 全 <img> の decode() 完了待ち。1枚でも失敗したら fail-loud（M2a 申し送り）。 */
    async decodeImages(): Promise<void> {
      await Promise.all(collectImages().map((img) => img.decode()));
    },

    takeAsyncError(): unknown | null {
      return asyncErrors?.take() ?? null;
    },
  };
}
