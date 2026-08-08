import React from 'react';
import { Sequence } from 'remotion';
import { InsertVideo } from './InsertVideo';
import { insertVideoData } from './insertVideoData';

export const VideoInsertSequence: React.FC = () => {
  return (
    <>
      {insertVideoData.map((segment) => (
        <Sequence
          key={segment.id}
          from={segment.startFrame}
          durationInFrames={segment.endFrame - segment.startFrame}
        >
          <InsertVideo segment={segment} />
        </Sequence>
      ))}
    </>
  );
};
