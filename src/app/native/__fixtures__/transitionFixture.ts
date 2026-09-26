import {applySequenceCommand} from '../../../core/sequence/commands';
import type {SequenceClip,SequenceDocument} from '../../../core/sequence/model';
import {planTransition,type OverlapTransitionKind} from '../../../core/sequence/transitions';
import {rational as r} from '../../../core/sequence/time';

/** 映像 2 本が隙間なく並ぶ最小文書のつなぎ目。`sceneFadeTargetKey({kind:'join'})` と同じ形。 */
export const TWO_CLIP_JOIN_KEY='join:t1:c1:c2';

export interface TwoClipOptions {
  /** 既に転換が付いた状態（`set-transition` を実際に通して重なりを作る）。 */
  transition?:{kind:OverlapTransitionKind;durationFrames:number};
  /** 余白（ハンドル）を両側ゼロにする。値は 0 のみを受ける。 */
  handles?:{outHandle:0;inHandle:0};
  /** つなぎ目に場面フェード（単色）が付いた状態。 */
  sceneFade?:boolean;
  /** 速度を登録済みにする（`set-transition` が SPEED_REGISTERED で拒否する状態）。 */
  speedRegistered?:boolean;
  /** `joinKey`／`joinFrame` を持たない旧形式の転換を 1 件足す。 */
  legacyTransition?:boolean;
  /** 並べる映像の本数（既定 2）。3 にするとつなぎ目が 2 つになる。 */
  clips?:number;
}

/**
 * 映像 2 本（各 150fr）が隙間なく並ぶ文書。素材は 60 秒あるので両側に余白があり、
 * `handles` を指定したときだけ素材を使い切った形（余白ゼロ）にする。
 */
export function twoClipDocument(options:TwoClipOptions={}):SequenceDocument{
  const noHandles=options.handles!==undefined;
  const video=(id:string,name:string,startFrame:number):SequenceClip=>({
    id,name,trackId:'t1',startFrame,durationFrames:150,
    clock:{offset:r(0),rate:r(1),duration:r(150)},
    // 余白ゼロの検証では次の映像を素材の先頭から使い、前の映像で素材を使い切る。
    content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:noHandles&&id==='c2'?r(0):r(20),rate:r(1)},
  });
  let doc:SequenceDocument={
    schemaVersion:2,id:'doc',name:'転換の検証',revision:0,fps:r(30),
    resolution:{width:1920,height:1080},sequenceEndFrame:Math.max(2,options.clips??2)*150,background:'#000000',
    ducking:{enabled:false,strength:'mid'},
    assets:[{id:'source',kind:'media',file:'public/source.mp4',name:'映像',fingerprint:'test-source',
      streams:[{index:0,kind:'video',codec:'h264',duration:noHandles?r(25):r(60),frameRate:r(30),width:1920,height:1080}]}],
    tracks:[{id:'t1',kind:'visual',name:'映像1',enabled:true}],
    clips:Array.from({length:Math.max(2,options.clips??2)},(_,index)=>video(`c${index+1}`,`映像${index+1}`,index*150)),
    transitions:[],transcripts:[],
  };
  if(options.sceneFade)doc=applySequenceCommand(doc,{type:'set-scene-fades',
    targets:[{kind:'join',trackId:'t1',outClipId:'c1',inClipId:'c2'}],change:{enabled:true,color:'#000000'}});
  if(options.transition){
    const planned=planTransition(doc,TWO_CLIP_JOIN_KEY,options.transition.kind,options.transition.durationFrames);
    if('error' in planned)throw new Error(`fixture: ${planned.error}`);
    doc=applySequenceCommand(doc,{type:'set-transition',joinKey:TWO_CLIP_JOIN_KEY,transition:planned.transition});
  }
  if(options.legacyTransition)doc={...doc,transitions:[...doc.transitions,
    // 旧データの転換は joinKey／joinFrame を持たない（T0c: この形式は set-transition で解除できない）。
    {id:'legacy-transition',trackId:'t1',outClipId:'c1',inClipId:'c2',kind:'crossfade',startFrame:140,durationFrames:10}]};
  if(options.speedRegistered)doc={...doc,clips:doc.clips.map(clip=>clip.content.kind==='video'
    // UI は「速度が登録されているか」だけを見る。中身は set-transition 側の拒否条件と同じ「speed が存在する」こと。
    ?{...clip,speed:{version:1} as unknown as SequenceClip['speed']}:clip)};
  return doc;
}
