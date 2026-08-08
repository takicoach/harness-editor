import React from 'react';
import {
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
  Sequence,
} from 'remotion';
import { titleData } from './titleData';
import { TELOP_CONFIG } from '../videoConfig';

export interface TitleSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
}

interface TitleProps {
  segment: TitleSegment;
}

const Title: React.FC<TitleProps> = ({ segment }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const duration = segment.endFrame - segment.startFrame;

  const opacity = interpolate(
    frame,
    [0, 8, duration - 8, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const slideIn = spring({
    frame,
    fps,
    config: { damping: 20, stiffness: 100, mass: 0.5 },
  });

  const translateX = interpolate(slideIn, [0, 1], [-50, 0]);

  return (
    <div
      style={{
        position: 'absolute',
        top: TELOP_CONFIG.titleTop,
        left: TELOP_CONFIG.titleLeft,
        opacity,
        transform: `translateX(${translateX}px)`,
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'linear-gradient(90deg, #B20AFD 0%, #087FFF 100%)',
          padding: '8px 5px',
          display: 'inline-block',
        }}
      >
        <p
          style={{
            color: '#ffffff',
            fontSize: TELOP_CONFIG.titleFontSize,
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

export const TitleSequence: React.FC = () => {
  return (
    <>
      {titleData.map((segment) => (
        <Sequence
          key={segment.id}
          from={segment.startFrame}
          durationInFrames={segment.endFrame - segment.startFrame}
        >
          <Title segment={segment} />
        </Sequence>
      ))}
    </>
  );
};
