import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from '@harness/frame-runtime';
import { ClassicOutline } from './styles/ClassicOutline';
import { BlackBar } from './styles/BlackBar';
import { WhiteBar } from './styles/WhiteBar';
// <<< TP5 共有式の配線ここから
import { packLegacyTelopAnimationFrame } from './telopLegacyAnimation';
// >>> TP5 共有式の配線ここまで

// id 1..3 の順（manifest と一致）。index 0 = id 1。
const STYLES = [ClassicOutline, BlackBar, WhiteBar];

/** テロップの正規化位置（フレーム中心が原点・係数 50%＝x=1 で中心からフレーム端）。 */
interface TelopPosition {
  x: number;
  y: number;
}

/** 2点アニメの端点状態（Harness Editor の core/motion と同スキーマ）。 */
interface MotionState {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
}

/** キーフレーム 1 点（t は表示区間内の進行度 0..1）。 */
interface MotionKey extends MotionState {
  t: number;
}

/** 2点アニメ／キーフレーム指定（telopData.ts の motion フィールド）。 */
interface Motion {
  preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom' | 'keyframes';
  intensity?: number;
  from?: MotionState;
  to?: MotionState;
  /** キーフレーム列（1 点以上あれば preset/from/to より優先）。 */
  keys?: MotionKey[];
}

// エディタから渡る1セグメント（必要フィールドのみ）。
interface Segment {
  text: string;
  startFrame: number;
  endFrame: number;
  template?: number;
  position?: TelopPosition;
  scale?: number;
  motion?: Motion;
  /** 入場アニメ種別。'charByChar' で1文字ずつ弾んで出る（対応スタイルのみ）。 */
  animation?: string;
}

/** template を 1..count の整数へ正規化（範囲外/未定義は 1）。 */
function resolveTemplate(template: number | undefined, count: number): number {
  if (typeof template !== 'number' || !Number.isInteger(template) || template < 1 || template > count) {
    return 1;
  }
  return template;
}

/** フォーマット別のテロップ寸法（fontSize / 画面下端からの距離）。 */
interface TelopLayout {
  fontSize: number;
  bottomOffset: number;
}

// ハーネス形式の videoConfig.ts `TELOP_CONFIG_MAP` と一致させる。
// 同梱スタイルは fontSize/bottomOffset を props で受けるが既定が横動画向け(80/80)のため、
// このまま縦(short)動画へ使うと文字が大きく・位置が下すぎてプレビュー最下部で崩れて見える。
const TELOP_LAYOUT = {
  youtube: { fontSize: 80, bottomOffset: 100 },
  short: { fontSize: 56, bottomOffset: 200 },
  square: { fontSize: 66, bottomOffset: 140 },
} as const;

/**
 * 解像度のアスペクト比からハーネス形式のフォーマット別テロップ寸法を解決する。
 * 横長=youtube / 縦長=short / 正方形=square。videoConfig.ts に依存せず自己完結
 * （アダプタはプロジェクトへコピーされて動くため外部 import を増やさない）。
 */
export function resolveTelopLayout(width: number, height: number): TelopLayout {
  if (width > height) return TELOP_LAYOUT.youtube;
  if (height > width) return TELOP_LAYOUT.short;
  return TELOP_LAYOUT.square;
}

/**
 * テロップ帯の「ありうる最大幅」の標準比率（フォーマット別・width に対する比率）。
 * `src/preview/telopLayout.ts` の `telopMaxWidthFrac` と完全同一（正本はそちら。
 * このファイルはプロジェクトへコピーされて動く自己完結アダプタのため remotion 以外の
 * 外部 import を増やさず式を複製する。乖離検知は telopPositionMathParity.test.ts）。
 * 同梱スタイルは各スタイルで実際の帯幅が異なるが、標準値を「ありうる最大」とみなして
 * 保守的にクランプする（実際の帯がこれより狭い分には、その分だけ内側へ寄るだけで安全側）。
 */
export function telopMaxWidthFrac(width: number, height: number): number {
  if (width > height) return 0.85; // youtube
  if (height > width) return 0.92; // short
  return 0.9; // square
}

/**
 * position.x を「実際の帯の横幅 (elemW) を与えたときに画面内へ収まる範囲」へ丸める。
 * `src/preview/telopLayout.ts` の `clampTelopX` と完全同一（正本はそちら・式の複製）。
 */
export function clampTelopX(x: number, containerW: number, elemW: number): number {
  if (!(containerW > 0) || !(elemW >= 0) || !Number.isFinite(x)) return 0;
  if (elemW >= containerW) return 0;
  const limit = (containerW - elemW) / containerW;
  return Math.max(-limit, Math.min(limit, x));
}

