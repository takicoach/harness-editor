/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NativeVisualSettings,visualSettingsHasContent} from './NativeVisualSettings';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {rational as r} from '../../core/sequence/time';
import type {ClipContent,SequenceClip} from '../../core/sequence/model';

afterEach(cleanup);

const CONTENTS:ClipContent[]=[
  {kind:'telop',textMode:'component',componentAssetId:'a',data:{text:'文字',template:1}},
  {kind:'title',data:{text:'章'},style:{fontSize:48,left:10,top:10}} as unknown as ClipContent,
  {kind:'video',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1)} as unknown as ClipContent,
  {kind:'image',assetId:'a'} as unknown as ClipContent,
  {kind:'shape',data:{kind:'rect',color:'#ff0000',thickness:'medium',x1:.1,y1:.1,x2:.5,y2:.5}} as unknown as ClipContent,
  {kind:'audio',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1),settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}} as unknown as ClipContent,
];
const clipWith=(content:ClipContent):SequenceClip=>({id:'clip',trackId:'track',name:'内容',startFrame:0,durationFrames:30,
  clock:{offset:r(0),rate:r(1),duration:r(30)},content,
  visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}} as SequenceClip);

/**
 * M-5: 調整タブの群は「中身が空なら見出しを出さない」を `visualSettingsHasContent` で判断する。
 * 予測と実際の描画がずれたら、空の見出しが戻る（または在る節が消える）ので、全組み合わせで突き合わせる。
 */
it('visualSettingsHasContent は実際に描くかどうかと一致する（全 clip 種別 × part）',()=>{
  const seen:string[]=[];
  for(const content of CONTENTS)for(const part of ['look','place','motion','all'] as const){
    const clip=clipWith(content);
    const view=render(<NativeVisualSettings part={part} clip={clip} visual={clip.visual!} resolution={{width:320,height:180}}
      onContent={async()=>true} onVisual={async()=>true}/>);
    const rendered=view.container.childElementCount>0;
    expect(visualSettingsHasContent(part,clip),`${content.kind}/${part}`).toBe(rendered);
    seen.push(`${content.kind}/${part}=${rendered}`);
    cleanup();
  }
  expect(seen).toHaveLength(CONTENTS.length*4);   // 存在検査（組み合わせが回っていること）
  // 代表値: テロップの「見た目」には描く節が無い（空の見出しの出どころ）。
  expect(visualSettingsHasContent('look',clipWith(CONTENTS[0]!))).toBe(false);
  expect(visualSettingsHasContent('place',clipWith(CONTENTS[0]!))).toBe(true);
});
