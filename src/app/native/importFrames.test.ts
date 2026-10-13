import {expect,it} from 'vitest';
import {fixture} from '../../core/sequence/fixtures';
import {rational as r} from '../../core/sequence/time';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {applySequenceCommand} from '../../core/sequence/commands';
import {buildAppendToMain} from '../../core/sequence/mainAppend';
import type {ImportBatchView} from '../../shared/importBatches';
import {importFrames,importPhaseLabel,IMPORT_PLACEHOLDER_SECONDS,unplacedConfirmedImports} from './importFrames';

const doc=():SequenceDocument=>{const d=fixture();d.tracks=d.tracks.map(t=>t.id==='v1'?{...t,id:'v-main'}:t);d.clips=d.clips.map(c=>c.trackId==='v1'?{...c,trackId:'v-main'}:c);return d;};
const batch=(batchId:string,phase:ImportBatchView['phase'],items:Partial<ImportBatchView['items'][number]>[]):ImportBatchView=>({batchId,projectId:'p',createdAt:'2026-10-02T00:00:00.000Z',origin:{kind:'ui'},placement:'append-main',mode:'link',phase,
  items:items.map((item,index)=>({itemId:`i${index}`,key:String(index),name:`take${index}.mp4`,phase:'probing',...item}))});
it('starts at the main end and stacks frames in acceptance order using the best known length',()=>{
  const frames=importFrames(doc(),[batch('imp-aaaaaaaaaaaaaaaaaaaa','preparing',[{durationSeconds:2},{},{phase:'waiting'}])],(_b,item)=>item.key==='1'?1.5:undefined);
  expect(frames.map(f=>[f.startFrame,f.durationFrames,f.estimated,f.first])).toEqual([[300,60,false,true],[360,45,false,false],[405,IMPORT_PLACEHOLDER_SECONDS*30,true,false]]);
  expect(frames[0]!.batchSize).toBe(3);
});
it('skips cancelled items, finished batches and a batch already placed in the document',()=>{
  const placed={...doc(),clips:[...doc().clips,{...doc().clips[0]!,id:'imp-bbbbbbbbbbbbbbbbbbbb-2',startFrame:300}]};
  expect(importFrames(placed,[batch('imp-bbbbbbbbbbbbbbbbbbbb','ready',[{phase:'ready',durationSeconds:1}])],()=>undefined)).toEqual([]);
  expect(importFrames(doc(),[batch('imp-cccccccccccccccccccc','confirmed',[{phase:'ready'}]),batch('imp-dddddddddddddddddddd','cancelled',[{phase:'cancelled'}])],()=>undefined)).toEqual([]);
  expect(importFrames(doc(),[batch('imp-eeeeeeeeeeeeeeeeeeee','partial',[{phase:'cancelled'},{phase:'failed',error:'壊れています'}])],()=>undefined).map(f=>[f.itemId,f.error])).toEqual([['i1','壊れています']]);
});
it('converts seconds with the document fps',()=>{
  expect(importFrames({...doc(),fps:r(60)},[batch('imp-ffffffffffffffffffff','preparing',[{durationSeconds:1}])],()=>undefined)[0]!.durationFrames).toBe(60);
});
it('finds a confirmed batch whose placement is not in the document (marked, then the document was not saved)',()=>{
  const confirmed=(revision:number):ImportBatchView=>({...batch('imp-jjjjjjjjjjjjjjjjjjjj','confirmed',[{phase:'ready',assetId:'asset-new'}]),confirmed:{executionId:'e',revision}});
  const base={...doc(),revision:3};
  expect(unplacedConfirmedImports(base,[confirmed(4)]).map(b=>b.batchId)).toEqual(['imp-jjjjjjjjjjjjjjjjjjjj']);
  // 確定の後の「元に戻す」は版が進む（印より後）ので出さない
  expect(unplacedConfirmedImports({...base,revision:5},[confirmed(4)])).toEqual([]);
  expect(unplacedConfirmedImports({...base,clips:[...base.clips,{...base.clips[0]!,id:'imp-jjjjjjjjjjjjjjjjjjjj-1'}]},[confirmed(4)])).toEqual([]);
  expect(unplacedConfirmedImports({...base,assets:[...base.assets,{...base.assets[0]!,id:'asset-new'}]},[confirmed(4)])).toEqual([]);
  expect(unplacedConfirmedImports(base,[batch('imp-kkkkkkkkkkkkkkkkkkkk','ready',[{phase:'ready',assetId:'asset-new'}])])).toEqual([]);
});
const video=(id:string,num:number,den=1):SequenceAsset=>({id,kind:'media',file:`.harness/assets/${id}.mp4`,name:`${id}.mp4`,fingerprint:id.padEnd(64,'0'),
  streams:[{index:0,kind:'video',codec:'h264',duration:r(num,den),frameRate:r(30),width:320,height:180}]});