/**
 * position / scale を CSS transform 文字列へ変換する（Harness Editor の telopLayout と同式）。
 * テロップは下端固定で描かれるため、縦移動 y はフォーマット連動の縦係数（1 - 2*bottomFrac）で
 * 換算し、y=-1 が画面上部（上下対称の余白）へ届くようにする。x は中心 50% 係数。これを最外
 * コンテナへ下端基準（transformOrigin）で当てることで、最終 render もエディタと同じ位置/サイズになる。
 *
 * **描画時クランプ（B-1 差し戻し対応・2026-09-06 #3）**: position.x は clampTelopX で
 * 必ずクランプしてから使う。テロップパック（同梱スタイル）はエディタの
 * ライブプレビュー（loadTelopComponent 経由の動的 import）と書き出しの両方でこの
 * ファイルがそのまま使われるため、ここで安全網を掛けないとパック導入済みプロジェクトだけ
 * 無防備のまま残ってしまう。実際の帯幅は分からないため telopMaxWidthFrac × scale を
 * 「ありうる最大」とみなす。
 */
export function telopTransform(
  position: TelopPosition | undefined,
  scale: number | undefined,
  width: number,
  height: number,
): string | undefined {
  const parts: string[] = [];
  if (position) {
    const vCoeff = 1 - 2 * (resolveTelopLayout(width, height).bottomOffset / height);
    const worstElemW = width * telopMaxWidthFrac(width, height) * (scale ?? 1);
    const x = clampTelopX(position.x, width, worstElemW);
    parts.push(`translate(${x * 50}%, ${position.y * vCoeff * 100}%)`);
  }
  if (scale != null && scale !== 1) {
    parts.push(`scale(${scale})`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

// ── 2点アニメ（プリセット）の補間（Harness Editor の core/motion.ts と同式・自己完結） ──
//
// キーフレーム（motion.keys）は**ここでは扱わない**。適用者はラッパー1つ（TelopPlayer.tsx）に
// 固定してあり、この部品には対応の目印を置かない（目印の文字列は入れないこと）
// — 目印を持つのはキーを実際に適用するラッパーだけ、が判定の前提（motionKeysSupport.ts）。

function motionClamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface MotionFull { x: number; y: number; scale: number; opacity: number }

function clampMotionFull(s: MotionFull): MotionFull {
  return {
    x: motionClamp(s.x, -1.5, 1.5),
    y: motionClamp(s.y, -1.5, 1.5),
    scale: motionClamp(s.scale, 0.05, 8),
    opacity: motionClamp(s.opacity, 0, 1),
  };
}

/** プリセット＋強さ＋詳細上書き → 絶対値の開始/終了状態（エディタと同値になる同式）。 */
export function resolveMotionEndpoints(
  motion: Motion,
  base: MotionFull,
): { from: MotionFull; to: MotionFull } {
  const k = motionClamp(motion.intensity ?? 0.5, 0, 1);
  const ZOOM_RANGE = 0.8;
  const PAN_RANGE = 0.4;
  let from: MotionFull = { ...base };
  let to: MotionFull = { ...base };
  if (motion.preset === 'zoomIn') to = { ...to, scale: base.scale * (1 + ZOOM_RANGE * k) };
  if (motion.preset === 'zoomOut') from = { ...from, scale: base.scale * (1 + ZOOM_RANGE * k) };
  if (motion.preset === 'panLeft') { from = { ...from, x: base.x + PAN_RANGE * k }; to = { ...to, x: base.x - PAN_RANGE * k }; }
  if (motion.preset === 'panRight') { from = { ...from, x: base.x - PAN_RANGE * k }; to = { ...to, x: base.x + PAN_RANGE * k }; }
  if (motion.preset === 'fadeIn') from = { ...from, opacity: 0 };
  const apply = (target: MotionFull, o: MotionState | undefined): MotionFull => ({
    x: o?.x ?? target.x,
    y: o?.y ?? target.y,
    scale: o?.scale ?? target.scale,
    opacity: o?.opacity ?? target.opacity,
  });
  return { from: clampMotionFull(apply(from, motion.from)), to: clampMotionFull(apply(to, motion.to)) };
}

/**
 * イーズイン/アウト（3次）＋線形補間で進行度の表示状態を返す（プリセット＝2点アニメのみ）。
 *
 * **キーフレーム（motion.keys）はここでは適用しない**（F-1 ラウンド2 差し戻し）。
 * キーの適用者はラッパー1つ（プレビューの TelopLayer / 撮影の CaptureTelopLayer /
 * 新版 TelopPlayer.tsx）に固定する。旧版 TelopPlayer.tsx を持つ案件へパックだけを導入すると、
 * 旧ラッパーは position/scale を剥がすが motion は剥がさないため、ここでキー（＝全軸の絶対値）を
 * 適用するとラッパーの transform と合成されて**書き出しだけ二重適用**になる。
 * プリセットは base 相対に解決されるので合成しても従来どおり（F-1 以前からの挙動）。
 * その案件では detectMotionKeysSupport が telop:false を返し、UI が
 * 「書き出しには反映されない」旨を出す（黙って食い違わせない）。
 */
export function sampleTelopMotion(
  motion: Motion,
  base: MotionFull,
  frame: number,
  startFrame: number,
  endFrame: number,
): MotionFull {
  const span = endFrame - startFrame;
  const p = span <= 0 ? 1 : motionClamp((frame - startFrame) / span, 0, 1);
  // keys は上のコメントのとおり適用しない（preset 'keyframes' は端点が base のまま＝静止）。
  const t = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const { from, to } = resolveMotionEndpoints(motion, base);
  return clampMotionFull({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
  });
}

/**
 * Harness Editor / 本体が `<Telop segment={...} />` で1セグメントずつ呼ぶ契約に対し、
 * 同梱スタイル（subtitleData 配列契約）を橋渡しするアダプタ。
 * 位置/スケールは呼び出し側ラッパが適用するためここでは扱わない。
 */
export const Telop = ({ segment }: { segment: Segment }) => {
  const { fps, width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const layout = resolveTelopLayout(width, height);
  const n = resolveTemplate(segment.template, STYLES.length);
  const StyleComp = STYLES[n - 1]!;
  const subtitleData = {
    fps,
    subtitles: [
      {
        text: segment.text,
        lines: segment.text.split('\n'),
        start: segment.startFrame / fps,
        end: segment.endFrame / fps,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        animation: segment.animation,
      },
    ],
  };
  // フォーマット別の寸法を渡し、縦/横/正方形でハーネス形式標準のサイズ・位置に合わせる。
  const styled = (
    <StyleComp subtitleData={subtitleData} fontSize={layout.fontSize} bottomOffset={layout.bottomOffset} />
  );
  // position / scale / motion を最外コンテナへ適用（上流契約 §2）。エディタのプレビューでは
  // EditorComposition 側が同じ transform を当てるため、二重適用にならないよう
  // エディタは segment から position/scale/motion を外して渡す。最終 render はここで適用する。
  // 拡縮はテロップ下端基準（transformOrigin）で上へ伸縮し、下端は動かさない。
  const base = {
    x: segment.position?.x ?? 0,
    y: segment.position?.y ?? 0,
    scale: segment.scale ?? 1,
    opacity: 1,
  };
  const sampled = segment.motion
    ? sampleTelopMotion(segment.motion, base, frame, segment.startFrame, segment.endFrame)
    : base;
  // <<< TP5 既存 7 種の配線ここから
  // 調整タブで選んだ既存 7 種を当てる。`none`・未指定・`charByChar`・未知・区間外は null が返り、
  // 現行の描画を 1 バイトも変えない（接続ゲート telopPackLiveConnection.test.tsx がこれを固定する）。
  const legacy = packLegacyTelopAnimationFrame(
    {
      animation: segment.animation,
      localFrame: frame - segment.startFrame,
      durationFrames: segment.endFrame - segment.startFrame,
    },
    { fps, interpolate, spring },
  );
  // >>> TP5 既存 7 種の配線ここまで
  const pos = sampled.x !== 0 || sampled.y !== 0 ? { x: sampled.x, y: sampled.y } : undefined;
  const transform = telopTransform(pos, sampled.scale, width, height);
  // <<< TP5 合成ここから
  // px 移動は telopTransform の**後ろ**へ連結する。案件テンプレート（Telop.tsx:679,786,837 の
  // `${layoutTransform}translate(...)`）と同じ順序＝クリップの scale の内側。前置すると scale が
  // 効かず、同じ字幕がプレビューと書き出しでずれる。
  const legacyTransform = legacy && (legacy.translateX !== 0 || legacy.translateY !== 0)
    ? `translate(${legacy.translateX}px, ${legacy.translateY}px)`
    : undefined;
  const composed = legacyTransform === undefined ? transform
    : transform === undefined ? legacyTransform : `${transform} ${legacyTransform}`;
  // 二重フェードは許容（裁定 3）。ただし入場窓は床 0.5（裁定 6）— 掛け算の相手は共有式側で下支え済み。
  const opacity = legacy ? sampled.opacity * legacy.opacity : sampled.opacity;
  if (composed === undefined && opacity === 1) return styled;
  // >>> TP5 合成ここまで
  const originY = (1 - layout.bottomOffset / height) * 100;
  return (
    <AbsoluteFill
      style={{
        transform: composed,
        transformOrigin: `50% ${originY}%`,
        ...(opacity !== 1 ? { opacity } : {}),
      }}
    >
      {styled}
    </AbsoluteFill>
  );
};

/** 能力宣言（描画は変えない）。同梱パックは新 8 種を描けないので既存 9 種だけを名乗る。 */
export const TELOP_ANIMATIONS = ['none','slideIn','fadeOnly','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','charByChar'] as const;
