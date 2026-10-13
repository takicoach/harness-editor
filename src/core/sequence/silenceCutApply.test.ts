import {expect,it} from 'vitest';
import {silenceFixture} from './silenceCut.fixture';
import {applySequenceCommand} from './commands';
import {SequenceSession} from './session';
import {parseSequence,serializeSequence} from './validate';
import {rational as r} from './time';
import {sourceTimeAt} from './model';

it('51 cuts equal ordinary cutting, persist, restore, and undo in one step',()=>{
  const before=silenceFixture(6240),ranges=Array.from({length:51},(_,i)=>({startFrame:i*120+30,endFrame:i*120+60}));
  let reference=before;
  for(const r of [...ranges].reverse())reference=applySequenceCommand(reference,{type:'ripple-delete',...r});
  const session=new SequenceSession('s',before),req={sessionId:'s',expectedRevision:0,executionId:'cut',command:{type:'apply-silence-cut' as const,ranges}};
  const result=session.execute(req);
  expect(result.document).toEqual({...reference,revision:1});
  expect(session.execute(req).replayed).toBe(true);
  const stored=parseSequence(serializeSequence(result.document));
  const restored=applySequenceCommand(stored,{type:'restore-cut',entryId:stored.cutArchive!.entries[0]!.id});
  expect(restored.sequenceEndFrame).toBe(stored.sequenceEndFrame+30);
  expect(session.execute({sessionId:'s',expectedRevision:1,executionId:'undo',command:{type:'undo'}}).document).toEqual({...before,revision:2});
  expect(session.execute({sessionId:'s',expectedRevision:2,executionId:'redo',command:{type:'redo'}}).document).toEqual({...result.document,revision:3});
  expect(session.execute(req).replayed).toBe(true);
  expect(session.document.revision).toBe(3);
});
it('rolls back earlier children when a later cut intersects an existing scene fade',()=>{
  const doc=applySequenceCommand(silenceFixture(),{type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:30,color:'#000000'}});
  const s=new SequenceSession('s',doc),before=serializeSequence(doc);
  expect(()=>s.execute({sessionId:'s',expectedRevision:doc.revision,executionId:'fail-midway',command:{type:'apply-silence-cut',ranges:[{startFrame:5,endFrame:10},{startFrame:200,endFrame:210}]}})).toThrow(/フェード/);
  expect(serializeSequence(s.document)).toBe(before);expect(s.canUndo).toBe(false);
});
it('matches ordinary edits and source timing for linked AV, source captions, speed and existing manual cuts',()=>{
  const doc=silenceFixture(300);doc.assets[0]!.streams[0]!.duration=r(22);doc.assets[0]!.streams.push({kind:'video',index:1,codec:'h264',duration:r(22),width:320,height:180,frameRate:r(30)});
  const audio=doc.clips[0]!;audio.linkGroupId='av';if(audio.content.kind==='audio'){audio.content.rate=r(2);audio.content.sourceIn=r(1);}
  doc.tracks.push({id:'video',name:'映像',kind:'visual',enabled:true},{id:'text',name:'字幕',kind:'visual',enabled:true});
  doc.clips.push({...structuredClone(audio),id:'video',trackId:'video',content:{kind:'video',assetId:'media',streamIndex:1,sourceIn:r(1),rate:r(2)}},
    {id:'text',name:'字幕',trackId:'text',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'telop',data:{text:'保持する字幕'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'voice',sourceStart:r(1),sourceEnd:r(21)}});
  const manual=applySequenceCommand(doc,{type:'ripple-delete',startFrame:250,endFrame:260}),ranges=[{startFrame:30,endFrame:60},{startFrame:120,endFrame:150}];
  let reference=manual;for(const range of [...ranges].reverse())reference=applySequenceCommand(reference,{type:'ripple-delete',...range});
  const bulk=applySequenceCommand(manual,{type:'apply-silence-cut',ranges});expect(bulk).toEqual({...reference,revision:manual.revision+1});
  for(let f=0;f<bulk.sequenceEndFrame;f++){const active=bulk.clips.filter(c=>c.startFrame<=f&&c.startFrame+c.durationFrames>f);const a=active.find(c=>c.content.kind==='audio')!,v=active.find(c=>c.content.kind==='video')!;expect(sourceTimeAt(a,f,bulk.fps)).toEqual(sourceTimeAt(v,f,bulk.fps));}
  const restored=applySequenceCommand(bulk,{type:'restore-cut',entryId:bulk.cutArchive!.entries.at(-1)!.id,range:{startFrame:3,endFrame:8}});expect(restored.sequenceEndFrame).toBe(bulk.sequenceEndFrame+5);
});
it('preview never touches a session and invalid bulk input never partially applies',()=>{
  const before=silenceFixture(),bytes=serializeSequence(before),s=new SequenceSession('s',before);
  for(let i=0;i<3;i++)applySequenceCommand(before,{type:'apply-silence-cut',ranges:[{startFrame:30,endFrame:60}]});
  expect(s.canUndo).toBe(false);expect(s.canRedo).toBe(false);expect(serializeSequence(s.document)).toBe(bytes);
  expect(()=>s.execute({sessionId:'s',expectedRevision:0,executionId:'bad',command:{type:'apply-silence-cut',ranges:[{startFrame:30,endFrame:60},{startFrame:200,endFrame:400}]}})).toThrow();
  expect(serializeSequence(s.document)).toBe(bytes);expect(s.canUndo).toBe(false);
});