it('lets a failed item stand aside so the later frames sit exactly where the confirm (skipping failures) places them',()=>{
  const frames=importFrames(doc(),[batch('imp-llllllllllllllllllll','partial',[{phase:'failed',error:'壊れています',durationSeconds:2},{phase:'ready',durationSeconds:1},{phase:'failed',error:'読めません'},{phase:'ready',durationSeconds:1.5}]),
    batch('imp-mmmmmmmmmmmmmmmmmmmm','preparing',[{durationSeconds:1}])],()=>undefined);
  const plan=buildAppendToMain(doc(),[video('l1',1),video('l3',3,2),video('m0',1)],(()=>{let n=0;return ()=>`n${++n}`;})());
  if('error' in plan)throw new Error(plan.error);
  const placed=applySequenceCommand(doc(),plan.command).clips.filter(c=>c.trackId==='v-main'&&c.content.kind==='video'&&['l1','l3','m0'].includes(c.content.assetId)).map(c=>[c.startFrame,c.durationFrames]);
  expect(placed).toHaveLength(3);
  const at=(batchId:string,itemId:string)=>frames.find(f=>f.batchId===batchId&&f.itemId===itemId)!;
  expect([at('imp-llllllllllllllllllll','i1'),at('imp-llllllllllllllllllll','i3'),at('imp-mmmmmmmmmmmmmmmmmmmm','i0')].map(f=>[f.startFrame,f.durationFrames])).toEqual(placed);
  // 失敗した枠は並ぶ枠の後ろ（後続を押し出さない）。取り消しボタンは束の最初に並ぶ枠に付く。
  const end=Math.max(...placed.map(([start,length])=>start!+length!));
  expect(at('imp-llllllllllllllllllll','i0').startFrame).toBeGreaterThanOrEqual(end);expect(at('imp-llllllllllllllllllll','i2').startFrame).toBeGreaterThanOrEqual(end);
  expect(frames.filter(f=>f.first).map(f=>[f.batchId,f.itemId])).toEqual([['imp-llllllllllllllllllll','i1'],['imp-mmmmmmmmmmmmmmmmmmmm','i0']]);
  expect(importFrames(doc(),[batch('imp-nnnnnnnnnnnnnnnnnnnn','failed',[{phase:'failed',error:'x'},{phase:'failed',error:'y'}])],()=>undefined).map(f=>[f.itemId,f.first])).toEqual([['i0',true],['i1',false]]);
});
it('leaves out the audio-only items (registered, never placed) and counts only the frames that will be placed on the cancel button',()=>{
  const frames=importFrames(doc(),[batch('imp-oooooooooooooooooooo','partial',[{phase:'ready',durationSeconds:1},{phase:'ready',audioOnly:true,durationSeconds:3},{phase:'failed',error:'x'},{phase:'probing'}])],()=>undefined);
  expect(frames.map(f=>[f.itemId,f.startFrame])).toEqual([['i0',300],['i3',330],['i2',330+IMPORT_PLACEHOLDER_SECONDS*30]]);
  expect(frames.find(f=>f.first)!.batchSize).toBe(2);
  // 全部失敗した束は、失敗した本数（閉じると消える本数）
  expect(importFrames(doc(),[batch('imp-pppppppppppppppppppp','failed',[{phase:'failed',error:'x'},{phase:'failed',error:'y'}])],()=>undefined)[0]!.batchSize).toBe(2);
  expect(importFrames(doc(),[batch('imp-qqqqqqqqqqqqqqqqqqqq','ready',[{phase:'ready',audioOnly:true}])],()=>undefined)).toEqual([]);
});
it('keeps a batch waiting for a decision on the timeline: held, judged and copying items keep their frames and labels',()=>{
  const deciding=batch('imp-gggggggggggggggggggg','deciding',[{phase:'awaiting-decision'},{phase:'ready',durationSeconds:1}]),copying=batch('imp-hhhhhhhhhhhhhhhhhhhh','preparing',[{phase:'copying'},{phase:'judging'}]);
  expect(importFrames(doc(),[deciding,copying],()=>undefined).map(f=>[f.batchId,f.phase])).toEqual([[deciding.batchId,'awaiting-decision'],[deciding.batchId,'ready'],[copying.batchId,'copying'],[copying.batchId,'judging']]);
  expect((['judging','awaiting-decision','copying'] as const).map(importPhaseLabel)).toEqual(['読み取りの速さを確認中','コピーするか確認待ち','速いドライブへコピー中']);
});
