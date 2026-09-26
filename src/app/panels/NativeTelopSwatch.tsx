import { useLayoutEffect, useRef, useState } from 'react';
import { CaptureFrameProvider } from '../../captureRuntime';
import type { TelopComponent } from '../../preview/loadTelopComponent';
import { applyLegacyCaptionFont } from '../../preview/legacyCaptionFont';

/** Fixed-frame DOM composition. The surrounding swatch-fit retains its authored crop. */
export function NativeTelopSwatch({ Telop, text, template, width, height, fps }: {
  Telop: TelopComponent; text: string; template: number; width: number; height: number; fps: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => { if (host.current) return applyLegacyCaptionFont(host.current); });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(size.width / width, size.height / height);
  const displayWidth = width * scale, displayHeight = height * scale;
  return <div ref={host} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
    {scale > 0 && <div style={{ position: 'absolute', width: displayWidth, height: displayHeight,
      left: (size.width - displayWidth) / 2, top: (size.height - displayHeight) / 2,
      display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'none' }}>
    {/* Center scaling preserves the browser's fractional layout rounding in existing swatches. */}
    <div data-native-swatch={template} style={{ position: 'absolute', display: 'flex', width, height,
      marginLeft: (displayWidth - width) / 2, marginTop: (displayHeight - height) / 2,
      transform: `scale(${scale})`, overflow: 'hidden' }}>
      <CaptureFrameProvider frame={30} videoConfig={{ width, height, fps, durationInFrames: 60 }}>
        <Telop segment={{ text, template, startFrame: 0, endFrame: 60 }} />
      </CaptureFrameProvider>
    </div></div>}
  </div>;
}
