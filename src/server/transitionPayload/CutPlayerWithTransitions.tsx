import React from 'react';
import { OffthreadVideo } from 'remotion';
import { TransitionSeries } from '@remotion/transitions';
import { presentationFor, timingFor } from './transitionPresentation';
import { planUnifiedSeries } from './unifiedSeries';
import type { CutSegment, SceneTransition } from './types';

interface Props {
  cutData: CutSegment[];
  transitions: SceneTransition[];
  videoSrc: string;
  /** メイン動画 全体一律の速度（倍率・未指定=1）。1 以外は playbackRate で再生し endAt を外す。 */
  mainSpeed?: number;
}

/**
 * カット＋トランジション＋速度のベース動画プレイヤー（props 駆動・自己完結）。
 * planUnifiedSeries（EditorComposition path 2 と同一）で TransitionSeries 子要素の記述子を組み、
 * それを TransitionSeries.Sequence / .Transition へ写すだけ。
 * mainSpeed===1・transitions 空はそれぞれ現行のトランジション/速度書き出しとフレーム同値。
 */
export const CutPlayerWithTransitions: React.FC<Props> = ({ cutData, transitions, videoSrc, mainSpeed = 1 }) => {
  const items = planUnifiedSeries(cutData, transitions, mainSpeed);
  return (
    <TransitionSeries>
      {items.map((item) => {
        if (item.type === 'transition') {
          const pres = presentationFor(item.kind, item.direction);
          if (pres === null) return null;
          return (
            <TransitionSeries.Transition
              key={`tr-${item.boundary}`}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              presentation={pres as any}
              timing={timingFor(item.overlap)}
            />
          );
        }
        return (
          <TransitionSeries.Sequence key={item.id} durationInFrames={item.durationInFrames}>
            <OffthreadVideo
              src={videoSrc}
              startFrom={item.startFrom}
              {...(item.endAt !== undefined ? { endAt: item.endAt } : { playbackRate: item.playbackRate })}
            />
          </TransitionSeries.Sequence>
        );
      })}
    </TransitionSeries>
  );
};
