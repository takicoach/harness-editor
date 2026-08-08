import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import type { TitleSegment, TitleStyle } from '../core/types';

/**
 * titleStyle 未指定時の既定スタイル（解像度から導く）。
 * 通常は videoConfig の TELOP_CONFIG 由来の値が渡るためフォールバックは保険。
 */
function resolveTitleStyle(titleStyle: TitleStyle | undefined, width: number, height: number): TitleStyle {
  return (
    titleStyle ?? {
      top: Math.round(height * 0.03),
      left: Math.round(width * 0.03),
      fontSize: Math.round(height * 0.022),
    }
  );
}

/**
 * 1 タイトルの表示。最終書き出しの Title.tsx と同じ位置・フォント・帯で描く。
 * 位置/フォントは合成座標（原本解像度）のピクセルで指定する（Player が compositionWidth/Height へ
 * 等倍スケールするため、最終 render と 1:1 で一致する）。
 */
const TitleClip: React.FC<{ segment: TitleSegment; style: TitleStyle }> = ({ segment, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const duration = segment.endFrame - segment.startFrame;
  const opacity = interpolate(frame, [0, 8, duration - 8, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const slideIn = spring({ frame, fps, config: { damping: 20, stiffness: 100, mass: 0.5 } });
  const translateX = interpolate(slideIn, [0, 1], [-50, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        top: style.top,
        left: style.left,
        opacity,
        transform: `translateX(${translateX}px)`,
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'linear-gradient(90deg, #B20AFD 0%, #087FFF 100%)',
          // Title.tsx の帯パディングと一致させる。
          padding: '8px 5px',
          display: 'inline-block',
        }}
      >
        <p
          style={{
            color: '#ffffff',
            fontSize: style.fontSize,
            fontWeight: 800,
            fontFamily: '"Noto Sans JP", sans-serif',
            margin: 0,
            textShadow: '2px 2px 8px rgba(0, 0, 0, 0.5)',
            lineHeight: 1.2,
            transform: 'skewX(-8deg)',
            whiteSpace: 'nowrap',
          }}
        >
          {segment.text}
        </p>
      </div>
    </div>
  );
};

/** 可視タイトルを全件レイヤー描画（書き出しの TitleSequence と一致）。 */
export function TitleLayer({
  titles,
  titleStyle,
}: {
  titles: TitleSegment[];
  titleStyle?: TitleStyle;
}): React.ReactElement {
  const { width, height } = useVideoConfig();
  const style = resolveTitleStyle(titleStyle, width, height);
  return (
    <AbsoluteFill>
      {titles.map((t) => (
        <Sequence key={t.id} from={t.startFrame} durationInFrames={Math.max(1, t.endFrame - t.startFrame)}>
          <TitleClip segment={t} style={style} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
