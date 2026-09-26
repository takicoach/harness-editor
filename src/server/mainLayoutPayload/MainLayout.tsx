import React from 'react';
import { AbsoluteFill, useCurrentFrame } from '@harness/frame-runtime';
import type { CutSegmentLite, Layout, SegmentLayout } from './types';
import { layoutSegmentRanges, effectiveLayoutAtFrame, type LayoutKeyframe } from './layoutSegments';
import {
  colorGradeFilterId,
  colorGradeMatrixValues,
  colorWheelTransfers,
  isIdentityColorWheels,
  isIdentityColorGrade,
  type ColorGrade,
  type ColorGradeScope,
} from './colorGrade';

/**
 * カラー補正レイヤ（F-2）。無補正なら children をそのまま返す（既存案件の絵が 1 画素も変わらない）。
 *
 * SuperMovie Editor のプレビュー（EditorComposition の MainVideoColorGrade）と
 * **同一の DOM 構造・同一の filter 文字列**を組む。
 * `src/preview/colorGradeDomParity.test.tsx` が両者の DOM を突き合わせて固定する。
 */
export const ColorGradeLayer: React.FC<{
  grade?: ColorGrade;
  /** 対象レイヤ（filter id を分ける）。未指定＝メイン動画。 */
  scope?: ColorGradeScope;
  children: React.ReactNode;
}> = ({ grade, scope = 'main', children }) => {
  if (grade === undefined || isIdentityColorGrade(grade)) return <>{children}</>;
  const id = colorGradeFilterId(scope);
  const transfers = colorWheelTransfers(grade);
  return (
    <AbsoluteFill data-sme-color-grade={scope}>
      {/*
        色温度に相当する CSS filter 関数が無いため、4 つの補正を 1 枚の色行列へ畳んで
        feColorMatrix で当てる。既定の linearRGB へ落ちないよう sRGB を明示する。
      */}
      <svg aria-hidden="true" width={0} height={0} style={{ position: 'absolute' }}>
        <filter id={id} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={colorGradeMatrixValues(grade)} />
          {!isIdentityColorWheels(grade.wheels) && <>
            <feComponentTransfer>
              <feFuncR type="linear" slope={transfers[0].slope} intercept={transfers[0].intercept} />
              <feFuncG type="linear" slope={transfers[1].slope} intercept={transfers[1].intercept} />
              <feFuncB type="linear" slope={transfers[2].slope} intercept={transfers[2].intercept} />
            </feComponentTransfer>
            <feComponentTransfer>
              <feFuncR type="gamma" amplitude={transfers[0].amplitude} exponent={transfers[0].exponent} offset={0} />
              <feFuncG type="gamma" amplitude={transfers[1].amplitude} exponent={transfers[1].exponent} offset={0} />
              <feFuncB type="gamma" amplitude={transfers[2].amplitude} exponent={transfers[2].exponent} offset={0} />
            </feComponentTransfer>
          </>}
        </filter>
      </svg>
      <AbsoluteFill style={{ filter: `url(#${id})` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 恒等（全画面・変形なし）か。背景は不問（縮小・移動が無く見えないため）。 */
export function isIdentityLayout(l: Layout): boolean {
  return (
    l.scale === 1 &&
    l.position.x === 0 &&
    l.position.y === 0 &&
    (l.rotation ?? 0) === 0 &&
    !l.flipH &&
    !l.flipV
  );
}

/**
 * レイアウトの CSS transform 文字列（中心原点）。
 * エディタ core の mainLayoutTransform（src/core/mainLayout.ts）と同一式＝
 * プレビューと書き出しの一致を担保する。回転は core 側で保存前にクランプ済みの値を
 * そのまま信頼する（payload は自己完結のため clampRotation を再実装しない）。
 * 反転は負スケールで表現（sx/sy）。rotation/flipH/flipV 省略時は 0/false 扱い（旧導入プロジェクト互換）。
 */
export function layoutTransform(l: Layout): string {
  const sx = l.scale * (l.flipH ? -1 : 1);
  const sy = l.scale * (l.flipV ? -1 : 1);
  return `translate(${(l.position.x * 100) / 2}%, ${(l.position.y * 100) / 2}%) rotate(${l.rotation ?? 0}deg) scale(${sx}, ${sy})`;
}

/** トランジション 1 件の最小形（payload ローカル・kind だけ見る）。 */
export interface TransitionLite {
  kind: string;
}

/**
 * overlap 系（2 場面を重ねて再生尺が縮む＝各フレームで見える区間が 1 つでなくなる）トランジションが
 * 1 つでもあるか。core/transitionEngine.ts の isOverlapKind と同式・自己完結。
 * 該当時はプレビュー（EditorComposition の hasOverlap→base）と同じく、区間ごと/大域KFを適用せず base 降格する。
 */
export function hasOverlapTransition(transitions: TransitionLite[] | undefined): boolean {
  return (transitions ?? []).some((t) => t.kind === 'crossfade' || t.kind === 'slide' || t.kind === 'wipe');
}

/**
 * frame 対応（区間ごと個別指定 or 大域KF）でレイアウトを解決すべきか。
 * overlap 系トランジションがあるときはプレビューと揃えて false（base 降格）。純関数＝テスト可能。
 */
export function isFrameAwareLayout(
  cutData: CutSegmentLite[] | undefined,
  segmentLayouts: Record<number, SegmentLayout> | undefined,
  layoutKeyframes: LayoutKeyframe[],
  transitions: TransitionLite[] | undefined,
): boolean {
  if (cutData === undefined || cutData.length === 0) return false;
  if (hasOverlapTransition(transitions)) return false;
  return (segmentLayouts !== undefined && Object.keys(segmentLayouts).length > 0) || layoutKeyframes.length >= 2;
}

interface Props {
  layout: Layout;
  /** 区間ごと上書き（背景無し）。未指定・空なら全フレーム base のみ（後方互換）。 */
  segmentLayouts?: Record<number, SegmentLayout>;
  /** 区間範囲計算用のカット区間（未指定なら区間ごとを適用しない）。 */
  cutData?: CutSegmentLite[];
  /** メイン動画速度（倍率・未指定＝1）。 */
  mainSpeed?: number;
  /** 区間ごと速度（未指定＝全区間 mainSpeed）。 */
  segmentSpeeds?: Record<number, number>;
  /** メイン動画の大域キーフレーム列（原本フレームアンカー・2 点以上で motion/個別指定より優先）。未指定・空/1点なら従来どおり。 */
  layoutKeyframes?: LayoutKeyframe[];
  /** シーン転換（transitionData）。overlap 系（crossfade/slide/wipe）があれば base 降格＝プレビュー一致。未指定＝無し。 */
  transitions?: TransitionLite[];
  /** カラー補正（全体一律・未指定/既定なら素通し＝従来と同一描画）。 */
  colorGrade?: ColorGrade;
  children: React.ReactNode;
}

/**
 * メイン動画レイアウトを書き出しへ適用するラッパー（フレーム対応）。
 * 区間ごと情報（segmentLayouts + cutData）または大域キーフレーム（2 点以上）があれば
 * 現フレームの実効レイアウトを、無ければ base（layout）を全フレームに適用する（後方互換＝従来と同一描画）。
 * ただし overlap 系トランジション（crossfade/slide/wipe）があるときはプレビュー（hasOverlap→base）と揃えて base 降格。
 * 恒等なら children 素通し。非恒等なら背景 AbsoluteFill + transform AbsoluteFill で包む。
 * メイン動画レイヤーだけを変形（他レイヤーは外＝全画面）。
 */
export const MainLayout: React.FC<Props> = ({ layout, segmentLayouts, cutData, mainSpeed = 1, segmentSpeeds = {}, layoutKeyframes = [], transitions, colorGrade, children }) => {
  const frame = useCurrentFrame();
  const frameAware = isFrameAwareLayout(cutData, segmentLayouts, layoutKeyframes, transitions);
  const effective = frameAware
    ? effectiveLayoutAtFrame(frame, layout, segmentLayouts ?? {}, layoutSegmentRanges(cutData!, mainSpeed, segmentSpeeds), cutData!, layoutKeyframes)
    : layout;
  // カラー補正はメイン動画の映像だけに掛ける（＝変形の内側）。外側に掛けると
  // 縮小時に見える背景色まで補正され、プレビューと書き出しで背景の扱いが割れる余地ができる。
  const graded = <ColorGradeLayer grade={colorGrade}>{children}</ColorGradeLayer>;
  if (isIdentityLayout(effective)) return graded;
  return (
    <AbsoluteFill style={{ backgroundColor: effective.background }}>
      <AbsoluteFill style={{ transform: layoutTransform(effective), transformOrigin: 'center' }}>
        {graded}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
