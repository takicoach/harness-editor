import React from 'react';
import {
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
} from 'remotion';
import type {
  TelopSegment,
  TelopStyleConfig,
  TelopAnimation,
  TelopOrnament,
} from './telopTypes';
import { TELOP_CONFIG } from '../videoConfig';
import {
  template1_classicOutline,
  template2_blackBar,
  template3_whiteBar,
  animation_none,
  animation_slideIn,
  animation_fadeOnly,
  animation_slideFromLeft,
  animation_fadeBlurFromBottom,
  animation_slideLeftFadeBlur,
  animation_fadeFromRight,
  animation_fadeFromLeft,
  animation_charByChar,
} from './telopStyles';

interface TelopProps {
  segment: TelopSegment;
}

// テンプレート番号 → スタイル定義
// スタイルを増やす場合はここに1行足す（例: 4: template4_goldUnderline,）。
// telopTypes.ts の TelopTemplateId にも同じ番号を追加すること。
const TEMPLATE_MAP: Partial<Record<number, TelopStyleConfig>> = {
  1: template1_classicOutline,
  2: template2_blackBar,
  3: template3_whiteBar,
};

// styleからテンプレートを選択
const getTemplateConfig = (segment: TelopSegment): TelopStyleConfig => {
  // 明示的にtemplateが指定されている場合
  if (segment.template !== undefined) {
    const explicit = TEMPLATE_MAP[segment.template];
    if (explicit) return explicit;
  }

  // styleから自動マッピング。同梱スタイルは白黒3種のみのため、
  // 強調と警告は同じブラックバー（色で区別する手段が無い）。
  switch (segment.style) {
    case 'success':
      return template3_whiteBar; // ポイント（白帯・黒文字）
    case 'warning':
      return template2_blackBar; // 警告（黒帯・白文字）
    case 'emphasis':
      return template2_blackBar; // 強調（黒帯・白文字）
    default:
      return template1_classicOutline; // 基本（白抜き）
  }
};

// IDベースでアニメーションをばらけさせる（fadeOnly用）
// 右からのアニメーションは除外
const getVariedAnimation = (id: number) => {
  const animations = [
    animation_fadeOnly,           // 0: フェードのみ
    animation_fadeFromLeft,       // 1: 左からフェードイン
    animation_fadeOnly,           // 2: フェードのみ
    animation_slideFromLeft,      // 3: 左からスライドイン
    animation_fadeOnly,           // 4: フェードのみ
    animation_slideLeftFadeBlur,  // 5: 左スライド+フェード+ブラー
  ];
  return animations[id % animations.length] ?? animation_fadeOnly;
};

// アニメーションテンプレートを選択
// デフォルトはアニメーションなし。後から変更可能
const getAnimationConfig = (segment: TelopSegment) => {
  // 明示的にslideInが指定されている場合（warning/emphasisなど）
  if (segment.animation === 'slideIn') return animation_slideIn;

  // fadeOnlyはIDベースでバリエーションを付ける
  if (segment.animation === 'fadeOnly') return getVariedAnimation(segment.id);

  // その他の明示的な指定
  if (segment.animation === 'slideFromLeft') return animation_slideFromLeft;
  if (segment.animation === 'fadeBlurFromBottom') return animation_fadeBlurFromBottom;
  if (segment.animation === 'slideLeftFadeBlur') return animation_slideLeftFadeBlur;
  if (segment.animation === 'fadeFromRight') return animation_fadeFromRight;
  if (segment.animation === 'fadeFromLeft') return animation_fadeFromLeft;
  if (segment.animation === 'charByChar') return animation_charByChar;
  if (segment.animation === 'none') return animation_none;

  // デフォルト: 左スライド+フェード+ブラー
  return animation_slideLeftFadeBlur;
};

// HEXカラーをRGBに変換
const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1] ?? '0', 16),
    g: parseInt(result[2] ?? '0', 16),
    b: parseInt(result[3] ?? '0', 16),
  } : { r: 0, g: 0, b: 0 };
};

// 2色間を補間
const interpolateColor = (color1: string, color2: string, t: number) => {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
};

