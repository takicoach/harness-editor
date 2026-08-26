import React from 'react';
import { Sequence } from 'remotion';
import { InsertShape } from './InsertShape';
import { shapeData } from './shapeData';
import type { ShapeSegment } from './types';

/**
 * shapeData の各図形を Sequence でラップして描画する束ね役。
 * プロジェクトの MainVideo.tsx から <ShapeSequence/> を 1 行挿入して使う。
 */
export const ShapeSequence: React.FC = () => {
  return (
    <>
      {shapeData.map((shape: ShapeSegment) => {
        const duration = shape.endFrame - shape.startFrame;
        if (duration <= 0) return null;
        return (
          <Sequence
            key={shape.id}
            from={shape.startFrame}
            durationInFrames={duration}
          >
            <InsertShape shape={shape} />
          </Sequence>
        );
      })}
    </>
  );
};
