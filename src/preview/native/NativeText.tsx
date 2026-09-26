import type { CSSProperties } from 'react';
import type { TelopSegment } from '../../core/types';
import type { TextAppearance } from '../../core/sequence/model';
import { useCurrentFrame, useVideoConfig } from '../../captureRuntime';
import {
  TELOP_TYPE_CURSOR, isNewTelopAnimation, telopAnimationEffect, telopBandColor,
  telopExitOpacity, telopGraphemeCount, telopSliceGraphemes,
} from '../../core/telopAnimation';

/** Explicit typography for manually authored text; no project template is required. */
export function NativeText({ segment, appearance }: { segment: TelopSegment; appearance: TextAppearance }) {
  const frame = useCurrentFrame(), { fps, width, height } = useVideoConfig();
  const animation = segment.animation ?? 'none', length = segment.endFrame - segment.startFrame;
  const local = frame - segment.startFrame;
  // 新 8 種の見た目は telopAnimationEffect だけが決める。共通入退場 opacity は重ねない。
  const effect = isNewTelopAnimation(animation) && length > 0
    ? telopAnimationEffect({ id: animation, localFrame: local, durationFrames: length, fps,
        fontSizePx: appearance.fontSize, charCount: telopGraphemeCount(segment.text) })
    : null;
  const enter = Math.max(0, Math.min(1, (frame - segment.startFrame) / Math.max(1, fps * .25)));
  const exit = Math.max(0, Math.min(1, (segment.endFrame - frame) / Math.max(1, fps * .2)));
  const opacity = effect ? telopExitOpacity(local, length, 8, fps) : animation === 'none' ? 1 : Math.min(enter, exit);
  const remaining = 1 - enter;
  const style: CSSProperties = { fontFamily:appearance.fontFamily, fontSize:appearance.fontSize, fontWeight:appearance.fontWeight,
    color:appearance.color, WebkitTextStroke:`${appearance.strokeWidth}px ${appearance.strokeColor}`, paintOrder:'stroke fill',
    background:appearance.background, lineHeight:appearance.lineHeight, letterSpacing:appearance.letterSpacing,
    textAlign:appearance.align, whiteSpace:'pre-wrap', overflowWrap:'anywhere', padding:'8px 16px', display:'inline-block', maxWidth:'100%',
    // 帯を出す動き（bandLeadsText）は「帯が先に伸び、文字が後から出る」。層に opacity を当てると
    // 子の帯まで一緒に透明になり、ただのフェードに退化する。opacity は文字だけに掛ける（I-1）。
    ...(effect ? { position:'relative', transformOrigin:'center', transform:effect.transform,
      opacity:effect.band===undefined?effect.opacity:undefined,
      filter:effect.filter, clipPath:effect.clipPath } : {}) };
  const x = ['slideFromLeft','slideLeftFadeBlur','fadeFromLeft'].includes(animation) ? -remaining * 60 : animation === 'fadeFromRight' ? remaining * 60 : 0;
  const y = animation === 'slideIn' ? -remaining * 50 : animation === 'fadeBlurFromBottom' ? remaining * 40 : 0;
  const text = effect?.visibleChars !== undefined ? telopSliceGraphemes(segment.text, effect.visibleChars)
    : animation === 'charByChar' ? Array.from(new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(segment.text),part=>part.segment)
      .slice(0,Math.max(0,Math.floor((frame-segment.startFrame+1)/2))).join('') : segment.text;
  return length <= 0 ? null : <div data-native-text style={{position:'absolute',bottom:height * (width > height ? 100/1080 : 200/1920),left:'7.5%',width:'85%',
    textAlign:appearance.align,opacity,transform:effect?undefined:`translate(${x}px,${y}px)`,
    filter:effect?undefined:(animation.includes('Blur') ? `blur(${remaining*8}px)` : undefined)}}>
    <span data-native-text-box style={style}>
      {effect?.band === undefined ? null : <span data-native-text-band style={{position:'absolute',left:0,top:0,bottom:0,
        width:`${effect.band*100}%`,background:telopBandColor(appearance.background),borderRadius:6,zIndex:-1}}/>}
      {effect?.band===undefined?text:<span data-native-text-ink style={{opacity:effect.opacity}}>{text}</span>}
      {effect?.cursor ? <span data-native-text-cursor>{TELOP_TYPE_CURSOR}</span> : null}
      {effect?.underline === undefined ? null : <span data-native-text-underline style={{position:'absolute',left:0,bottom:0,
        width:`${effect.underline*100}%`,height:Math.max(2,appearance.fontSize*0.06),background:'#facc15'}}/>}
    </span>
  </div>;
}
