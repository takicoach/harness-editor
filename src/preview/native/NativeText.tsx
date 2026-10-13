import type { CSSProperties, ReactNode } from 'react';
import type { TelopSegment } from '../../core/types';
import type { TextAppearance } from '../../core/sequence/model';
import { useCurrentFrame, useVideoConfig } from '../../captureRuntime';
import {
  TELOP_TYPE_CURSOR, isNewTelopAnimation, telopAnimationEffect, telopBandColor,
  telopExitOpacity, telopGraphemeCount, telopSliceGraphemes,
} from '../../core/telopAnimation';
import { emphasisParts, stripEmphasis } from '../../core/sequence/renderExtras';
import { textBoxBackground, textBoxPadding, textOutlineLayers, textShadowFilter, textSkewTransform } from '../../core/textDecoration';

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
  // サムネで足した任意項目（帯・縁取り・影・傾き・文字枠）。無ければ従来と同じ値・同じ DOM（基準画像で固定）。
  const pad = textBoxPadding(appearance), outlines = textOutlineLayers(appearance), shadow = textShadowFilter(appearance);
  const skew = effect ? undefined : textSkewTransform(appearance);
  const style: CSSProperties = { fontFamily:appearance.fontFamily, fontSize:appearance.fontSize, fontWeight:appearance.fontWeight,
    color:appearance.color, WebkitTextStroke:outlines.length?'0px transparent':`${appearance.strokeWidth}px ${appearance.strokeColor}`, paintOrder:'stroke fill',
    background:textBoxBackground(appearance), lineHeight:appearance.lineHeight, letterSpacing:appearance.letterSpacing,
    textAlign:appearance.align, whiteSpace:'pre-wrap', overflowWrap:'anywhere', padding:`${pad.y}px ${pad.x}px`, display:'inline-block', maxWidth:'100%',
    ...(appearance.band ? { borderRadius:appearance.band.radius } : {}),
    ...(skew ? { transform:skew } : {}),
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
  // 強調語（任意項目 emphasis があるときだけ `**語**` を解釈する。無ければ従来のまま）。縁取りの重ねは `**` を除いた文字。
  const emphasis = appearance.emphasis, plain = emphasis ? stripEmphasis(text) : text;
  const body: ReactNode = emphasis && plain !== text
    ? emphasisParts(text).map((part, index) => part.emphasized ? <span key={index} data-native-text-emphasis style={{color:emphasis.color}}>{part.text}</span> : part.text)
    : plain;
  // 縁取りは同じ文字を外側から重ね、最後に線なしの塗りを載せる。影は文字の束（帯は含めない）に掛ける。
  const ink: ReactNode = outlines.length || shadow ? <span data-native-text-glyphs style={{position:'relative',display:'block',...(shadow?{filter:shadow}:{})}}>
    {outlines.map((layer,index)=><span key={index} aria-hidden="true" data-native-text-outline style={{position:'absolute',inset:0,color:layer.color,
      WebkitTextStroke:`${layer.stroke}px ${layer.color}`,paintOrder:'stroke fill'}}>{plain}</span>)}
    <span style={{position:'relative'}}>{body}</span>
  </span> : body;
  const bottom = height * (width > height ? 100/1080 : 200/1920), box = appearance.box, centered = box?.anchor === 'center', topped = box?.anchor === 'top';
  const place: CSSProperties = box ? { left:`${(1-box.width)*50}%`, width:`${box.width*100}%`, ...(centered || topped ? { top:'50%' } : { bottom }) }
    : { bottom, left:'7.5%', width:'85%' };
  const shift = centered ? (effect ? 'translateY(-50%)' : `translate(${x}px,calc(${y}px - 50%))`) : effect ? undefined : `translate(${x}px,${y}px)`;
  return length <= 0 ? null : <div data-native-text style={{position:'absolute',...place,
    textAlign:appearance.align,opacity,transform:shift,
    filter:effect?undefined:(animation.includes('Blur') ? `blur(${remaining*8}px)` : undefined)}}>
    <span data-native-text-box style={style}>
      {effect?.band === undefined ? null : <span data-native-text-band style={{position:'absolute',left:0,top:0,bottom:0,
        width:`${effect.band*100}%`,background:telopBandColor(appearance.background),borderRadius:6,zIndex:-1}}/>}
      {effect?.band===undefined?ink:<span data-native-text-ink style={{opacity:effect.opacity}}>{ink}</span>}
      {effect?.cursor ? <span data-native-text-cursor>{TELOP_TYPE_CURSOR}</span> : null}
      {effect?.underline === undefined ? null : <span data-native-text-underline style={{position:'absolute',left:0,bottom:0,
        width:`${effect.underline*100}%`,height:Math.max(2,appearance.fontSize*0.06),background:'#facc15'}}/>}
    </span>
  </div>;
}
