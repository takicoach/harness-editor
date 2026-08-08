import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Telop } from './Telop';
import { telopData } from './telopData';

export const TelopPlayer: React.FC = () => {
  const frame = useCurrentFrame();

  // 現在フレームで表示中のテロップを「全件」描く。字幕は時間が重ならないため通常 1 件だが、
  // 装飾テロップ（自由配置のタイトル等）は字幕と重なって同時表示されうる（各テロップは自身の
  // position で別位置に描かれる）。1 件だけ描くと長尺の装飾が字幕の表示中に消えてしまう。
  const active = telopData.filter(
    (s) => frame >= s.startFrame && frame < s.endFrame
  );

  return (
    <AbsoluteFill>
      {active.map((s) => (
        <Telop key={s.id} segment={s} />
      ))}
    </AbsoluteFill>
  );
};
