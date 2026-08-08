import { useCurrentFrame } from 'remotion';
import type { TelopSegment } from './telopTypes';
import { telopColors } from './telopStyles';

export const Telop = ({ segment }: { segment: TelopSegment }) => {
  const frame = useCurrentFrame();
  const localFrame = frame - segment.startFrame;
  const opacity = Math.min(1, Math.max(0, localFrame / 8));
  const color = telopColors[segment.style ?? 'normal'];
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 200,
        textAlign: 'center',
        opacity,
      }}
    >
      <span
        style={{
          fontSize: 56,
          fontWeight: 800,
          color,
          background: 'rgba(0,0,0,0.55)',
          padding: '8px 22px',
          borderRadius: 6,
        }}
      >
        {segment.text}
      </span>
    </div>
  );
};
