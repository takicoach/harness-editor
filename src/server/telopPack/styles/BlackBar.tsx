import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
  Easing,
} from "remotion";

// 字幕データの型定義
export interface SubtitleItem {
  text: string;
  lines: string[];
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
}

export interface SubtitleData {
  fps: number;
  subtitles: SubtitleItem[];
}

interface BlackBarProps {
  subtitleData: SubtitleData;
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  paddingVertical?: number;
  paddingHorizontal?: number;
  borderRadius?: number;
  bottomOffset?: number;
  fontFamily?: string;
}

/**
 * 02 ブラックバー（TAKICOACH オリジナル）。
 * 黒帯＋白文字。明るい実写背景でも安定して読める。
 *
 * - 装飾の px 値（帯の余白・角丸）は fontSize 80（16:9）基準。short / square では
 *   文字だけが縮み、帯の余白は変わらない（有料テロップパックと同じ挙動）。
 * - フォントは Noto Sans JP を第一候補にしつつ、読み込んでいないプロジェクトでも
 *   崩れないよう OS 標準の日本語ゴシックへフォールバックする。
 */
export const BlackBar: React.FC<BlackBarProps> = ({
  subtitleData,
  fontSize = 80,
  fontColor = "#ffffff",
  backgroundColor = "#111318",
  paddingVertical = 27,
  paddingHorizontal = 64,
  borderRadius = 21,
  bottomOffset = 100,
  fontFamily = "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif",
}) => {
  const frame = useCurrentFrame();

  // 現在のフレームに対応する字幕を検索
  const currentSubtitle = subtitleData.subtitles.find(
    (sub) => frame >= sub.startFrame && frame <= sub.endFrame
  );

  if (!currentSubtitle) {
    return null;
  }

  // テロップの表示時間
  const duration = currentSubtitle.endFrame - currentSubtitle.startFrame;

  // フェードイン/アウトアニメーション
  const maxFadeDuration = Math.floor(duration / 3);
  const fadeInDuration = Math.min(3, maxFadeDuration);
  const fadeOutDuration = Math.min(3, maxFadeDuration);

  let opacity = 1;

  if (duration > 6) {
    const fadeInEnd = currentSubtitle.startFrame + fadeInDuration;
    const fadeOutStart = currentSubtitle.endFrame - fadeOutDuration;

    if (fadeInEnd < fadeOutStart) {
      opacity = interpolate(
        frame,
        [currentSubtitle.startFrame, fadeInEnd, fadeOutStart, currentSubtitle.endFrame],
        [0, 1, 1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
    } else {
      const midPoint = (currentSubtitle.startFrame + currentSubtitle.endFrame) / 2;
      opacity = interpolate(
        frame,
        [currentSubtitle.startFrame, midPoint, currentSubtitle.endFrame],
        [0, 1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
    }
  }

  // スケールアニメーション
  const scale = fadeInDuration > 0 ? interpolate(
    frame,
    [currentSubtitle.startFrame, currentSubtitle.startFrame + fadeInDuration],
    [0.95, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }
  ) : 1;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: bottomOffset,
        paddingLeft: 60,
        paddingRight: 60,
      }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          maxWidth: "85%",
          backgroundColor,
          padding: `${paddingVertical}px ${paddingHorizontal}px`,
          borderRadius,
          boxShadow: "0 21px 53px rgba(0, 0, 0, 0.4)",
          color: fontColor,
          fontSize,
          fontFamily,
          fontWeight: 700,
          lineHeight: 1.35,
          textAlign: "center",
        }}
      >
        {currentSubtitle.lines.map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 && <br />}
            {line}
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
};
