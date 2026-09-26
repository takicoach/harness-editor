import {expect,it} from 'vitest';
import {applySequenceCommand,previewCutRestoration} from '../../core/sequence/commands';
import type {CutArchiveEntry,SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {parseSequence,serializeSequence} from '../../core/sequence/validate';
import {buildFinishDisplayMap,finishDisplayPoint,finishLiveToDisplay,finishArchivedToDisplay,projectFinishLiveRange} from './finishDisplayMap';

function fixture():SequenceDocument{return {schemaVersion:2,id:'finish',name:'仕上げ',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};}
function entry(id:string,frame:number,durationFrames:number):CutArchiveEntry{return {id,durationFrames,completionFloorFrames:durationFrames,origin:{cutId:id,startFrame:0,endFrame:durationFrames},boundary:{references:[],hintFrame:frame,ambiguous:false},clips:[],tracks:[]};}
function twoCuts(){const d=fixture();d.cutArchive={version:1,entries:[entry('b',90,20),entry('a',30,10)]};return d;}
it('keeps an uncut timeline, including its empty background, on the completion axis',()=>{
 const map=buildFinishDisplayMap(fixture());expect(map.completionEnd).toBe(120);expect(map.displayEnd).toBe(120);expect(map.cuts).toEqual([]);expect(map.unresolved).toEqual([]);
 expect(finishDisplayPoint(map,45.25,'after')).toEqual({kind:'live',frame:45.25});expect(projectFinishLiveRange(map,20,60)).toEqual([{displayStart:20,displayEnd:60,startFrame:20,endFrame:60}]);
});
it('inserts every resolved cut in completion order without rewriting the document',()=>{
 const d=twoCuts(),before=structuredClone(d),map=buildFinishDisplayMap(d);
 expect(map.displayEnd).toBe(150);expect(map.cuts.map(c=>[c.cut,c.start,c.end,c.entryIds])).toEqual([[{kind:'entry',id:'a'},30,40,['a']],[{kind:'entry',id:'b'},100,120,['b']]]);
 expect(map.blocks.map(b=>[b.kind,b.displayStart,b.displayEnd])).toEqual([['live',0,30],['archived',30,40],['live',40,100],['archived',100,120],['live',120,150]]);
 expect(d).toEqual(before);map.cuts[0]!.entryIds.push('external');expect(d).toEqual(before);
});
it('splits a later overlay or caption crossing seams, without stretching through the archived bands',()=>{
 const map=buildFinishDisplayMap(twoCuts());expect(projectFinishLiveRange(map,20,110)).toEqual([
  {displayStart:20,displayEnd:30,startFrame:20,endFrame:30},
  {displayStart:40,displayEnd:100,startFrame:30,endFrame:90},
  {displayStart:120,displayEnd:140,startFrame:90,endFrame:110},
 ]);
 expect(projectFinishLiveRange(map,30,90)).toEqual([{displayStart:40,displayEnd:100,startFrame:30,endFrame:90}]);
 expect(projectFinishLiveRange(map,30,30)).toEqual([]);
});
it('requires an explicit side at joins and returns saved local units, not insertion duration',()=>{
 const map=buildFinishDisplayMap(twoCuts());
 expect(finishDisplayPoint(map,30,'before')).toEqual({kind:'live',frame:30});expect(finishDisplayPoint(map,30,'after')).toEqual({kind:'archived',entryId:'a',localFrame:0});
 expect(finishDisplayPoint(map,40,'before')).toEqual({kind:'archived',entryId:'a',localFrame:10});expect(finishDisplayPoint(map,40,'after')).toEqual({kind:'live',frame:30});
 expect(finishLiveToDisplay(map,30,'before')).toBe(30);expect(finishLiveToDisplay(map,30,'after')).toBe(40);
 expect(finishArchivedToDisplay(map,'b',7.5)).toBe(107.5);
});
it('preserves explicit group member order even when the archive inventory is differently ordered',()=>{
 const d=fixture();d.cutArchive={version:1,entries:[entry('old',40,30),entry('new',40,5)],groups:[{id:'g',entryIds:['new','old']}]};
 const map=buildFinishDisplayMap(d);expect(map.cuts).toEqual([{cut:{kind:'group',id:'g'},entryIds:['new','old'],atFrame:40,start:40,end:75}]);
 expect(finishDisplayPoint(map,45,'before')).toEqual({kind:'archived',entryId:'new',localFrame:5});expect(finishDisplayPoint(map,45,'after')).toEqual({kind:'archived',entryId:'old',localFrame:0});
 expect(finishArchivedToDisplay(map,'old',30)).toBe(75);
});
it('does not invent order for independent cuts at one seam, including an otherwise ordered group',()=>{
 const d=fixture();d.cutArchive={version:1,entries:[entry('a',30,10),entry('b',30,20),entry('c',30,5),entry('safe',80,7)],groups:[{id:'g',entryIds:['b','c']}]};
 const map=buildFinishDisplayMap(d);expect(map.cuts.map(c=>c.entryIds)).toEqual([['safe']]);expect(map.displayEnd).toBe(127);
 expect(map.unresolved.map(c=>[c.cut,c.entryIds,c.frame,c.code])).toEqual([[{kind:'group',id:'g'},['b','c'],30,'unknown-order'],[{kind:'entry',id:'a'},['a'],30,'unknown-order']]);
 expect(finishArchivedToDisplay(map,'a',0)).toBeNull();
});
it('lists ambiguous, missing-reference and split-boundary groups without guessing their hint positions',()=>{
 const d=fixture(),a=entry('a',20,10),b=entry('b',50,10),c=entry('c',60,10),e=entry('lost',70,10);
 a.boundary.ambiguous=true;e.boundary.references=[{clipId:'removed',edge:'end',offsetFrames:0}];
 d.cutArchive={version:1,entries:[a,b,c,e],groups:[{id:'split',entryIds:['b','c']}]};
 const map=buildFinishDisplayMap(d);expect(map.cuts).toEqual([]);expect(map.displayEnd).toBe(120);expect(map.unresolved).toHaveLength(3);expect(map.unresolved.every(u=>u.frame===null&&u.reason.length>0)).toBe(true);
});
it('supports leading, trailing and fully cut timelines without manufacturing live spans',()=>{
 const d=fixture();d.cutArchive={version:1,entries:[entry('head',0,10),entry('tail',120,20)]};const map=buildFinishDisplayMap(d);
 expect(finishLiveToDisplay(map,0,'before')).toBe(0);expect(finishLiveToDisplay(map,0,'after')).toBe(10);expect(finishLiveToDisplay(map,120,'before')).toBe(130);expect(finishLiveToDisplay(map,120,'after')).toBe(150);
 expect(finishDisplayPoint(map,0,'before')).toEqual({kind:'archived',entryId:'head',localFrame:0});expect(finishDisplayPoint(map,150,'after')).toEqual({kind:'archived',entryId:'tail',localFrame:20});
 d.sequenceEndFrame=0;d.cutArchive={version:1,entries:[entry('all',0,120)]};const all=buildFinishDisplayMap(d);expect(all.blocks).toHaveLength(1);expect(projectFinishLiveRange(all,0,0)).toEqual([]);expect(finishDisplayPoint(all,35,'after')).toEqual({kind:'archived',entryId:'all',localFrame:35});
});
it('roundtrips fractional and integer coordinates for every live and archived block',()=>{
 const map=buildFinishDisplayMap(twoCuts());
 for(const b of map.blocks)for(const delta of [0.25,1,(b.displayEnd-b.displayStart)/2,b.displayEnd-b.displayStart-0.25]){
  const point=finishDisplayPoint(map,b.displayStart+delta,'after')!;
  expect(point.kind==='live'?finishLiveToDisplay(map,point.frame,'after'):finishArchivedToDisplay(map,point.entryId,point.localFrame)).toBe(b.displayStart+delta);
 }
});
it.each([NaN,Infinity,-1,151])('rejects invalid display input %s instead of clamping it into a different owner',value=>{
 expect(finishDisplayPoint(buildFinishDisplayMap(twoCuts()),value,'after')).toBeNull();
});
it('rejects invalid completion, archive and range inputs',()=>{
 const map=buildFinishDisplayMap(twoCuts());expect(finishLiveToDisplay(map,121,'after')).toBeNull();expect(finishLiveToDisplay(map,NaN,'before')).toBeNull();
 expect(finishArchivedToDisplay(map,'missing',0)).toBeNull();expect(finishArchivedToDisplay(map,'a',11)).toBeNull();expect(finishArchivedToDisplay(map,'a',-1)).toBeNull();
 expect(projectFinishLiveRange(map,-1,10)).toEqual([]);expect(projectFinishLiveRange(map,20,10)).toEqual([]);expect(projectFinishLiveRange(map,0,121)).toEqual([]);
});
it('keeps a real cut ID linked across save/load, unrelated edits, partial restore and subsequent cut',()=>{
 let d=fixture();d.tracks=[{id:'t',kind:'visual',name:'字幕',enabled:true}];d.clips=[{id:'caption',name:'本文',trackId:'t',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}}}];
 d=applySequenceCommand(d,{type:'ripple-delete',startFrame:30,endFrame:60});const id=d.cutArchive!.entries[0]!.id;
 d=parseSequence(serializeSequence(d));expect(buildFinishDisplayMap(d).cuts[0]).toMatchObject({cut:{kind:'entry',id},start:30,end:60});
 const before=buildFinishDisplayMap(d);d=applySequenceCommand(d,{type:'update-clip',clipId:d.clips[0]!.id,patch:{name:'別の後編集'}});expect(buildFinishDisplayMap(d)).toEqual(before);
 d=applySequenceCommand(d,{type:'restore-cut',entryId:id,range:{startFrame:0,endFrame:10}});expect(buildFinishDisplayMap(d).cuts.map(c=>[c.start,c.end])).toEqual([[40,60]]);
 d=applySequenceCommand(d,{type:'ripple-delete',startFrame:70,endFrame:80});const map=buildFinishDisplayMap(d);expect(map.cuts.map(c=>[c.start,c.end])).toEqual([[40,60],[90,100]]);expect(map.unresolved).toEqual([]);expect(map.displayEnd).toBe(120);
});
function repeatedMedia(){
 const d=fixture();d.assets=[{id:'media',kind:'media',name:'同じ素材',file:'source.mp4',fingerprint:'fixture',streams:[{kind:'video',index:0,codec:'h264',width:320,height:180,frameRate:r(30),duration:r(10)}]}];d.tracks=[{id:'v',kind:'visual',name:'映像',enabled:true}];
 d.clips=[0,60].map((startFrame,index)=>({id:`occurrence-${index}`,name:'同じ素材の同じ秒',trackId:'v',startFrame,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'video' as const,assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}}));return d;
}
it('keeps repeated same-asset/source occurrences separate and follows their actual completion boundaries',()=>{
 let d=applySequenceCommand(repeatedMedia(),{type:'ripple-delete',startFrame:10,endFrame:20});
 d=applySequenceCommand(d,{type:'ripple-delete',startFrame:60,endFrame:70});
 const map=buildFinishDisplayMap(parseSequence(serializeSequence(d)));expect(map.cuts.map(c=>[c.atFrame,c.start,c.end])).toEqual([[10,10,20],[60,70,80]]);
 const entries=d.cutArchive!.entries;expect(entries[0]!.clips[0]!.content).toEqual(entries[1]!.clips[0]!.content);
 expect(entries[0]!.clips[0]!.id).not.toBe(entries[1]!.clips[0]!.id);
 expect(finishDisplayPoint(map,15,'after')).toEqual({kind:'archived',entryId:entries[0]!.id,localFrame:5});
 expect(finishDisplayPoint(map,75,'after')).toEqual({kind:'archived',entryId:entries[1]!.id,localFrame:5});
});
it('keeps mixed saved speed bases unchanged while live spans use the current speed',()=>{
 let d=applySequenceCommand(repeatedMedia(),{type:'register-native-speed',groupId:'speed',mainClipIds:['occurrence-0','occurrence-1'],mainAudioBindings:[]});
 d=applySequenceCommand(d,{type:'ripple-delete',startFrame:10,endFrame:30});const originalEntry=d.cutArchive!.entries[0]!.id;
 d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(2)});
 expect(previewCutRestoration(d,originalEntry).durationFrames).toBe(10);
 const at=buildFinishDisplayMap(d).cuts[0]!;expect([at.atFrame,at.start,at.end]).toEqual([5,5,25]);
 const adjacent=d.clips.find(c=>c.startFrame+c.durationFrames===5)!;
 d=applySequenceCommand(d,{type:'resize-cut-boundary',cut:{kind:'entry',id:originalEntry},edge:'start',target:{kind:'live',clipId:adjacent.id,frame:3}});
 const bytes=serializeSequence(d),map=buildFinishDisplayMap(parseSequence(bytes));
 expect(map.completionEnd).toBe(48);expect(map.displayEnd).toBe(70);expect(map.cuts.map(c=>[c.atFrame,c.start,c.end])).toEqual([[3,3,25]]);
 const saved=map.blocks.filter(b=>b.kind==='archived');expect(saved.map(b=>b.localEnd)).toEqual([2,20]);
 expect(finishDisplayPoint(map,6,'after')).toEqual({kind:'archived',entryId:originalEntry,localFrame:1});
 expect(serializeSequence(d)).toBe(bytes);
});
it('moves display placement only when proven live references move together; mismatched references become unresolved',()=>{
 const d=fixture();d.tracks=[{id:'t',kind:'visual',name:'字幕',enabled:true}];
 d.clips=[{id:'left',name:'left',trackId:'t',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'telop',data:{text:'左'}}},{id:'right',name:'right',trackId:'t',startFrame:30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'telop',data:{text:'右'}}}];
 const saved=entry('saved',30,10);saved.boundary.references=[{clipId:'left',edge:'end',offsetFrames:0},{clipId:'right',edge:'start',offsetFrames:0}];d.cutArchive={version:1,entries:[saved]};
 expect(buildFinishDisplayMap(d).cuts[0]!.start).toBe(30);d.clips.forEach(c=>{c.startFrame+=20;});expect(buildFinishDisplayMap(d).cuts[0]!.start).toBe(50);
 d.clips[1]!.startFrame++;expect(buildFinishDisplayMap(d).cuts).toEqual([]);expect(buildFinishDisplayMap(d).unresolved[0]!.code).toBe('unresolved-boundary');
});
it('defines an empty timeline origin without creating a phantom range',()=>{
 const d=fixture();d.sequenceEndFrame=0;const map=buildFinishDisplayMap(d);expect(map.blocks).toEqual([]);expect(map.displayEnd).toBe(0);expect(finishDisplayPoint(map,0,'after')).toEqual({kind:'live',frame:0});expect(finishLiveToDisplay(map,0,'before')).toBe(0);
});
