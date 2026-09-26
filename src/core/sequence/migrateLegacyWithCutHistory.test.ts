import {describe,it,expect} from 'vitest';
import {migrateLegacySequence,type LegacyMigrationInput} from './migrateLegacy';
import {migrateLegacyWithCutHistory} from './migrateLegacyWithCutHistory';
import {applySequenceCommand} from './commands';
import {rational as r} from './time';
import {clipEnd,sourceTimeAt} from './model';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {validateSequenceDocument} from './validate';

function input():LegacyMigrationInput {
  return {id:'old-project',name:'旧カットを保持',sourceFingerprint:'a'.repeat(64),bindings:{main:'main',telopComponent:'caption-renderer',images:{},videoInserts:{},bgm:{},se:{}},
    assets:[{id:'main',kind:'media',name:'元動画',file:'public/main.mp4',fingerprint:'main',streams:[
      {index:0,kind:'video',duration:r(10),codec:'h264',width:1920,height:1080,frameRate:r(30)},
      {index:1,kind:'audio',duration:r(10),codec:'aac',sampleRate:48000,channels:2}]},
      {id:'caption-renderer',kind:'component',name:'既存字幕',file:'.harness/assets/caption.js',fingerprint:'caption',streams:[]}],
    project:{videoConfig:{fps:30,durationFrames:300,videoFile:'main.mp4',format:'youtube',orientation:'landscape',resolution:{width:1920,height:1080},titleStyle:{top:60,left:30,fontSize:36}},
      projectConfig:null,transcript:{durationMs:10000,words:[],segments:[]},
      telops:[{id:7,originalStart:30,originalEnd:180,text:'元の字幕本文',template:3,animation:'none'}],
      cutRegions:[{start:60,end:90}],titles:[],images:[],se:[],bgm:[],videoInserts:[],shapes:[],
      mainSpeed:1,segmentSpeeds:{},telopDataSource:'caption-source',cutDataSource:'cut-source',seDataSource:null,insertImageDataSource:null,titleDataSource:null}};
}
describe('preserving old cut bands at saved migration',()=>{
  it.each([[280,350],[310,350],[65,350]])('limits saved source captions %i..%i to the old cut window without changing the visible edit',(start,end)=>{
    const source=input();source.project.telops=[{...source.project.telops[0]!,originalStart:start,originalEnd:end}];
    const baseline=migrateLegacySequence(source).document;
    const doc=migrateLegacyWithCutHistory(source).document;
    expect(doc.clips).toEqual(baseline.clips);expect(doc.sequenceEndFrame).toBe(baseline.sequenceEndFrame);
    const entry=doc.cutArchive!.entries[0]!;
    expect(entry.durationFrames).toBe(30);
    expect(entry.clips.every(c=>c.startFrame>=0&&clipEnd(c)<=30)).toBe(true);
    const captions=entry.clips.filter(c=>c.content.kind==='telop');
    expect(captions.map(c=>[c.startFrame,clipEnd(c)])).toEqual(start===65?[[5,30]]:[]);
    const restored=applySequenceCommand(doc,{type:'restore-cut',entryId:entry.id});
    validateSequenceDocument(restored);
    const restoredCaption=restored.clips.find(c=>c.content.kind==='telop'&&c.startFrame===65);
    if(start===65)expect(restoredCaption).toMatchObject({durationFrames:25,content:{data:{text:'元の字幕本文',template:3}}});
  });
  it('keeps the ordinary edit and records completed history inspection when there are no old cuts',()=>{
    const source=input();source.project.cutRegions=[];
    const expected=migrateLegacySequence(source);expected.document.legacy!.cutHistoryImport={version:1,sourceFingerprint:source.sourceFingerprint};expect(migrateLegacyWithCutHistory(source)).toEqual(expected);
  });
  it('retains the current visible edit while saving a restorable original AV and caption band',()=>{
    const source=input(),untouched=structuredClone(source),visible=migrateLegacySequence(source).document;
    const migrated=migrateLegacyWithCutHistory(source).document;
    expect(source).toEqual(untouched);expect(migrated.clips).toEqual(visible.clips);expect(migrated.sequenceEndFrame).toBe(270);
    expect(migrated.cutArchive?.entries).toHaveLength(1);const entry=migrated.cutArchive!.entries[0]!;
    expect(entry.durationFrames).toBe(30);expect(entry.clips.map(c=>c.content.kind)).toEqual(expect.arrayContaining(['video','audio','telop']));
    expect(entry.clips.find(c=>c.content.kind==='telop')?.content).toMatchObject({legacyId:7,data:{text:'元の字幕本文',template:3}});
    const restored=applySequenceCommand(migrated,{type:'restore-cut',entryId:entry.id});
    const media=restored.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
    expect(restored.sequenceEndFrame).toBe(300);expect(media.map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,60],[60,90],[90,300]]);
    expect(media.map(c=>sourceTimeAt(c,c.startFrame,restored.fps))).toEqual([r(0),r(2),r(3)]);
  });
  it('keeps deleted source available when the entire old video is cut',()=>{
    const source=input();source.project.cutRegions=[{start:0,end:300}];const migrated=migrateLegacyWithCutHistory(source).document;
    expect(migrated.sequenceEndFrame).toBe(0);expect(migrated.cutArchive?.entries).toHaveLength(1);
    const restored=applySequenceCommand(migrated,{type:'restore-cut',entryId:migrated.cutArchive!.entries[0]!.id});
    expect(restored.sequenceEndFrame).toBe(300);expect(restored.clips.some(c=>c.content.kind==='telop')).toBe(true);
  });
  it('uses the legacy speed projection for a restored cut rather than source frames as timeline frames',()=>{
    const source=input();source.project.mainSpeed=2;source.project.cutRegions=[{start:60,end:120}];
    const migrated=migrateLegacyWithCutHistory(source).document;expect(migrated.sequenceEndFrame).toBe(120);expect(migrated.cutArchive?.entries).toHaveLength(1);
    const entry=migrated.cutArchive!.entries[0]!;expect(entry.durationFrames).toBe(30);
    const restored=applySequenceCommand(migrated,{type:'restore-cut',entryId:entry.id});expect(restored.sequenceEndFrame).toBe(150);
    const media=restored.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
    expect(media.map(c=>sourceTimeAt(c,c.startFrame,restored.fps))).toEqual([r(0),r(2),r(4)]);
  });
  it('keeps provenance on both remaining bands after partial restoration and a JSON round trip',()=>{
    const migrated=migrateLegacyWithCutHistory(input()).document,entry=migrated.cutArchive!.entries[0]!;
    const restored=applySequenceCommand(migrated,{type:'restore-cut',entryId:entry.id,range:{startFrame:10,endFrame:20}});
    const saved=JSON.parse(JSON.stringify(restored));validateSequenceDocument(saved);
    expect(saved.cutArchive!.entries).toHaveLength(2);for(const band of saved.cutArchive!.entries)expect(band.legacyRecovery).toEqual(entry.legacyRecovery);
    expect(saved.cutArchive!.entries.map((e:{durationFrames:number})=>e.durationFrames)).toEqual([10,10]);
  });
  it('does not copy an independently placed caption into each saved old band',()=>{
    const source=input();source.project.telops.push({id:8,originalStart:65,originalEnd:80,text:'固定の字幕',template:3,animation:'none',timelinePlacement:{startFrame:75,endFrame:100}});
    const base=migrateLegacySequence(source).document,doc=migrateLegacyWithCutHistory(source).document;
    expect(doc.clips).toEqual(base.clips);expect(doc.cutArchive!.entries[0]!.clips.some(c=>c.content.kind==='telop'&&c.content.legacyId===8)).toBe(false);
    const restored=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
    expect(restored.clips.filter(c=>c.content.kind==='telop'&&c.content.legacyId===8)).toHaveLength(1);
  });
  it('keeps the actual renderer binding for a subtitle wholly inside an old cut',()=>{
    const source=input();source.project.telops=[{...source.project.telops[0]!,originalStart:65,originalEnd:80}];
    const doc=migrateLegacyWithCutHistory(source).document,entry=doc.cutArchive!.entries[0]!;
    expect(entry.clips.find(c=>c.content.kind==='telop')?.content).toMatchObject({componentAssetId:'caption-renderer',legacyId:7,data:{text:'元の字幕本文'}});
    const restored=applySequenceCommand(doc,{type:'restore-cut',entryId:entry.id});validateSequenceDocument(restored);
    expect(restored.clips.some(c=>c.content.kind==='telop'&&c.content.componentAssetId==='caption-renderer')).toBe(true);
  });
  it('does not give a deleted interval the override of a newly numbered surviving segment',()=>{
    const source=input();source.project.mainLayout={...DEFAULT_MAIN_LAYOUT,position:{x:.1,y:.2}};source.project.segmentSpeeds={1:3};source.project.segmentLayouts={1:{...DEFAULT_MAIN_LAYOUT,position:{x:.7,y:.8}}};
    const base=migrateLegacySequence(source).document,doc=migrateLegacyWithCutHistory(source).document;
    expect(doc.clips).toEqual(base.clips);const archived=doc.cutArchive!.entries[0]!.clips.find(c=>c.content.kind==='video')!;
    expect(archived.content).toMatchObject({rate:r(1)});expect(archived.visual?.layout.position).toEqual({x:.1,y:.2});
    expect(doc.cutArchive!.entries[0]!.legacyRecovery).toMatchObject({sourceFingerprint:source.sourceFingerprint,originalStart:60,originalEnd:90,mainRate:r(1)});
  });
});
