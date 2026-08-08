import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { SceneOverlay } from './SceneOverlay';
import { overlayColorFor, joinOverlayOpacityAt, edgeOverlayOpacityAt } from './transitionStyle';
import { buildOverlaps, playbackToFinal } from './transitionEngine';
import type { CutSegment, SceneTransition } from './types';

interface Props {
  cutData: CutSegment[];
  transitions: SceneTransition[];
}

/**
 * fade 系シーン転換のオーバーレイを描くシーケンス（props 駆動）。
 * 重なる系（crossfade/slide/wipe）は TransitionSeries が担当するためここでは描かない。
 *
 * - head/tail: edgeOverlayOpacityAt をそのまま使用。
 * - at=number（つなぎ目）: playbackToFinal で最終フレームへ補正してから joinOverlayOpacityAt を使用。
 *   重なる系トランジションで尺が縮む分を補正することで、fade の中心フレームが最終動画で正確になる。
 *
 * props 駆動のため ../cutData や ../transitionData への import が不要（ローカル完結）。
 * Task 12 で MainVideo.tsx が cutData・transitionData を props として渡す。
 */
export const SceneOverlaySequence: React.FC<Props> = ({ cutData, transitions }) => {
  const { durationInFrames } = useVideoConfig();

  // 重なる系の overlaps を計算（playbackToFinal の補正に使う）。
  const overlaps = buildOverlaps(
    transitions.filter((t): t is SceneTransition & { at: number } => typeof t.at === 'number'),
    cutData,
  );

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {transitions.map((t) => {
        const color = overlayColorFor(t.kind, t.color);
        if (color === null) return null; // 重なる系（crossfade/slide/wipe）はここで描かない
        if (t.at === 'head') {
          return (
            <SceneOverlay
              key={t.id}
              color={color}
              opacityAt={(f) => edgeOverlayOpacityAt(f, 'head', durationInFrames, t.durationFrames)}
            />
          );
        }
        if (t.at === 'tail') {
          return (
            <SceneOverlay
              key={t.id}
              color={color}
              opacityAt={(f) => edgeOverlayOpacityAt(f, 'tail', durationInFrames, t.durationFrames)}
            />
          );
        }
        // at は保存時に射影済みの再生フレーム。
        // 重なる系トランジションによる尺短縮を playbackToFinal で最終フレームへ補正する。
        const finalFrame = playbackToFinal(t.at, overlaps);
        return (
          <SceneOverlay
            key={t.id}
            color={color}
            opacityAt={(f) => joinOverlayOpacityAt(f, finalFrame, t.durationFrames)}
          />
        );
      })}
    </AbsoluteFill>
  );
};
