import React from 'react';
import { Sequence } from 'remotion';
import { InsertImage } from './InsertImage';
import { insertImageData } from './insertImageData';

export const ImageSequence: React.FC = () => {
  return (
    <>
      {insertImageData.map((segment) => (
        <Sequence
          key={segment.id}
          from={segment.startFrame}
          durationInFrames={segment.endFrame - segment.startFrame}
        >
          <InsertImage segment={segment} />
        </Sequence>
      ))}
    </>
  );
};
