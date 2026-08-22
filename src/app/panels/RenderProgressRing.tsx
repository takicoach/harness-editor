/**
 * RenderProgressRing — 書き出し進捗の円形リング表示。
 *
 * 旧表示は横長バー（`.tb-render-bar`）をラベルと同じ行に敷いていたため、進捗が
 * 進むほどバーがラベルを押し出し、幅 280px のトーストで「書き出…」と文字が切れて
 * 読めなかった（2026-08-08 実利用報告）。
 *
 * リング（stroke-dashoffset）で進捗を出し、% はリング中央に置く。ラベルはリングの
 * 右で **省略しない**（折り返す）。進捗が不定の区間は回転アニメで表す。
 * 進捗の供給元（サーバの render 進捗イベント）は変えていない＝表示だけの差し替え。
 */

import type { ReactNode } from 'react';

/** リング径（トースト内に収まるコンパクトさ）。 */
export const RING_SIZE = 40;
/** リングの太さ。 */
const RING_STROKE = 4;
/** 不定表示のときに描く弧の割合（全周の何割か）。 */
const INDETERMINATE_ARC = 0.25;

/** リングの幾何（半径・円周・中心）。size から一意に決まる純関数。 */
export function ringGeometry(size: number = RING_SIZE, stroke: number = RING_STROKE): {
  radius: number;
  circumference: number;
  center: number;
} {
  const radius = Math.max(1, (size - stroke) / 2);
  return { radius, circumference: 2 * Math.PI * radius, center: size / 2 };
}

/**
 * 進捗 % → stroke-dashoffset。
 * 0% は全周ぶんオフセット（＝何も描かない）、100% は 0（＝全周描く）。
 * 範囲外・非有限は 0..100 へクランプする（壊れた進捗値で弧が反転しない）。
 */
export function ringDashOffset(percent: number, circumference: number): number {
  const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  return circumference * (1 - p / 100);
}

/** 中央に出す % テキスト。不定なら null（テキストを出さない）。 */
export function ringPercentText(percent: number | null): string | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  return `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}

interface RenderProgressRingProps {
  /** 進捗（0..100）。null なら不定＝回転アニメ。 */
  percent: number | null;
  /** リングの右に出す説明文（省略せず折り返す）。 */
  label: string;
  size?: number;
}

export function RenderProgressRing({ percent, label, size = RING_SIZE }: RenderProgressRingProps): ReactNode {
  const { radius, circumference, center } = ringGeometry(size);
  const pctText = ringPercentText(percent);
  const indeterminate = pctText === null;
  return (
    <div
      className="tb-render-ring-wrap"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { 'aria-valuenow': Math.round(percent as number) })}
    >
      <span className="tb-render-ring-dial">
        <svg
          className={'tb-render-ring' + (indeterminate ? ' indeterminate' : '')}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
        >
          <circle
            className="tb-render-ring-track"
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={RING_STROKE}
          />
          <circle
            className="tb-render-ring-value"
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={
              indeterminate
                ? `${circumference * INDETERMINATE_ARC} ${circumference}`
                : `${circumference}`
            }
            strokeDashoffset={indeterminate ? 0 : ringDashOffset(percent as number, circumference)}
          />
        </svg>
        {pctText !== null && <span className="tb-render-ring-pct">{pctText}</span>}
      </span>
      <span className="tb-render-ring-label">{label}</span>
    </div>
  );
}
