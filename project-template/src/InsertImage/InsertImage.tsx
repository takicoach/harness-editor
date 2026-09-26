import React from 'react';
import { useCurrentFrame, interpolate, Img, staticFile } from '@harness/frame-runtime';
import type { ImageSegment } from './types';
// 2点アニメ／キーフレームの補間は自己完結コピー（本体 core/motion.ts と同式）。
import { sampleImageMotion, type Motion, type MotionFull } from './imageMotion';
import { animStyleAt, DEFAULT_FADE } from './elementAnim';

// HARNESS_STANDARD_IMAGE_RENDERING_V1: plain と明示的な出入りアニメに対応。

interface InsertImageProps {
  segment: ImageSegment & { imageUrl?: string };
}


export const InsertImage: React.FC<InsertImageProps> = ({ segment }) => {
  const frame = useCurrentFrame();
  const duration = segment.endFrame - segment.startFrame;
  // ImageSequence が <Sequence from={startFrame}> でラップするため useCurrentFrame は
  // 区間先頭=0 の相対フレーム。ここで startFrame を引くと二重減算で負になりフェードが
  // 0 にクランプ＝画像が透明になる。相対フレームをそのまま localFrame として使う。
  const localFrame = frame;
  // src は editor プレビューでは segment.imageUrl、最終 render では staticFile。
  const src = segment.imageUrl ?? staticFile(`images/${segment.file}`);

  const plain = segment.type === 'plain';
  const defaultAnim = plain ? { kind: 'none' as const, frames: 0 } : DEFAULT_FADE;
  const anim = animStyleAt(localFrame, duration, segment.enter ?? defaultAnim, segment.exit ?? defaultAnim);
  // ユーザー配置＋2点アニメ: motion があれば区間の進行度で位置/大きさ/不透明度/回転を補間する。
  const baseState: MotionFull = {
    x: segment.position?.x ?? 0,
    y: segment.position?.y ?? 0,
    scale: segment.scale ?? 1,
    opacity: segment.opacity ?? 1,
    rotation: segment.rotation ?? 0,
  };
  const motion = (segment as { motion?: Motion }).motion;
  const sampled = motion ? sampleImageMotion(motion, baseState, localFrame, duration) : baseState;
  // 出入りは外側、ユーザー不透明度は画像だけへ適用する。
  const opacity = anim.opacity * sampled.opacity;
  const pos = { x: sampled.x, y: sampled.y };
  const userScale = sampled.scale;
  const placement = `translate(${(pos.x * 100) / 2}%, ${(pos.y * 100) / 2}%) rotate(${sampled.rotation}deg) scale(${userScale})`;

  // 写真は内側で Ken Burns（ゆっくり拡大）。
  const kenBurns = segment.type === 'photo'
    ? interpolate(localFrame, [0, duration], [1.0, 1.05], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  return (
    // Keep inner image/shade ordering local to this track. A positive outer
    // z-index escapes later video/shape/scene layers and disagrees with export.
    <div style={{ position: 'absolute', inset: 0, transform: anim.transform, zIndex: 0 }}>
      {/* overlay の暗幕は配置レイヤーの外＝全画面・背面（画像と一緒に動かない）。 */}
      {segment.type === 'overlay' && (
        <div
          style={{
            position: 'absolute',
            top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            opacity: anim.opacity,
            zIndex: 50,
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          // plain は最終サイズで画像を描く。全画面に拡大して transform で
          // 縮めると、撮影ブラウザで小さい原画像の輪郭が大きくぼける。
          // 中心座標から左上を直接求める。奇数サイズの translate(-50%) は
          // 別レイヤの再標本化で輪郭をぼかすため、配置には使わない。
          top: plain ? `${(1 + pos.y - userScale) * 50}%` : 0,
          left: plain ? `${(1 + pos.x - userScale) * 50}%` : 0,
          width: plain ? `${userScale * 100}%` : '100%',
          height: plain ? `${userScale * 100}%` : '100%',
          transform: plain ? `rotate(${sampled.rotation}deg)` : placement,
          transformOrigin: '50% 50%',
          opacity,
          zIndex: 50,
          display: segment.type === 'photo' || plain ? 'block' : 'flex',
          justifyContent: 'center',
          // 図解・overlay とも上部ゾーンに置き、胸元テロップ帯（bottomOffset 540）と人物を隠さない
          alignItems: 'flex-start',
          paddingTop: segment.type === 'photo' || plain ? 0 : 100,
          boxSizing: 'border-box',
        }}
      >
        {segment.type === 'photo' || plain ? (
          <Img
            src={src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: plain ? 'contain' : 'cover',
              transform: plain ? undefined : `scale(${kenBurns})`,
            }}
          />
        ) : (
          <Img
            src={src}
            style={{
              maxWidth: '78%',
              maxHeight: '52%',
              objectFit: 'contain',
              borderRadius: 28,
              border: '3px solid #D4B97A',
              boxShadow: '0 12px 40px rgba(20, 46, 35, 0.35)',
              backgroundColor: '#ffffff',
            }}
          />
        )}
      </div>
    </div>
  );
};
