import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { zoomData, type ZoomSegment } from './zoomData';

interface ZoomFrameProps {
  children: React.ReactNode;
}

/** frame を含む区間を 1 件返す（区間が重なる場合は配列先頭を優先）。 */
function activeZoomAt(frame: number): ZoomSegment | undefined {
  return zoomData.find((s) => frame >= s.originalStart && frame < s.originalEnd);
}

/**
 * 区間内での進行度（0=等倍 → 1=scale 到達）を求める。
 * 入り/出りを別々の 2 点 interpolate にして min() で合成する「アタック/リリース」封筒。
 * transitionIn/Out が 0 のときは退化区間（interpolate の inputRange が [0,0] 等になる）を
 * 避けるため interpolate 自体を呼ばず定数 1 を使う。tIn+tOut が区間長を超えて重なっても
 * min() が自然に三角形の封筒（ピークまで上げてすぐ戻す）として振る舞う。
 */
function zoomEnvelope(localFrame: number, duration: number, transitionInFrames = 0, transitionOutFrames = 0): number {
  const easing = Easing.inOut(Easing.ease);
  const rampIn =
    transitionInFrames > 0
      ? interpolate(localFrame, [0, transitionInFrames], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing,
        })
      : 1;
  const holdEnd = duration - transitionOutFrames;
  // 区間の最後に「描画される」フレームは duration-1（originalEnd は半開区間で含まない）。
  // 終点を duration にすると最終フレームでも 0 に達せず、区間を抜けた瞬間に等倍へ跳ねる（段差）。
  // duration-1 <= holdEnd（1フレーム区間や tOut が区間長とほぼ同じ）は inputRange が
  // 非増加になって退化するので、その場合だけ従来どおり duration を終点にする（戻り切らない）。
  const rampOutEnd = duration - 1 > holdEnd ? duration - 1 : duration;
  const rampOut =
    transitionOutFrames > 0
      ? interpolate(localFrame, [holdEnd, rampOutEnd], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing,
        })
      : 1;
  return Math.min(rampIn, rampOut);
}

/**
 * 注視点の座標（画面 %）を 0-100 へ収める。`origin` ごと省略された場合や、
 * 手書きで数値以外・NaN が入った場合は画面中央（50）を既定にする。
 * 数値でない値をそのまま使うと transform が NaN になり、`origin` 自体の欠落は
 * プロパティ参照で実行時 TypeError になる（zoomData.ts は人間/AI が直接書く前提）。
 */
function clampOrigin(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}

/**
 * zoomData（原本フレームアンカー区間）に基づき、子要素全体へズーム/クロップの
 * transform を適用する（区間クロップ・ズームイン演出を同一機構でカバー）。
 * 区間の対象外（zoomData が空を含む）では Fragment のまま素通しし、DOM に
 * 余計な要素を足さない＝従来と完全同一の描画になる。
 */
export const ZoomFrame: React.FC<ZoomFrameProps> = ({ children }) => {
  const frame = useCurrentFrame();
  const active = activeZoomAt(frame);

  if (!active) {
    return <>{children}</>;
  }

  const duration = active.originalEnd - active.originalStart;
  const localFrame = frame - active.originalStart;
  const t = zoomEnvelope(localFrame, duration, active.transitionInFrames, active.transitionOutFrames);
  // 手書きデータの防御的クランプ（InsertImage.tsx の clampMotionFull と同方針）。
  // scale<=0 は描画消失/反転、origin の 0-100 逸脱は注視点の画面外逃げになるため。
  const targetScale = Math.max(0.1, Math.min(8, active.scale));
  const originX = clampOrigin(active.origin?.x);
  const originY = clampOrigin(active.origin?.y);
  const scale = 1 + (targetScale - 1) * t;

  // 注視点（画面 % ）を中心からのオフセットに変換し、scale 後も画面上の位置が
  // 動かないよう translate で打ち消す（InsertImage.tsx と同じ translate(%)→scale() の合成順・
  // transformOrigin は既定の 50% 50%＝中心のまま）。
  const offsetX = originX - 50;
  const offsetY = originY - 50;
  const translateX = offsetX * (1 - scale);
  const translateY = offsetY * (1 - scale);

  return (
    <AbsoluteFill style={{ transform: `translate(${translateX}%, ${translateY}%) scale(${scale})` }}>
      {children}
    </AbsoluteFill>
  );
};
