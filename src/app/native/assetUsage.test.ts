import {describe,it,expect} from 'vitest';
import {assetUsage} from './assetUsage';
import {documentWith} from './__fixtures__/assetFixture';

// テストは assetUsage が実際に読む content/visual/name だけを組み立てる。
// SequenceClip の残りのフィールド（clock/anchor 等）は fixture の documentWith が埋める。
const audio=(assetId:string)=>({kind:'audio',assetId,streamIndex:0,sourceIn:{num:0,den:1},rate:{num:1,den:1},
  role:'music',settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0},loop:false}) as never;
const video=(assetId:string)=>({kind:'video',assetId,streamIndex:0,sourceIn:{num:0,den:1},rate:{num:1,den:1}}) as never;
const lutVisual=(assetId:string)=>({layout:{position:'center',scale:1,background:'#000',rotation:0,flipH:false,flipV:false},
  opacity:1,keyframes:[],lut:{assetId,intensity:1}}) as never;

describe('assetUsage',()=>{
  it('どこからも参照されていなければ 0 件',()=>{
    expect(assetUsage(documentWith({}),'a1')).toMatchObject({count:0,places:[]});
  });
  it('クリップの参照を数える',()=>{
    const doc=documentWith({clips:[{id:'c1',name:'BGM',content:audio('a1')}]});
    expect(assetUsage(doc,'a1')).toMatchObject({count:1,places:['タイムライン（BGM）']});
  });
  it('カット履歴（cutArchive）の参照も数える',()=>{
    const doc=documentWith({cutArchive:{entries:[{id:'e1',clips:[{content:audio('a1')}]}],groups:[]}});
    expect(assetUsage(doc,'a1')).toMatchObject({count:1,places:['カットした部分']});
  });
  it('音声補正の元（他の素材の origin.from）も数える',()=>{
    const media=(id:string,origin?:{kind:'audio-fix';from:string;fix:'denoise'|'normalize'})=>
      ({id,kind:'media' as const,file:`public/${id}.mp4`,name:id,fingerprint:id,streams:[],...(origin?{origin}:{})});
    const doc=documentWith({assets:[media('a1'),media('a2',{kind:'audio-fix',from:'a1',fix:'denoise'})]});
    // R3-M6: ラベルは「どの素材が握っているか」（detail）を含める。固定文言「音声補正の元」だけでは
    // 複数の由来があるとき区別が付かない。
    expect(assetUsage(doc,'a1')).toEqual({count:1,places:['a2（音声補正の元）'],action:expect.stringContaining('a2')});
    expect(assetUsage(doc,'a2')).toEqual({count:0,places:[],action:expect.stringContaining('タイムライン')});
  });
  it('音声補正の元の行動指示は、タイムラインからではなく補正を戻す・外すことを案内する（R3-M6）',()=>{
    const media=(id:string,origin?:{kind:'audio-fix';from:string;fix:'denoise'|'normalize'})=>
      ({id,kind:'media' as const,file:`public/${id}.mp4`,name:id,fingerprint:id,streams:[],...(origin?{origin}:{})});
    const doc=documentWith({assets:[media('a1'),media('映像（音量正規化）',{kind:'audio-fix',from:'a1',fix:'normalize'})]});
    const usage=assetUsage(doc,'a1');
    expect(usage.action).not.toMatch(/タイムラインから外して/);
    expect(usage.action).toContain('映像（音量正規化）');
  });
  it('通常のタイムライン参照は従来どおり「先にタイムラインから外してください」を案内する（R3-M6）',()=>{
    const doc=documentWith({clips:[{id:'c1',name:'BGM',content:audio('a1')}]});
    expect(assetUsage(doc,'a1').action).toMatch(/タイムラインから外して/);
  });
  it('LUT 参照（visual.lut.assetId）も数える',()=>{
    const doc=documentWith({clips:[{id:'c1',name:'本編',content:video('a2'),visual:lutVisual('a1')}]});
    expect(assetUsage(doc,'a1')).toMatchObject({count:1,places:['カラー設定（本編）']});
  });
  it('テロップ部品（componentAssetId）も数える',()=>{
    const doc=documentWith({clips:[{id:'c1',name:'字幕',content:{kind:'telop',componentAssetId:'a1',data:{}} as never}]});
    expect(assetUsage(doc,'a1')).toMatchObject({count:1,places:['字幕のスタイル（字幕）']});
  });
  it('同じ素材の複数使用をすべて数える',()=>{
    const doc=documentWith({clips:[{id:'c1',name:'A',content:audio('a1')},{id:'c2',name:'B',content:audio('a1')}]});
    expect(assetUsage(doc,'a1').count).toBe(2);
  });
  // I3: 旧 assetUsage.ts は独自の走査で speed.source / cutArchive.sourceRecovery.sources を見落としていた。
  // sequenceAssetReferences(core の正本)に委譲したことで拾えるようになったことの回帰テスト。
  it('速度変更の基準（clip.speed.source.assetId）も使用中と数える',()=>{
    const clock={offset:{num:0,den:1},slope:{num:1,den:1},duration:{num:1,den:1}};
    const doc=documentWith({clips:[{id:'c1',name:'速度素材',content:video('a2'),
      speed:{kind:'main-audio',providerId:'p1',source:{assetId:'a1',streamIndex:0,sourceStart:{num:0,den:1},sourceEnd:{num:1,den:1}},clock} as never}]});
    expect(assetUsage(doc,'a1').count).toBe(1);
  });
  it('カット履歴の復元元（cutArchive.sourceRecovery.sources）も使用中と数える',()=>{
    const doc=documentWith({cutArchive:{entries:[{id:'e1',clips:[],
      sourceRecovery:{version:1,documentId:'doc',revision:0,ownerClipIds:[],
        sources:[{assetId:'a1',streamIndex:0,start:{num:0,den:1},end:{num:1,den:1}}]}}],groups:[]}});
    expect(assetUsage(doc,'a1')).toMatchObject({count:1,places:['カットした部分']});
  });
});
