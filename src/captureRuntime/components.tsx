/**
 * コンポーネント層（M2a Task3）。'remotion' と同名 export を、監査済み API の範囲だけ
 * 独自実装する（実装から 'remotion' の import は禁止 — 設計判断2）。
 *
 * 対応 API: CaptureFrameProvider（独自）/ useCurrentFrame / useVideoConfig / Sequence /
 * AbsoluteFill / staticFile / Img
 *
 * 挙動の根拠は node_modules/remotion@4.0.489 の実装ソース（コピーではなく読解して自分の
 * 表現で再実装。各関数の doc comment に根拠ファイルを記す）。
 */
import React, {
  createContext,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Frame context（Provider）
// ---------------------------------------------------------------------------

export interface CaptureVideoConfig {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

interface FrameContextValue {
  frame: number; // 撮影ページ/テストが指定する「絶対フレーム」（root 基準）
  videoConfig: CaptureVideoConfig;
}

const FrameContext = createContext<FrameContextValue | null>(null);

export function CaptureFrameProvider({
  frame,
  videoConfig,
  children,
}: {
  frame: number;
  videoConfig: CaptureVideoConfig;
  children?: ReactNode;
}): React.ReactElement {
  const value = useMemo<FrameContextValue>(
    () => ({ frame, videoConfig }),
    [frame, videoConfig],
  );
  return <FrameContext.Provider value={value}>{children}</FrameContext.Provider>;
}

function useFrameContext(): FrameContextValue {
  const ctx = useContext(FrameContext);
  if (!ctx) {
    throw new Error(
      'captureRuntime: useCurrentFrame/useVideoConfig は CaptureFrameProvider の内側でのみ使用できます。',
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Sequence context
// ---------------------------------------------------------------------------

interface SequenceContextValue {
  /** この Sequence の親から積み上がった「絶対フレーム」への起点オフセット */
  cumulatedFrom: number;
  /** この Sequence 自身の from（親からの相対値） */
  relativeFrom: number;
  /**
   * この Sequence 内で useVideoConfig() が返す durationInFrames（実 remotion の
   * actualDurationInFrames 相当 — Sequence.js の algorithm を参照）
   */
  durationInFrames: number;
}

const SequenceContext = createContext<SequenceContextValue | null>(null);

/**
 * 根拠: node_modules/remotion/dist/cjs/use-current-frame.js
 *   contextOffset = context.cumulatedFrom + context.relativeFrom
 *   return frame - contextOffset
 * Sequence の外では contextOffset = 0（= 絶対フレームそのまま）。
 */
export function useCurrentFrame(): number {
  const { frame } = useFrameContext();
  const seq = useContext(SequenceContext);
  const offset = seq ? seq.cumulatedFrom + seq.relativeFrom : 0;
  return frame - offset;
}

/**
 * 根拠: node_modules/remotion/dist/cjs/use-unsafe-video-config.js
 *   durationInFrames: ctxDuration ?? video.durationInFrames
 * （ctxDuration は SequenceContext.durationInFrames）。Sequence の外では
 * Provider に渡した videoConfig をそのまま返す。
 */
export function useVideoConfig(): CaptureVideoConfig {
  const { videoConfig } = useFrameContext();
  const seq = useContext(SequenceContext);
  if (!seq) {
    return videoConfig;
  }
  return { ...videoConfig, durationInFrames: seq.durationInFrames };
}

// ---------------------------------------------------------------------------
// AbsoluteFill
// ---------------------------------------------------------------------------

/**
 * 根拠: node_modules/remotion/dist/cjs/AbsoluteFill.js
 * 既定 style（position:absolute / top,left,right,bottom:0 / width,height:100% /
 * display:flex / flexDirection:column）に呼び出し側 style をスプレッドで上書きする
 * 合成順（呼び出し側が優先）。
 *
 * 対象外: TailwindCSS クラス名検出による既定値の無効化（real remotion にはあるが、
 * このリポジトリの撮影対象コンポーネントは使用しない未使用機能のため実装しない）。
 */
export function AbsoluteFill({
  style,
  children,
  ...rest
}: {
  style?: CSSProperties;
  children?: ReactNode;
} & Record<string, unknown>): React.ReactElement {
  const merged: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    ...style,
  };
  return (
    <div style={merged} {...rest}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

export interface SequenceProps {
  from?: number;
  durationInFrames?: number;
  children?: ReactNode;
  style?: CSSProperties;
  name?: string;
  layout?: 'absolute-fill' | 'none';
}

const SEQUENCE_SUPPORTED_KEYS = new Set(['from', 'durationInFrames', 'children', 'style', 'name', 'layout']);

/**
 * 根拠: node_modules/remotion/dist/cjs/Sequence.js（RegularSequenceRefForwardingFunction）
 *
 * - ローカルフレーム変換・useVideoConfig の durationInFrames 差し替え: SequenceContext 経由
 *   （cumulatedFrom = 親の cumulatedFrom + 親の relativeFrom）
 * - 表示窓: absoluteFrame < cumulatedFrom+from、または
 *   absoluteFrame > ceil(cumulatedFrom+from+durationInFrames-1) では children を描画しない
 *   （M-3訂正: ceil 省略の等価は from・cumulatedFrom・絶対フレームが全て整数であることが
 *   条件。durationInFrames が整数なだけでは足りない — 非整数値が混じると
 *   ceil(x-1) と (x-1) の端数切り上げの有無で境界フレーム1枚分ズレうる。このリポジトリの
 *   実使用ではこれら3値は常に整数のため省略しても等価）
 * - layout 既定 'absolute-fill': children を AbsoluteFill（style = {flexDirection:undefined,
 *   ...style}）で包む。layout='none' は素通し。ただし layout='none' に style を渡すと throw
 *   （real remotion 同様。Sequence.js: `if (layout==='none' && typeof other.style!=='undefined') throw`）
 *
 * 未使用機能（premountFor / postmountFor / freeze / trimBefore 等）は明示 throw。
 */
export function Sequence(props: SequenceProps & Record<string, unknown>): React.ReactElement | null {
  const unsupported = Object.keys(props).filter((key) => !SEQUENCE_SUPPORTED_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `captureRuntime Sequence: 未対応の props です（${unsupported.join(', ')}）。M2a では from/durationInFrames/style/name/layout のみ対応。`,
    );
  }

  const { from = 0, durationInFrames = Infinity, children, style, layout = 'absolute-fill' } = props;

  if (durationInFrames <= 0) {
    throw new Error(`captureRuntime Sequence: durationInFrames must be positive, but got ${durationInFrames}`);
  }

  // 根拠: Sequence.js — `if (layout === 'none' && typeof other.style !== 'undefined') throw`
  if (layout === 'none' && style !== undefined) {
    throw new TypeError(
      `captureRuntime Sequence: layout="none" のとき style は渡せません（real remotion 同様）。Passed: ${JSON.stringify(style)}`,
    );
  }

  const { frame: rootFrame } = useFrameContext();
  const parent = useContext(SequenceContext);
  const scopedVideoConfig = useVideoConfig(); // 親 Sequence の文脈で評価される（Context override 込み）

  const cumulatedFrom = parent ? parent.cumulatedFrom + parent.relativeFrom : 0;
  const parentSequenceDuration = parent
    ? Math.min(parent.durationInFrames - from, durationInFrames)
    : durationInFrames;
  const actualDurationInFrames = Math.max(
    0,
    Math.min(scopedVideoConfig.durationInFrames - from, parentSequenceDuration),
  );

  const windowStart = cumulatedFrom + from;
  const windowEnd = windowStart + durationInFrames; // durationInFrames=Infinity なら上限なし
  const visible = rootFrame >= windowStart && rootFrame < windowEnd;

  const contextValue = useMemo<SequenceContextValue>(
    () => ({ cumulatedFrom, relativeFrom: from, durationInFrames: actualDurationInFrames }),
    [cumulatedFrom, from, actualDurationInFrames],
  );

  if (!visible) {
    return null;
  }

  const content =
    layout === 'none' ? (
      <>{children}</>
    ) : (
      <AbsoluteFill style={{ flexDirection: undefined, ...style }}>{children}</AbsoluteFill>
    );

  return <SequenceContext.Provider value={contextValue}>{content}</SequenceContext.Provider>;
}

// ---------------------------------------------------------------------------
// staticFile（設計判断4: リゾルバ注入式・未設定時は明示throw）
// ---------------------------------------------------------------------------

type StaticFileResolver = (path: string) => string;

let staticFileResolver: StaticFileResolver | null = null;

export function setStaticFileResolver(fn: StaticFileResolver | null): void {
  staticFileResolver = fn;
}

/**
 * I-4: real remotion の staticFile 正規化契約（撮影ページ側リゾルバが実装する責務）。
 *
 * 根拠: node_modules/remotion/dist/cjs/static-file.js。real の staticFile は次を行う:
 *   1. 先頭スラッシュを除去してから public/ 相対パスとして扱う
 *   2. パスをセグメント単位で分割し、各セグメントを encodeURIComponent する
 *      （素材パスに空白や # を含むと未エンコードの単純結合では URL が食い違う）
 *   3. http(s):// で始まるリモート URL は TypeError で拒否する（real の static-file.js 冒頭と同じ。
 *      リモート URL は staticFile() に渡さずそのまま使う運用が正）
 *   4. `../` 等の相対パス（親ディレクトリへの脱出）は拒否する
 *
 * captureRuntime の staticFile 自体はこの正規化を実装しない（設計判断4: リゾルバ注入式）。
 * 撮影ページ（M2b）が setStaticFileResolver() に渡す関数がこの契約を満たす責務を負う。
 */
export function staticFile(path: string): string {
  if (!staticFileResolver) {
    throw new Error(
      'captureRuntime staticFile: リゾルバ未設定です。撮影ページが setStaticFileResolver() を呼ぶ契約（設計判断4）。',
    );
  }
  return staticFileResolver(path);
}

// ---------------------------------------------------------------------------
// Img（設計判断5: <img> そのまま。読み込み待ちは撮影契約側の責務）
// ---------------------------------------------------------------------------

/**
 * real remotion の Img はフレーム進行を止める保証（デコード完了までブロック）を持つが、
 * captureRuntime ではその保証を提供しない。撮影方式では、ページ側が各フレーム描画後に
 * img の decode() 完了を待ってからキャプチャする（M2b の撮影契約側の責務）。
 *
 * I-5: decode() 失敗時の契約。real remotion の Img は onError + delayRender の
 * maxRetries を尽くしても解決しない場合、cancelRender で失敗を顕在化する（黙って
 * 空フレーム/壊れた画像のまま焼き込むことをしない — fail-loud）。captureRuntime も
 * 同じ方針を踏襲する: 撮影ページ側の decode() 待ちが失敗（reject/timeout）したら、
 * 撮影を fail-loud で中断し Remotion 経路へ退避する。空フレームを黙って焼き込む
 * フォールバックは許容しない（M2b の撮影契約設計で decode() 失敗時のハンドリングを実装）。
 */
export function Img({
  src,
  style,
  ...rest
}: {
  src: string;
  style?: CSSProperties;
} & Record<string, unknown>): React.ReactElement {
  return <img src={src} style={style} {...rest} />;
}
