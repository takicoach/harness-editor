/**
 * 新 8 種の設定と、文字ボックスへ効果を当てる層。
 * telopStyles.ts（既存 9 定数）には一切触らない。
 * JSX を使わないのは、設計がこのファイルを .ts と決めているため（React.createElement で書く）。
 */
import React from 'react';
import type { TelopAnimation, TelopSegment } from './telopTypes';
import {
  TELOP_TYPE_CURSOR, telopAnimationEffect, telopBandColor, telopExitOpacity,
  telopGraphemeCount, telopSliceGraphemes, type TelopAnimationId, type TelopEffectOutput,
} from './telopAnimationEffect';

/** 新 8 種に共通の土台。入場は effect が担い、退場は 8 フレームの不透明度フェードだけ。 */
const base = (id: TelopAnimationId, name: string): TelopAnimation => ({
  name,
  fadeInDuration: 0,
  fadeOutDuration: 8,
  slideInDistance: 0,
  slideDirection: 'up' as const,
  spring: { damping: 20, stiffness: 100, mass: 0.5 },
  id,
  effect: telopAnimationEffect,
});

export const animation_popIn = base('popIn', 'ポップ');
export const animation_wipeReveal = base('wipeReveal', 'ワイプ');
export const animation_typeCursor = base('typeCursor', 'タイプ打ち');
export const animation_underlineGrow = base('underlineGrow', '下線が伸びる');
export const animation_bandLeadsText = base('bandLeadsText', '帯が先に伸びる');
export const animation_jumpPop = base('jumpPop', 'ジャンプ');
export const animation_stampPress = base('stampPress', 'スタンプ');
export const animation_blurOutFocus = base('blurOutFocus', 'ぼかし解除');

/** 文字ボックス（内側）に当てる層。最外の位置・拡縮コンテナには触らない。 */
function effectLayer(id: TelopAnimationId, effect: TelopEffectOutput, fontSizePx: number,
  bandColor: string, children: React.ReactNode): React.ReactElement {
  return React.createElement('div', {
    'data-telop-effect': id,
    // 帯を出す動き（bandLeadsText）は「帯が先に伸び、文字が後から出る」。層に opacity を当てると
    // 子の帯まで一緒に透明になり、ただのフェードに退化する。opacity は文字だけに掛ける（I-1）。
    style: {
      position: 'relative', display: 'inline-block', maxWidth: '100%', transformOrigin: 'center',
      transform: effect.transform, opacity: effect.band === undefined ? effect.opacity : undefined,
      filter: effect.filter, clipPath: effect.clipPath,
    } as React.CSSProperties,
  },
    effect.band === undefined ? null : React.createElement('span', {
      key: 'band', 'data-telop-effect-band': '',
      style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: `${effect.band * 100}%`,
        background: bandColor, borderRadius: 6, zIndex: -1 } as React.CSSProperties,
    }),
    effect.band === undefined ? children : React.createElement('span', {
      key: 'ink', 'data-telop-effect-ink': '',
      style: { opacity: effect.opacity } as React.CSSProperties,
    }, children),
    effect.underline === undefined ? null : React.createElement('span', {
      key: 'underline', 'data-telop-effect-underline': '',
      style: { position: 'absolute', left: 0, bottom: 0, width: `${effect.underline * 100}%`,
        height: Math.max(2, fontSizePx * 0.06), background: '#facc15' } as React.CSSProperties,
    }),
  );
}

/**
 * 新 8 種のときだけ、本体の描画結果の**子**を効果層で包み、外枠の不透明度を退場フェードへ差し替える。
 * 既存 9 種は本体の戻り値をそのまま返す（1 バイトも変えない）。
 * render は必ず 1 回だけ無条件に呼ぶ（中で React のフックが走るため）。
 */
export function withTelopEffect(
  render: (segment: TelopSegment) => React.ReactElement | null,
  segment: TelopSegment, config: TelopAnimation, frame: number, fps: number,
  fontSizePx: number, bandSource: string,
): React.ReactElement | null {
  const durationFrames = segment.endFrame - segment.startFrame;
  const localFrame = frame - segment.startFrame;
  const effect = config.id !== undefined && config.effect !== undefined
    ? config.effect({ id: config.id, localFrame, durationFrames, fps, fontSizePx,
        charCount: telopGraphemeCount(segment.text) })
    : null;
  // 打ち込みは「描く前に文字を切る」。描いたあとの要素からは文字を取り出せない。
  const text = effect?.visibleChars === undefined ? segment.text
    : telopSliceGraphemes(segment.text, effect.visibleChars) + (effect.cursor ? TELOP_TYPE_CURSOR : '');
  const element = render(text === segment.text ? segment : { ...segment, text });
  if (element === null || effect === null) return element;
  const props = element.props as { style?: React.CSSProperties; children?: React.ReactNode };
  return React.cloneElement(
    element as React.ReactElement<{ style?: React.CSSProperties; children?: React.ReactNode }>,
    { style: { ...props.style, opacity: telopExitOpacity(localFrame, durationFrames, config.fadeOutDuration, fps) } },
    effectLayer(config.id!, effect, fontSizePx, telopBandColor(bandSource), props.children),
  );
}
