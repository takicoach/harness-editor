import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ClassicOutline } from './styles/ClassicOutline';
import { BlackBar } from './styles/BlackBar';
import { WhiteBar } from './styles/WhiteBar';

// id 1..3 の順（manifest と一致）。index 0 = id 1。
const STYLES = [
  ClassicOutline, BlackBar, WhiteBar,
];

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

/** 2点アニメ指定（telopData.ts の motion フィールド）。 */
interface Motion {
  preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom';
  intensity?: number;
  from?: MotionState;
  to?: MotionState;
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
// 各スタイルは fontSize/bottomOffset を props で受けるが既定が横動画向けのため、
// このまま縦(short)動画へ使うと文字が大きく・位置が下すぎてプレビュー最下部で崩れて見える。
const TELOP_LAYOUT = {
  youtube: { fontSize: 80, bottomOffset: 100 },
  short: { fontSize: 56, bottomOffset: 200 },
  square: { fontSize: 66, bottomOffset: 140 },
} as const;

/**
 * 解像度のアスペクト比から ハーネス形式のフォーマット別テロップ寸法を解決する。
 * 横長=youtube / 縦長=short / 正方形=square。videoConfig.ts に依存せず自己完結
 * （アダプタはプロジェクトへコピーされて動くため外部 import を増やさない）。
 */
export function resolveTelopLayout(width: number, height: number): TelopLayout {
  if (width > height) return TELOP_LAYOUT.youtube;
  if (height > width) return TELOP_LAYOUT.short;
  return TELOP_LAYOUT.square;
}

/**
 * position / scale を CSS transform 文字列へ変換する（Harness Editor の telopLayout と同式）。
 * テロップは下端固定で描かれるため、縦移動 y はフォーマット連動の縦係数（1 - 2*bottomFrac）で
 * 換算し、y=-1 が画面上部（上下対称の余白）へ届くようにする。x は中心 50% 係数。これを最外
 * コンテナへ下端基準（transformOrigin）で当てることで、最終 render もエディタと同じ位置/サイズになる。
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
    parts.push(`translate(${position.x * 50}%, ${position.y * vCoeff * 100}%)`);
  }
  if (scale != null && scale !== 1) {
    parts.push(`scale(${scale})`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

// ── 2点アニメの補間（Harness Editor の core/motion.ts と同式・自己完結） ──

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

/** イーズイン/アウト（3次）＋線形補間で進行度の表示状態を返す。 */
export function sampleTelopMotion(
  motion: Motion,
  base: MotionFull,
  frame: number,
  startFrame: number,
  endFrame: number,
): MotionFull {
  const span = endFrame - startFrame;
  const p = span <= 0 ? 1 : motionClamp((frame - startFrame) / span, 0, 1);
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
 * スタイルコンポーネント（subtitleData 配列契約）を橋渡しするアダプタ。
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
  // フォーマット別の寸法を渡し、縦/横/正方形で ハーネス標準のサイズ・位置に合わせる。
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
  const pos = sampled.x !== 0 || sampled.y !== 0 ? { x: sampled.x, y: sampled.y } : undefined;
  const transform = telopTransform(pos, sampled.scale, width, height);
  if (transform === undefined && sampled.opacity === 1) return styled;
  const originY = (1 - layout.bottomOffset / height) * 100;
  return (
    <AbsoluteFill
      style={{
        transform,
        transformOrigin: `50% ${originY}%`,
        ...(sampled.opacity !== 1 ? { opacity: sampled.opacity } : {}),
      }}
    >
      {styled}
    </AbsoluteFill>
  );
};