// 装飾パーツ（タブ・縦罫・三角・ドット・カーソル・角タグ等）
const Ornament: React.FC<{ ornament: TelopOrnament; blinkOn: boolean }> = ({
  ornament,
  blinkOn,
}) => {
  const style = ornament.blink
    ? { ...ornament.style, opacity: blinkOn ? 1 : 0 }
    : ornament.style;
  return <span style={style}>{ornament.text}</span>;
};

// 一文字ずつアニメーションするコンポーネント
const CharByCharText: React.FC<{
  text: string;
  localFrame: number;
  fps: number;
  config: TelopStyleConfig;
  animation: TelopAnimation;
  duration: number;
}> = ({ text, localFrame, fps, config, animation, duration }) => {
  const { font, textShadow } = config;
  const charDelay = animation.charDelay || 2;
  const chars = text.split('');
  const fillGradient = font.fillGradient;

  // フェードアウト用の全体opacity
  const fadeOut = animation.fadeOutDuration;
  const overallOpacity = interpolate(
    localFrame,
    [duration - fadeOut, duration],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <span style={{ display: 'inline-flex', opacity: overallOpacity }}>
      {chars.map((char, index) => {
        const charFrame = localFrame - index * charDelay;

        const charSpring = spring({
          frame: Math.max(0, charFrame),
          fps,
          config: animation.spring,
        });

        const translateY = interpolate(
          charSpring,
          [0, 1],
          [-animation.slideInDistance, 0]
        );

        const charOpacity = interpolate(
          charFrame,
          [0, 4],
          [0, 1],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );

        // グラデーションの場合は文字位置に応じた色を計算
        let charColor = font.color;
        if (fillGradient?.enabled) {
          const t = chars.length > 1 ? index / (chars.length - 1) : 0;
          charColor = interpolateColor(fillGradient.start, fillGradient.end, t);
        }

        return (
          <span
            key={index}
            style={{
              display: 'inline-block',
              transform: `translateY(${translateY}px)`,
              opacity: charOpacity,
              fontSize: font.size,
              fontWeight: font.weight,
              fontFamily: font.family,
              fontStyle: font.style,
              textShadow: `${textShadow.offsetX}px ${textShadow.offsetY}px ${textShadow.blur}px ${textShadow.color}`,
              color: charColor,
            }}
          >
            {char === ' ' ? '\u00A0' : char}
          </span>
        );
      })}
    </span>
  );
};

