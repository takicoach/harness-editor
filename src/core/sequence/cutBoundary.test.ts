import {expect,it} from 'vitest';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {type SequenceDocument,effectFrameAt,sourceTimeAt} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence,validateSequenceDocument} from './validate';
import {readCutBoundaryGroup,validateResizeCutBoundaryCommand} from './cutBoundary';
import {SequenceSession} from './session';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}
const sample=(d:SequenceDocument,at:number)=>d.clips.filter(c=>c.startFrame<=at&&at<c.startFrame+c.durationFrames).map(c=>({kind:c.content.kind,track:c.trackId,clock:effectFrameAt(c,at),source:c.content.kind==='video'||c.content.kind==='audio'?sourceTimeAt(c,at,d.fps):null,text:c.content.kind==='telop'?c.content.data.text:null})).sort((a,b)=>a.track.localeCompare(b.track));

const cut=(d:SequenceDocument)=>applySequenceCommand(d,{type:'ripple-delete',startFrame:30,endFrame:60});
const resize=(d:SequenceDocument,edge:'start'|'end',target:unknown,selection?:unknown)=>applySequenceCommand(d,{type:'resize-cut-boundary',cut:selection??{kind:'entry',id:d.cutArchive!.entries[0]!.id},edge,target} as SequenceCommand);
function same(a:SequenceDocument,b:SequenceDocument){expect(a.sequenceEndFrame).toBe(b.sequenceEndFrame);for(let i=0;i<a.sequenceEndFrame;i++)expect(sample(a,i)).toEqual(sample(b,i));}
it.each(['start','end'] as const)('shrinks %s edge using archived local frames without affecting the other edge',edge=>{
 const original=fixture(),d=cut(original),id=d.cutArchive!.entries[0]!.id;
 const next=resize(d,edge,{kind:'archived',entryId:id,localFrame:edge==='start'?10:20});
 expect(next.sequenceEndFrame).toBe(100);expect(next.cutArchive!.entries[0]!.durationFrames).toBe(20);
 const full=applySequenceCommand(next,{type:'restore-cut',entryId:next.cutArchive!.entries[0]!.id});same(full,original);
});
function extend(d:SequenceDocument,edge:'start'|'end',amount=10){
 const group=readCutBoundaryGroup(d,{kind:'entry',id:d.cutArchive!.entries[0]!.id}),at=group.frame!;
 const clip=d.clips.find(c=>c.content.kind==='video'&&group.adjacentLive[edge].includes(c.id))!;
 return resize(d,edge,{kind:'live',clipId:clip.id,frame:at+(edge==='start'?-amount:amount)},group.cut);
}
it('extends both edges repeatedly, saves ordered bands, and shrinks through multiple members in one revision',()=>{
 const original=fixture();let d=extend(extend(cut(original),'start'),'end');
 d=extend(d,'start',5);d=extend(d,'end',5);d=parseSequence(serializeSequence(d));
 const group=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id});
 expect(group.entries.map(e=>e.entry.durationFrames)).toEqual([5,10,30,10,5]);
 const next=resize(d,'start',{kind:'archived',entryId:group.entryIds[2],localFrame:10},group.cut);
 expect(next.revision).toBe(d.revision+1);expect(next.sequenceEndFrame).toBe(85);
 expect(next.cutArchive!.groups![0]!.entryIds.map(id=>next.cutArchive!.entries.find(e=>e.id===id)!.durationFrames)).toEqual([20,10,5]);
 const rest=readCutBoundaryGroup(next,{kind:'group',id:next.cutArchive!.groups![0]!.id});
 const done=resize(next,'end',{kind:'archived',entryId:rest.entryIds[0],localFrame:0},rest.cut);same(done,original);
});
it('is one session undo/redo step, and replay does not grow a second band',()=>{
 const before=cut(fixture()),session=new SequenceSession('session',before);
 const command={type:'resize-cut-boundary' as const,cut:{kind:'entry' as const,id:before.cutArchive!.entries[0]!.id},edge:'start' as const,target:{kind:'live' as const,clipId:'v1',frame:20}};
 const request={sessionId:'session',executionId:'resize',expectedRevision:before.revision,command};
 const result=session.execute(request);expect(result.changed).toBe(true);expect(result.document.revision).toBe(before.revision+1);
 expect(session.execute(request).replayed).toBe(true);
 const undone=session.execute({sessionId:'session',executionId:'undo',expectedRevision:session.document.revision,command:{type:'undo'}}).document;
 expect({...undone,revision:before.revision}).toEqual(before);
 const redone=session.execute({sessionId:'session',executionId:'redo',expectedRevision:session.document.revision,command:{type:'redo'}}).document;
 expect({...redone,revision:result.document.revision}).toEqual(result.document);
 const group=redone.cutArchive!.groups![0]!,last=redone.cutArchive!.entries.find(e=>e.id===group.entryIds.at(-1))!;
 const shrink=session.execute({sessionId:'session',executionId:'shrink',expectedRevision:redone.revision,command:{type:'resize-cut-boundary',cut:{kind:'group',id:group.id},edge:'start',target:{kind:'archived',entryId:last.id,localFrame:last.durationFrames}}});
 expect(shrink.document.sequenceEndFrame).toBe(120);expect(shrink.document.revision).toBe(redone.revision+1);
 const undoneGroup=session.execute({sessionId:'session',executionId:'undo-multi',expectedRevision:shrink.document.revision,command:{type:'undo'}}).document;
 expect({...undoneGroup,revision:redone.revision}).toEqual(redone);
});
it.each(['start','end'] as const)('leaves a boundary click and zero restored extent unchanged at %s',edge=>{
 const d=cut(fixture()),g=readCutBoundaryGroup(d,{kind:'entry',id:d.cutArchive!.entries[0]!.id});
 expect(resize(d,edge,{kind:'archived',entryId:g.entryIds[0],localFrame:edge==='start'?0:30})).toBe(d);
 expect(resize(d,edge,{kind:'live',clipId:g.adjacentLive[edge][0],frame:g.frame})).toBe(d);
});
it('exposes isolated saved owners even when live boundaries are ambiguous and refuses editing them',()=>{
 let d=cut(fixture());const right=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===30)!;
 d=applySequenceCommand(d,{type:'move',clipIds:[right.id],deltaFrames:5,linked:false});const bytes=serializeSequence(d);
 const g=readCutBoundaryGroup(d,{kind:'entry',id:d.cutArchive!.entries[0]!.id});expect(g.frame).toBeNull();expect(g.adjacentLive).toEqual({start:[],end:[]});expect(g.entries[0]!.owners).toHaveLength(2);
 g.entries[0]!.entry.clips[0]!.name='unowned';g.entries[0]!.graph.assets[0]!.file='other';g.entries[0]!.owners[0]!.sourceIn.num=999;
 expect(serializeSequence(d)).toBe(bytes);
 expect(()=>resize(d,'start',{kind:'live',clipId:'v1',frame:20})).toThrow('境界');
 expect(()=>resize(d,'start',{kind:'archived',entryId:d.cutArchive!.entries[0]!.id,localFrame:10})).toThrow('境界');
 expect(serializeSequence(d)).toBe(bytes);
});
it('does not let a same-source second occurrence authorize a remote cut',()=>{
 const original=fixture();original.sequenceEndFrame=240;original.clips.push(...structuredClone(original.clips).map(c=>({...c,id:c.id+'-again',startFrame:120,linkGroupId:c.linkGroupId?'again':undefined,...(c.anchor?.kind==='source'?{anchor:{...c.anchor,clipOccurrenceId:'a1-again'}}:{})})));
 const d=cut(original),bytes=serializeSequence(d);expect(()=>resize(d,'end',{kind:'live',clipId:'v1-again',frame:140})).toThrow('接する');expect(serializeSequence(d)).toBe(bytes);
});
const register=(d=fixture())=>applySequenceCommand(d,{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});
const rate=(d:SequenceDocument,n:number,den=1)=>applySequenceCommand(d,{type:'set-native-global-speed',rate:r(n,den)});
it.each(['start','end'] as const)('retains different saved rate units and AV/effect/caption intent across %s groups',edge=>{
 const original=register(),saved=cut(original),changed=rate(saved,4),grown=extend(changed,edge,5);
 const group=readCutBoundaryGroup(grown,{kind:'group',id:grown.cutArchive!.groups![0]!.id});
 expect(group.entries.map(e=>e.entry.durationFrames)).toEqual(edge==='start'?[5,30]:[30,5]);
 expect(group.entries.map(e=>e.entry.speed!.globalRate)).toEqual(edge==='start'?[r(4),r(2)]:[r(2),r(4)]);
 const current=rate(parseSequence(serializeSequence(grown)),1),target=group.entries[edge==='start'?group.entries.length-1:0]!.entry;
 const done=resize(current,edge,{kind:'archived',entryId:target.id,localFrame:edge==='start'?target.durationFrames:0},group.cut);
 same(done,rate(original,1));
});
it('keeps later visible text edits, and a failed outer batch cannot consume an archive member',()=>{
 let d=extend(cut(fixture()),'start');const live=d.clips.find(c=>c.content.kind==='telop'&&c.startFrame===20)!;
 d=applySequenceCommand(d,{type:'update-clip',clipId:live.id,patch:{content:{kind:'telop',data:{text:'独立した後編集'}}}});
 const group=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id}),last=group.entries.at(-1)!.entry;
 const command={type:'resize-cut-boundary' as const,cut:group.cut,edge:'start' as const,target:{kind:'archived' as const,entryId:last.id,localFrame:last.durationFrames}};
 const bytes=serializeSequence(d);expect(()=>applySequenceCommand(d,{type:'batch',commands:[command,{type:'trim',clipId:'missing',edge:'start',frame:2}]})).toThrow();expect(serializeSequence(d)).toBe(bytes);
 const done=applySequenceCommand(d,command);expect(done.clips.find(c=>c.content.kind==='telop'&&c.startFrame===60)?.content).toMatchObject({data:{text:'独立した後編集'}});
});
it('keeps a group intact when its first member can restore but a later member lacks registered roles',()=>{
 const noCaptions=fixture();noCaptions.clips=noCaptions.clips.filter(c=>c.content.kind!=='telop');let d=cut(noCaptions);const legacyUnbound=structuredClone(d.cutArchive!.entries[0]!);d=applySequenceCommand(d,{type:'register-native-speed',groupId:'speed',mainClipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:d.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:d.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});
 // Model an already-saved historical unbound band; new registrations now bind provable roles.
 d.cutArchive!.entries[0]=legacyUnbound;
 d=extend(d,'start');const group=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id}),target=group.entries.at(-1)!.entry;
 const bytes=serializeSequence(d);expect(()=>resize(d,'start',{kind:'archived',entryId:target.id,localFrame:target.durationFrames},group.cut)).toThrow('速度登録');expect(serializeSequence(d)).toBe(bytes);
 // The registered added member is independently valid; failure is from the later old member.
 expect(()=>applySequenceCommand(d,{type:'restore-cut',entryId:group.entryIds[0]!})).not.toThrow();
});
it('refuses to cross another cut whose order is not part of the selected group',()=>{
 const d=applySequenceCommand(cut(fixture()),{type:'ripple-delete',startFrame:30,endFrame:40});
 // Older saved cuts have no operation-time order; their cross-band guard remains required.
 delete d.cutArchive!.groups;
 const group=readCutBoundaryGroup(d,{kind:'entry',id:d.cutArchive!.entries[0]!.id});const bytes=serializeSequence(d);
 expect(()=>resize(d,'start',{kind:'live',clipId:group.adjacentLive.start[0],frame:20})).toThrow('別のカット帯');expect(serializeSequence(d)).toBe(bytes);
});
it('reserves group IDs against inserted clip reuse and restores a removed archive-only track',()=>{
 let d=extend(cut(fixture()),'start');const group=d.cutArchive!.groups![0]!;
 const clip=structuredClone(d.clips[0]!);clip.id=group.id;expect(()=>applySequenceCommand(d,{type:'insert',clips:[clip]})).toThrow('再利用');
 // A track that only exists inside an archive may legitimately be removed and recreated.
 const input=fixture();input.tracks.push({id:'extra',kind:'visual',name:'保存のみ',enabled:true});input.clips.push({...structuredClone(input.clips[2]!),id:'extra-caption',trackId:'extra',startFrame:35,durationFrames:10,anchor:undefined});
 d=extend(cut(input),'start');d=applySequenceCommand(d,{type:'remove-track',trackId:'extra'});
 const g=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id}),last=g.entries.at(-1)!.entry;
 const next=resize(d,'start',{kind:'archived',entryId:last.id,localFrame:last.durationFrames},g.cut);expect(next.tracks.some(t=>t.id==='extra')).toBe(true);same(next,input);
});
it('splits group ownership around a generic middle restoration instead of bridging a live gap',()=>{
 let d=extend(extend(cut(fixture()),'start'),'end');const group=d.cutArchive!.groups![0]!,middle=group.entryIds[1]!;
 d=applySequenceCommand(d,{type:'restore-cut',entryId:middle,range:{startFrame:10,endFrame:20}});
 expect(d.cutArchive!.groups).toHaveLength(2);expect(d.cutArchive!.groups!.map(g=>readCutBoundaryGroup(d,{kind:'group',id:g.id}).frame)).toEqual([20,30]);
 for(const g of d.cutArchive!.groups!){expect(readCutBoundaryGroup(d,{kind:'group',id:g.id}).entryIds).toHaveLength(2);}
 validateSequenceDocument(d);
});
it.each([
 {atFrame:20}, {edge:'middle'}, {target:{kind:'live',clipId:'v1',frame:20,localFrame:0}},
 {target:{kind:'archived',entryId:'cut',localFrame:-1}}, {cut:{kind:'asset',id:'media'}},
])('rejects malformed boundary commands %j',patch=>{
 const c={type:'resize-cut-boundary',cut:{kind:'entry',id:'cut'},edge:'start',target:{kind:'live',clipId:'v1',frame:20},...patch};expect(()=>validateResizeCutBoundaryCommand(c)).toThrow();
});
it.each(['missing','duplicate','orphan-key','id-collision'] as const)('rejects corrupt persisted group %s',kind=>{
 const d=extend(cut(fixture()),'start'),g=d.cutArchive!.groups![0]!;
 if(kind==='missing')g.entryIds[0]='missing';if(kind==='duplicate')g.entryIds.push(g.entryIds[0]!);if(kind==='orphan-key')Object.assign(g,{order:0});if(kind==='id-collision')g.id=d.clips[0]!.id;
 expect(()=>parseSequence(JSON.stringify(d))).toThrow();
});
it.each(['start','end'] as const)('extends %s into the adjacent live occurrence and restores across the group',edge=>{
 const original=fixture(),d=cut(original),adjacent=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===(edge==='start'?0:30))!;
 const grown=resize(d,edge,{kind:'live',clipId:adjacent.id,frame:edge==='start'?20:40});
 expect(grown.sequenceEndFrame).toBe(80);expect(grown.cutArchive!.entries.map(e=>e.durationFrames).sort((a,b)=>a-b)).toEqual([10,30]);
 const group=(grown.cutArchive as unknown as {groups:{id:string;entryIds:string[]}[]}).groups[0]!;
 const lastId=group.entryIds[edge==='start'?group.entryIds.length-1:0]!;
 const member=grown.cutArchive!.entries.find(e=>e.id===lastId)!;
 const restored=resize(grown,edge,{kind:'archived',entryId:lastId,localFrame:edge==='start'?member.durationFrames:0},{kind:'group',id:group.id});
 same(restored,original);expect(restored.cutArchive).toBeUndefined();
});

it.each([[1,1],[3,2],[3,1],[4,1]])('restores grouped source/effect samples at fractional current speed %s/%s',(n,den)=>{
 const original=register(),grown=extend(rate(cut(original),4),'end',5),d=rate(grown,n!,den!),g=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id});
 const next=resize(d,'end',{kind:'archived',entryId:g.entryIds[0],localFrame:0},g.cut);same(next,rate(original,n!,den!));
});
