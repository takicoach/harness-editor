import React from 'react';
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import type { VideoInsert } from './types';
import { animStyleAt } from './elementAnim';

interface InsertVideoProps {
  segment: VideoInsert;
}

const NO_ANIM = { kind: 'none', frames: 0 } as const;

export const InsertVideo: React.FC<InsertVideoProps> = ({ segment }) => {
  const src = segment.videoUrl ?? staticFile(segment.file);
  const duration = segment.endFrame - segment.startFrame;
  const rate = segment.playbackRate ?? 1;
  const scale = segment.scale ?? 1;
  const pos = segment.position ?? { x: 0, y: 0 };
  const translate = `translate(${(pos.x * 100) / 2}%, ${(pos.y * 100) / 2}%)`;
  const frame = useCurrentFrame();
  // 既定はアニメなし＝従来挙動。enter/exit があるときだけ出入りする。
  const anim = animStyleAt(frame, duration, segment.enter ?? NO_ANIM, segment.exit ?? NO_ANIM);
  return (
    <AbsoluteFill style={{ opacity: anim.opacity, transform: anim.transform, transformOrigin: '50% 50%' }}>
      <AbsoluteFill style={{ transform: `${translate} scale(${scale})`, transformOrigin: '50% 50%' }}>
        {/*
          速度はソースのシーク（playbackRate）で表現する。表示窓は外側の Sequence
          （尺 = endFrame - startFrame）が規定するため endAt は指定しない。
          Remotion は endAt(trimAfter) をそのまま「表示フレーム数」として内側 Sequence の
          durationInFrames に使い playbackRate で割らないため、endAt を付けるとスロー時に
          表示窓が D_source フレームで切れて途中から透明になる（消費ソース量は尺×rate で自動的に定まる）。
        */}
        <OffthreadVideo
          src={src}
          startFrom={segment.sourceInFrame}
          playbackRate={rate}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
