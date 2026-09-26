/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NativeFilmstrip} from './NativeFilmstrip';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
const request=vi.hoisted(()=>vi.fn((_url:string|null,_total:number,frames:number[])=>frames.map(frame=>({frame,url:`data:image/jpeg;base64,${frame}`}))));
vi.mock('../timeline/useFilmstrip',()=>({MAX_THUMBS:24,STRIP_THUMB_PX:80,useFilmstripFrames:request}));
afterEach(()=>{cleanup();request.mockClear();});
function props(){
 const document:SequenceDocument={schemaVersion:2,id:'doc',name:'doc',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:60,background:'#000',tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},assets:[{id:'original',kind:'media',file:'original.mp4',name:'original',fingerprint:'sha',streams:[{index:2,kind:'video',duration:r(10),frameRate:r(24),codec:'h264'}]}]};
 const clip={id:'c',name:'映像',trackId:'v',startFrame:0,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'video' as const,assetId:'original',streamIndex:2,sourceIn:r(1),rate:r(2)}};
 return {document,clip,projectId:'p',sourceOffsetFrames:30,displayStartFrame:100,displayDuration:30,pixelsPerFrame:4,scrollLeft:400,viewportWidth:252};
}
it('draws bounded images inside the existing piece and forwards exact source identity',()=>{
 const p=props(),view=render(<NativeFilmstrip {...p}/>),call=request.mock.calls[0]!;
 expect(call[0]).toBe('/api/sequence/asset?id=p&asset=original');expect(call[1]).toBe(240);expect(call[2]![0]).toBeCloseTo((1+37/30*2)*24);
 expect(view.container.querySelectorAll('img')).toHaveLength(2);
 expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');expect((view.container.firstElementChild as HTMLElement).style.pointerEvents).toBe('none');
});
it('requests no video or images for unsupported streams or offscreen pieces',()=>{
 const p=props();p.document.assets[0]!.streams.push({...p.document.assets[0]!.streams[0]!,index:3});const view=render(<NativeFilmstrip {...p}/>);
 expect(request.mock.calls.at(-1)![0]).toBeNull();expect(view.container.querySelectorAll('img')).toHaveLength(0);expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('multiple-video-streams');
 p.document.assets[0]!.streams.pop();view.rerender(<NativeFilmstrip {...p} scrollLeft={10000}/>);expect(request.mock.calls.at(-1)![0]).toBeNull();
});
