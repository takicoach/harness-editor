// ベース動画にのみ掛けるパンチイン演出（テロップ・図解・タイトルには掛けない）。
// 区間終了後は即 1.0 に戻す（ハードリターン＝ショート標準のパンチ感）。
import React from 'react';
import { useCurrentFrame, interpolate } from 'remotion';
import { zoomData } from './zoomData';

export const CameraZoom: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  let scale = 1;
  for (const z of zoomData) {
    if (frame >= z.startFrame && frame < z.endFrame) {
      scale = interpolate(
        frame,
        [z.startFrame, z.startFrame + z.rampFrames],
        [z.from, z.to],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      break;
    }
  }
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        transform: `scale(${scale})`,
        // 顔・上半身方向へ寄る（画面上部1/3を注視点にする）
        transformOrigin: '50% 32%',
      }}
    >
      {children}
    </div>
  );
};
