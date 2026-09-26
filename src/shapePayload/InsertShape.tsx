import React from 'react';
import { useCurrentFrame, useVideoConfig } from '@harness/frame-runtime';
import type { ShapeSegment } from './types';
import { shapeSvgGeometry, thicknessToPx, fadeOpacity } from './shapeDraw';

const FADE_FRAMES = 8;

interface InsertShapeProps {
  shape: ShapeSegment;
  /** 合成幅（px）。未指定時は useVideoConfig() から取得。EditorComposition からの直接 import 時に渡す。 */
  width?: number;
  /** 合成高さ（px）。未指定時は useVideoConfig() から取得。EditorComposition からの直接 import 時に渡す。 */
  height?: number;
  /** エディタプレビュー用: フェードを無効化し常に不透明で描く（描いた図形が即見えるように）。
   *  最終書き出し（ShapeSequence）からは渡さないため、書き出しでは出入りフェードが効く。 */
  disableFade?: boolean;
}

/**
 * 1 図形を SVG で描画する。
 * - viewBox をフレーム実寸（width×height）に設定し、正規化座標を px 展開する。
 * - staticFile / node:vm に依存しない。外部アセット不要の純ベクター描画。
 * - 出入り 8 フレームのフェードを適用。ユーザー opacity に乗算。
 * - width/height を props で受け取った場合はそちらを優先し、未指定時は useVideoConfig() で取得する。
 */
export const InsertShape: React.FC<InsertShapeProps> = ({ shape, width: widthProp, height: heightProp, disableFade = false }) => {
  const frame = useCurrentFrame();
  const { width: vcWidth, height: vcHeight, durationInFrames } = useVideoConfig();
  const width = widthProp ?? vcWidth;
  const height = heightProp ?? vcHeight;

  // エディタプレビューでは disableFade=true で常に不透明（描いた図形が即見える）。書き出しは fade を適用。
  const fade = disableFade ? 1 : fadeOpacity(frame, durationInFrames, FADE_FRAMES);
  const opacity = fade * (shape.opacity ?? 1);
  const strokeWidth = thicknessToPx(shape.thickness, height);
  const g = shapeSvgGeometry(shape, width, height);
  const markerId = `arrow-${shape.id}`;

  // I-5: この payload の ShapeKind は旧 4 種のまま（triangle / angle はエディタ内蔵の
  // native 描画専用で、legacy プロジェクトへ配る shapeData.ts の型には入っていない）。
  // shapeData.ts は素の JSON なので型の外の kind が手で書かれ得る。以前はどの分岐にも
  // 当たらず「中身が空の妥当な SVG」を返して無音で消えていたため、ここで明示的に断る。
  // 対応を増やすなら types.ts の ShapeKind と nativeDataPacks.ts の DATA_TYPES.shape を
  // 同時に更新し、描画も src/preview/native/sceneRenderer.tsx と揃えること。
  const SUPPORTED: readonly string[] = ['line', 'arrow', 'rect', 'ellipse'];
  if (!SUPPORTED.includes(shape.kind)) {
    throw new Error(
      `InsertShape: 未対応の図形種別です: ${String(shape.kind)}（この描画部品は line / arrow / rect / ellipse のみ描けます）`,
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity,
        overflow: 'visible',
      }}
    >
      {shape.kind === 'arrow' && (
        <defs>
          <marker
            id={markerId}
            markerWidth={3}
            markerHeight={3}
            refX={3}
            refY={1.5}
            orient="auto"
          >
            <polygon
              points="0 0, 3 1.5, 0 3"
              fill={shape.color}
            />
          </marker>
        </defs>
      )}

      {(shape.kind === 'line' || shape.kind === 'arrow') && (
        <line
          x1={g.x1}
          y1={g.y1}
          x2={g.x2}
          y2={g.y2}
          stroke={shape.color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          markerEnd={shape.kind === 'arrow' ? `url(#${markerId})` : undefined}
        />
      )}

      {shape.kind === 'rect' && (
        <rect
          x={g.rectX}
          y={g.rectY}
          width={g.rectW}
          height={g.rectH}
          stroke={shape.color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinejoin="round"
        />
      )}

      {shape.kind === 'ellipse' && (
        <ellipse
          cx={g.cx}
          cy={g.cy}
          rx={Math.max(0, g.rx)}
          ry={Math.max(0, g.ry)}
          stroke={shape.color}
          strokeWidth={strokeWidth}
          fill="none"
        />
      )}
    </svg>
  );
};
