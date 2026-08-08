import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

/** 全画面の単色オーバーレイ。opacityAt(frame) で毎フレーム不透明度を出す。色のみ・尺不変。 */
export const SceneOverlay: React.FC<{ color: string; opacityAt: (frame: number) => number }> = ({ color, opacityAt }) => {
  const frame = useCurrentFrame();
  const opacity = opacityAt(frame);
  if (opacity <= 0) return null;
  return <AbsoluteFill style={{ backgroundColor: color, opacity, pointerEvents: 'none' }} />;
};
