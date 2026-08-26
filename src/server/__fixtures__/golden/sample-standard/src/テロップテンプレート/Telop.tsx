import { useMemo } from 'react';
import { useCurrentFrame } from 'remotion';
// react-dom の default / named import はエディタの import map
// (runtime/react-dom.ts) 経由で解決される。外部テロップ部品が react-dom を
// 直接 import するケースの検証パスとして、あえて両形式で import している。
import ReactDOM from 'react-dom';
import { createPortal } from 'react-dom';
import type { TelopSegment } from './telopTypes';
import { telopColors } from './telopStyles';

// default と named が同一インスタンスを指すことを DOM 属性で観測可能にする。
const reactDomOk = ReactDOM.createPortal === createPortal ? 'yes' : 'no';

export const Telop = ({ segment }: { segment: TelopSegment }) => {
  const frame = useCurrentFrame();
  const localFrame = frame - segment.startFrame;
  const opacity = Math.min(1, Math.max(0, localFrame / 8));
  // react の named import (hooks) も import map (runtime/react.ts) 経由で
  // 解決される検証パスとして useMemo を使う。
  const color = useMemo(() => telopColors[segment.style ?? 'normal'], [segment.style]);
  return (
    <div
      data-reactdom-ok={reactDomOk}
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