export const Telop: React.FC<TelopProps> = ({ segment }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // テンプレートを取得し、フォーマット別設定で上書き
  const baseConfig = getTemplateConfig(segment);
  const animation = getAnimationConfig(segment);
  const config = {
    ...baseConfig,
    font: { ...baseConfig.font, size: TELOP_CONFIG.fontSize },
    position: {
      ...baseConfig.position,
      bottom: TELOP_CONFIG.bottomOffset,
      maxWidth: TELOP_CONFIG.maxWidth,
      containerPadding: TELOP_CONFIG.containerPadding,
    },
  };
  const { font, background, position, textStroke, textShadow } = config;

  // 手動テロップの自由配置（Harness Editor / telop-pack の telopTransform と同式）。
  // テロップは下端固定描画のため、y はフォーマット連動の縦係数（1 - 2*bottomOffset/height）で
  // 換算し、下端基準（transformOrigin 50% 100%）で当てる。エディタのプレビューと同位置になる。
  // position/scale 未指定（通常の字幕）は従来と完全に同一描画。
  const layoutParts: string[] = [];
  if (segment.position) {
    // translate は px で当てる（% は「この帯コンテナ」基準になり移動量が画面基準にならないため）。
    const vCoeff = 1 - 2 * (TELOP_CONFIG.bottomOffset / height);
    const tx = segment.position.x * 0.5 * width;
    const ty = segment.position.y * vCoeff * height;
    layoutParts.push(`translate(${tx}px, ${ty}px)`);
  }
  if (segment.scale != null && segment.scale !== 1) {
    layoutParts.push(`scale(${segment.scale})`);
  }
  const layoutTransform = layoutParts.length > 0 ? layoutParts.join(' ') + ' ' : '';

  const localFrame = frame - segment.startFrame;
  const duration = segment.endFrame - segment.startFrame;

  // アニメーションなしの場合は常に不透明度1
  const hasAnimation = animation.fadeInDuration > 0 || animation.fadeOutDuration > 0;

  // durationが短い場合はフェード時間を調整
  const fadeIn = Math.min(animation.fadeInDuration, duration / 3);
  const fadeOut = Math.min(animation.fadeOutDuration, duration / 3);

  const opacity = hasAnimation
    ? interpolate(
        localFrame,
        [0, Math.max(1, fadeIn), duration - Math.max(1, fadeOut), duration],
        [0, 1, 1, 0],
        {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        }
      )
    : 1;

  const slideIn = animation.slideInDistance > 0
    ? spring({
        frame: localFrame,
        fps,
        config: animation.spring,
      })
    : 1;

  // スライド方向に応じてtransformを計算
  const slideDirection = animation.slideDirection || 'up';
  let translateX = 0;
  let translateY = 0;

  if (animation.slideInDistance > 0) {
    const slideValue = interpolate(slideIn, [0, 1], [animation.slideInDistance, 0]);
    switch (slideDirection) {
      case 'left':
        translateX = -slideValue;
        break;
      case 'right':
        translateX = slideValue;
        break;
      case 'up':
        translateY = slideValue;
        break;
      case 'down':
        translateY = -slideValue;
        break;
    }
  }

  // テキストを改行で分割
  const textLines = segment.text.split('\n');

  // charByCharアニメーションの場合は特別処理
  const isCharByChar = segment.animation === 'charByChar';

  // カーソル点滅（0.5秒周期）
  const blinkOn = Math.floor(localFrame / Math.max(1, Math.round(fps / 2))) % 2 === 0;

  // ===== CSS拡張描画（オリジナルスタイルが使う経路） =====
  // 切り欠き・矢羽根・二色ズレ・タブ・縦罫・下線など、基本フィールドだけでは
  // 表現できない意匠を css（TelopCssSpec）から組み立てる。
  const cssSpec = config.css;
  if (cssSpec) {
    const baseTextStyle: React.CSSProperties = {
      fontSize: font.size,
      fontWeight: font.weight,
      fontFamily: font.family,
      fontStyle: font.style,
      lineHeight: font.lineHeight,
      letterSpacing: font.letterSpacing,
      color: font.color,
      margin: 0,
      textAlign: 'center',
      whiteSpace: 'pre-line',
      textShadow: `${textShadow.offsetX}px ${textShadow.offsetY}px ${textShadow.blur}px ${textShadow.color}`,
      ...(textStroke.width > 0
        ? {
            WebkitTextStroke: `${textStroke.width}px ${textStroke.gradient.start}`,
            paintOrder: 'stroke fill' as const,
          }
        : {}),
      ...cssSpec.text,
    };

    const layers = cssSpec.layers ?? [];

    const renderText = (content: string, extra?: React.CSSProperties) => {
      const merged: React.CSSProperties = { ...baseTextStyle, ...extra };
      if (layers.length === 0) {
        return <span style={merged}>{content}</span>;
      }
      // 本文と同じ文字を背面に重ねる（二重袋文字・グロウレス発光・印刷ズレ）
      // 背面の層は絶対配置＝ブロック化されるため、本文側も inline-block にして
      // 改行時の行揃え（中央）を一致させる
      return (
        <span style={{ position: 'relative', display: 'inline-block', textAlign: 'center' }}>
          {layers.map((layer, index) => (
            <span
              key={index}
              style={{
                ...merged,
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                color: layer.color,
                WebkitTextStroke: layer.strokeWidth
                  ? `${layer.strokeWidth}px ${layer.strokeColor ?? layer.color}`
                  : '0',
                transform: `translate(${layer.offsetX ?? 0}px, ${layer.offsetY ?? 0}px)`,
              }}
            >
              {content}
            </span>
          ))}
          <span style={{ ...merged, position: 'relative', display: 'inline-block' }}>
            {content}
          </span>
        </span>
      );
    };

    const split = cssSpec.split;
    const splitAt = split ? segment.text.indexOf(split.by) : -1;

    let body: React.ReactNode;
    if (split && splitAt > 0) {
      // 区切り文字は後半側に残す（例: 'NG動作→OK動作' → 'NG動作' / '→OK動作'）
      const halves: Array<[string, typeof split.parts[0]]> = [
        [segment.text.slice(0, splitAt), split.parts[0]],
        [segment.text.slice(splitAt), split.parts[1]],
      ];
      body = halves.map(([part, spec], index) => (
        <span key={index} style={spec.box}>
          {renderText(part, spec.text)}
        </span>
      ));
    } else if (split) {
      // 区切り文字が無いテキストは後半側の見た目で1ブロック表示
      body = (
        <span style={split.parts[1].box}>
          {renderText(segment.text, split.parts[1].text)}
        </span>
      );
    } else if (isCharByChar) {
      // 一文字ずつ出す場合、層・縁取りは付かない（本文の追加CSSだけ引き継ぐ）
      body = (
        <span style={cssSpec.text}>
          <CharByCharText
            text={segment.text}
            localFrame={localFrame}
            fps={fps}
            config={config}
            animation={animation}
            duration={duration}
          />
        </span>
      );
    } else {
      body = renderText(segment.text);
    }

    const boxStyle: React.CSSProperties = {
      position: 'relative',
      display: 'inline-block',
      fontSize: font.size,
      background: background.enabled ? background.gradient : 'transparent',
      padding: background.padding,
      borderRadius: background.borderRadius,
      backdropFilter: background.backdropFilter,
      boxShadow: background.boxShadow,
      border: background.border,
      maxWidth: cssSpec.frame || cssSpec.fullBleed ? '100%' : position.maxWidth,
      ...cssSpec.box,
    };

    const boxElement = (
      <div style={boxStyle}>
        {(cssSpec.before ?? []).map((ornament, index) => (
          <Ornament key={`before-${index}`} ornament={ornament} blinkOn={blinkOn} />
        ))}
        {body}
        {(cssSpec.after ?? []).map((ornament, index) => (
          <Ornament key={`after-${index}`} ornament={ornament} blinkOn={blinkOn} />
        ))}
        {(cssSpec.overlays ?? []).map((ornament, index) => (
          <Ornament key={`overlay-${index}`} ornament={ornament} blinkOn={blinkOn} />
        ))}
      </div>
    );

    return (
      <div
        style={{
          position: 'absolute',
          bottom: position.bottom,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          // fullBleed（画面幅いっぱいの帯）だけは containerPadding を使わない
          padding: cssSpec.fullBleed ? 0 : position.containerPadding,
          opacity: isCharByChar ? 1 : opacity,
          transform: isCharByChar
            ? undefined
            : `translate(${translateX}px, ${translateY}px)`,
          zIndex: 200, // サムネイルより前面に
        }}
      >
        {cssSpec.frame ? (
          <div
            style={{
              display: 'inline-block',
              maxWidth: cssSpec.fullBleed ? '100%' : position.maxWidth,
              ...cssSpec.frame,
            }}
          >
            {boxElement}
          </div>
        ) : (
          boxElement
        )}
      </div>
    );
  }

  if (isCharByChar && background.enabled) {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: position.bottom,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: position.containerPadding,
          transform: layoutTransform === '' ? undefined : layoutTransform,
          transformOrigin: '50% 100%',
          zIndex: 200,
        }}
      >
        <div
          style={{
            background: background.gradient,
            padding: background.padding,
            borderRadius: background.borderRadius,
            maxWidth: position.maxWidth,
            backdropFilter: background.backdropFilter,
            boxShadow: background.boxShadow,
            border: background.border,
          }}
        >
          <div style={{ margin: 0, textAlign: 'center', lineHeight: font.lineHeight }}>
            <CharByCharText
              text={segment.text}
              localFrame={localFrame}
              fps={fps}
              config={config}
              animation={animation}
              duration={duration}
            />
          </div>
        </div>
      </div>
    );
  }

  // 背景ありスタイルの場合はCSSベース
  if (background.enabled) {
    const fillGradient = font.fillGradient;

    // グラデーションテキスト用のスタイル
    const textStyle: React.CSSProperties = {
      fontSize: font.size,
      fontWeight: font.weight,
      fontFamily: font.family,
      fontStyle: font.style,
      margin: 0,
      textAlign: 'center',
      lineHeight: font.lineHeight,
      letterSpacing: font.letterSpacing,
      textShadow: `${textShadow.offsetX}px ${textShadow.offsetY}px ${textShadow.blur}px ${textShadow.color}`,
      whiteSpace: 'pre-line',
    };

    // fillGradientが有効な場合はCSSグラデーションテキストを適用
    if (fillGradient?.enabled) {
      Object.assign(textStyle, {
        background: `linear-gradient(90deg, ${fillGradient.start} 0%, ${fillGradient.end} 100%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      });
    } else {
      textStyle.color = font.color;
    }

    return (
      <div
        style={{
          position: 'absolute',
          bottom: position.bottom,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: position.containerPadding,
          opacity,
          transform: `${layoutTransform}translate(${translateX}px, ${translateY}px)`,
          transformOrigin: '50% 100%',
          zIndex: 200, // サムネイルより前面に
        }}
      >
        <div
          style={{
            background: background.gradient,
            padding: background.padding,
            borderRadius: background.borderRadius,
            maxWidth: position.maxWidth,
            backdropFilter: background.backdropFilter,
            boxShadow: background.boxShadow,
            border: background.border,
          }}
        >
          <p style={textStyle}>
            {segment.text}
          </p>
        </div>
      </div>
    );
  }

  // 背景なし・グラデーションストロークのスタイル（SVGベース）
  const strokeGradientId = `stroke-gradient-${segment.id}`;
  const fillGradientId = `fill-gradient-${segment.id}`;
  const filterId = `shadow-filter-${segment.id}`;

  const svgWidth = width;
  const lineHeight = font.size * 1.3; // 行間
  const svgHeight = font.size * 2 + (textLines.length - 1) * lineHeight;
  const baseY = svgHeight / 2 - ((textLines.length - 1) * lineHeight) / 2 + font.size * 0.35;

  const strokeGradient = textStroke.gradient;
  const fillGradient = font.fillGradient;
  const hasFillGradient = fillGradient?.enabled ?? false;
  const textOpacity = font.opacity ?? 1;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: position.bottom,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: position.containerPadding,
        opacity,
        transform: `${layoutTransform}translate(${translateX}px, ${translateY}px)`,
        transformOrigin: '50% 100%',
        zIndex: 200, // サムネイルより前面に
      }}
    >
      <svg
        width={svgWidth}
        height={svgHeight}
        style={{
          overflow: 'visible',
          display: 'block',
          opacity: textOpacity,
        }}
      >
        <defs>
          <linearGradient id={strokeGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={strokeGradient.start} />
            <stop offset="100%" stopColor={strokeGradient.end} />
          </linearGradient>

          {fillGradient?.enabled && (
            <linearGradient id={fillGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={fillGradient.start} />
              <stop offset="100%" stopColor={fillGradient.end} />
            </linearGradient>
          )}

          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow
              dx={textShadow.offsetX}
              dy={textShadow.offsetY}
              stdDeviation={textShadow.blur / 2}
              floodColor="black"
              floodOpacity="0.85"
            />
          </filter>
        </defs>

        {/* ストローク */}
        <text
          x="50%"
          y={baseY}
          textAnchor="middle"
          style={{
            fontSize: font.size,
            fontWeight: font.weight,
            fontFamily: font.family,
            fontStyle: font.style,
            letterSpacing: font.letterSpacing,
          }}
          fill="none"
          stroke={`url(#${strokeGradientId})`}
          strokeWidth={textStroke.width}
          strokeLinejoin="round"
          strokeLinecap="round"
          filter={`url(#${filterId})`}
        >
          {textLines.map((line, index) => (
            <tspan key={index} x="50%" dy={index === 0 ? 0 : lineHeight}>
              {line}
            </tspan>
          ))}
        </text>

        {/* 塗り */}
        <text
          x="50%"
          y={baseY}
          textAnchor="middle"
          style={{
            fontSize: font.size,
            fontWeight: font.weight,
            fontFamily: font.family,
            fontStyle: font.style,
            letterSpacing: font.letterSpacing,
          }}
          fill={hasFillGradient ? `url(#${fillGradientId})` : font.color}
        >
          {textLines.map((line, index) => (
            <tspan key={index} x="50%" dy={index === 0 ? 0 : lineHeight}>
              {line}
            </tspan>
          ))}
        </text>
      </svg>
    </div>
  );
};
