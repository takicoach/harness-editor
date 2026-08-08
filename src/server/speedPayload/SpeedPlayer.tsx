import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence } from 'remotion';
import { speedSegments } from './speedSegments';
import type { CutSegment } from './types';

interface Props {
  cutData: CutSegment[];
  videoSrc: string;
  mainSpeed: number;
  segmentSpeeds?: Record<number, number>;
}

/**
 * カット＋速度のベース動画プレイヤー（props 駆動・自己完結）。
 * 各カット区間を speedSegments で速度後の位置・尺へ配置し、
 * mainSpeed!==1 は playbackRate で再生（ナレーションもピッチ変化）。
 * mainSpeed===1 は endAt あり＝等速（カットのみ適用）。
 * segmentSpeeds が渡ると区間ごとの個別速度が適用される。
 * トランジションは本サイクル非対応（installSpeed が導入済み PJ をブロックする）。
 */
export const SpeedPlayer: React.FC<Props> = ({ cutData, videoSrc, mainSpeed, segmentSpeeds }) => {
  const segs = speedSegments(cutData, mainSpeed, segmentSpeeds);
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {segs.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={s.durationInFrames}>
          <OffthreadVideo
            src={videoSrc}
            startFrom={s.startFrom}
            {...(s.endAt !== undefined ? { endAt: s.endAt } : { playbackRate: s.playbackRate })}
            volume={1.0}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
