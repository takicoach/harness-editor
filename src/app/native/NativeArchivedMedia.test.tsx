/** @vitest-environment jsdom */
import {it,expect,vi} from 'vitest';
import {render,cleanup} from '@testing-library/react';
import {fixture} from '../../core/sequence/fixtures';
import {NativeArchivedMedia} from './NativeArchivedMedia';
import type {FinishDisplayMap} from './finishDisplayMap';
import {readArchivedCutGraph} from '../../core/sequence/cutArchive';
vi.mock('../../core/sequence/cutArchive',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../core/sequence/cutArchive')>();
 return {...actual,readArchivedCutGraph:vi.fn(actual.readArchivedCutGraph)};
});
const graphSpy=vi.mocked(readArchivedCutGraph);
vi.mock('./NativeFilmstrip',()=>({NativeFilmstrip:(p:any)=><i data-testid="film" data-offset={p.sourceOffsetFrames} data-start={p.displayStartFrame} data-source={JSON.stringify(p.clip.content.sourceIn)}/>}));
vi.mock('./NativeWaveform',()=>({NativeWaveform:(p:any)=><i data-testid="wave" data-offset={p.sourceOffsetFrames} data-start={p.displayStartFrame} data-source={JSON.stringify(p.clip.content.sourceIn)}/>}));
it('projects saved video/audio on the cut axis without shifting their source clocks or mutating the document',()=>{
 const doc=fixture();const video=doc.clips.find(c=>c.content.kind==='video')!,audio=doc.clips.find(c=>c.content.kind==='audio')!;
 const clips=[video,audio].map(c=>({...structuredClone(c),startFrame:10,durationFrames:30}));
 doc.cutArchive={version:1,entries:[{id:'saved',durationFrames:60,clips,tracks:doc.tracks} as any]};
 const map={blocks:[{kind:'archived',entryId:'saved',displayStart:200,displayEnd:260,localEnd:60}]} as FinishDisplayMap;
 const before=JSON.stringify(doc);const props={document:doc,projectId:'p',map,pixels:2,scrollLeft:0,viewportWidth:1000,height:50,gain:1};
 const v=render(<NativeArchivedMedia {...props} trackId={video.trackId}/>);
 expect(v.getByTestId('film').getAttribute('data-start')).toBe('210');expect(v.getByTestId('film').getAttribute('data-offset')).toBe('0');
 v.rerender(<NativeArchivedMedia {...props} trackId={audio.trackId}/>);
 expect(v.getByTestId('wave').getAttribute('data-start')).toBe('10');expect(v.getByTestId('wave').getAttribute('data-source')).toBe(JSON.stringify(audio.content.kind==='audio'&&audio.content.sourceIn));
 v.rerender(<NativeArchivedMedia {...props} trackId={audio.trackId} scrollLeft={2000}/>);expect(v.queryByTestId('wave')).toBeNull();
 expect(JSON.stringify(doc)).toBe(before);cleanup();
});

const savedDoc=(entryCount:number,trackIds:string[])=>{
 const doc=fixture();
 const video=doc.clips.find(c=>c.content.kind==='video')!,audio=doc.clips.find(c=>c.content.kind==='audio')!;
 const entries=Array.from({length:entryCount},(_,index)=>({id:`saved-${index}`,durationFrames:60,tracks:doc.tracks,
  clips:trackIds.map(trackId=>{
   const source=doc.tracks.find(t=>t.id===trackId)!.kind==='audio'?audio:video;
   return {...structuredClone(source),id:`${trackId}-${index}`,trackId,startFrame:10,durationFrames:30,linkGroupId:undefined};
  })} as any));
 doc.cutArchive={version:1,entries};
 const map={blocks:entries.map((entry,index)=>({kind:'archived',entryId:entry.id,displayStart:index*100,
  displayEnd:index*100+60,localStart:0,localEnd:60}))} as FinishDisplayMap;
 return {doc,map};
};
const renderTracks=(doc:any,map:FinishDisplayMap,trackIds:string[],scrollLeft:number,viewportWidth:number)=>
 render(<>{trackIds.map(trackId=><NativeArchivedMedia key={trackId} document={doc} projectId="p" map={map} trackId={trackId}
  pixels={1} scrollLeft={scrollLeft} viewportWidth={viewportWidth} height={50} gain={1}/>)}</>);

it('restores each saved cut once for every track that shows it',()=>{
 const tracks=['v1','v2','a1','a2'];const {doc,map}=savedDoc(4,tracks);
 graphSpy.mockClear();
 const v=renderTracks(doc,map,tracks,0,1200);
 expect(v.container.querySelectorAll('[data-archive-entry]').length).toBe(16);
 expect(graphSpy.mock.calls.length).toBeLessThanOrEqual(4);
 cleanup();
});

it('never restores a saved cut that is off screen',()=>{
 const {doc,map}=savedDoc(4,['v1','a1']);
 graphSpy.mockClear();
 const away=renderTracks(doc,map,['v1','a1'],40000,1200);
 expect(away.container.querySelectorAll('[data-archive-entry]').length).toBe(0);
 expect(graphSpy.mock.calls.length).toBe(0);
 cleanup();
});

// 仕上げの可視トラックがテロップだけのとき（実案件の初期表示）は 1 件も作らない。
it('never restores a saved cut that has nothing on the track',()=>{
 const {doc,map}=savedDoc(4,['v1','a1']);
 graphSpy.mockClear();
 const telop=renderTracks(doc,map,['v2','a2'],0,1200);
 expect(telop.container.querySelectorAll('[data-archive-entry]').length).toBe(0);
 expect(graphSpy.mock.calls.length).toBe(0);
 cleanup();
});

// hotfix Minor: span はあるのに復元グラフ側にそのクリップが無い＝取り違え。黙って行が欠けると
// 「保存したカットが消えた」ように見えるので、開発時だけ知らせる（表示は従来どおり描かない）。
it('warns in development when a saved clip is missing from the restored graph',()=>{
 const {doc,map}=savedDoc(1,['v1']);
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 graphSpy.mockImplementationOnce((document:any)=>({...document,clips:[]}));
 const view=renderTracks(doc,map,['v1'],0,1200);
 expect(view.container.querySelectorAll('[data-archive-entry]').length).toBe(0);
 expect(warn).toHaveBeenCalled();
 warn.mockRestore();cleanup();
});

it('keeps restored graphs when a cut scrolls out of view and back',()=>{
 const {doc,map}=savedDoc(3,['v1','a1']);
 graphSpy.mockClear();
 const v=renderTracks(doc,map,['v1','a1'],0,1200);
 const first=graphSpy.mock.calls.length;
 expect(first).toBeLessThanOrEqual(3);
 expect(first).toBeGreaterThan(0);
 v.rerender(<>{['v1','a1'].map(trackId=><NativeArchivedMedia key={trackId} document={doc} projectId="p" map={map} trackId={trackId}
  pixels={1} scrollLeft={40000} viewportWidth={1200} height={50} gain={1}/>)}</>);
 expect(v.container.querySelectorAll('[data-archive-entry]').length).toBe(0);
 v.rerender(<>{['v1','a1'].map(trackId=><NativeArchivedMedia key={trackId} document={doc} projectId="p" map={map} trackId={trackId}
  pixels={1} scrollLeft={0} viewportWidth={1200} height={50} gain={1}/>)}</>);
 expect(v.container.querySelectorAll('[data-archive-entry]').length).toBe(6);
 expect(graphSpy.mock.calls.length).toBe(first);
 cleanup();
});
