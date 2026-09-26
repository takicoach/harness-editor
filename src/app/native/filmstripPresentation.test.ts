import {expect,it} from 'vitest';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {filmstripPresentation,type NativeFilmstripInput} from './filmstripPresentation';

function fixture():NativeFilmstripInput{
 const document:SequenceDocument={schemaVersion:2,id:'doc',name:'映像',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:600,background:'#000',tracks:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
  assets:[{id:'source',kind:'media',file:'public/source.mp4',name:'原本',fingerprint:'a',streams:[{index:1,kind:'video',duration:r(100),frameRate:r(30000,1001),codec:'h264'}]}],
  clips:[{id:'occurrence-a',name:'映像',trackId:'v',startFrame:100,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'video',assetId:'source',streamIndex:1,sourceIn:r(5),rate:r(1)}}]};
 return {document,projectId:'project a',clip:document.clips[0]!,sourceOffsetFrames:0,displayStartFrame:100,displayDuration:300,pixelsPerFrame:2,scrollLeft:200,viewportWidth:292};
}
function good(input=fixture()){const result=filmstripPresentation(input);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);return result;}
it('uses source rational FPS, not sequence FPS or rounded total-frame duration',()=>{
 const view=good();expect(view.cells.map(c=>c.sourceSeconds)).toEqual([5+20/30,7]);
 expect(view.sourceFps).toBe(30000/1001);expect(view.totalFrames).toBe(100*30000/1001);
 expect(view.cells[0]!.frame/view.sourceFps).toBeCloseTo(5+20/30,12);
 expect(view.url).toBe('/api/sequence/asset?id=project+a&asset=source');
});
it.each([[2,1,5+2*(90+20)/30],[1,2,5+.5*(90+20)/30]])('preserves source offset at rate %s/%s across an inserted archive display gap',(num,den,seconds)=>{
 const p=fixture();if(p.clip.content.kind!=='video')throw Error();p.clip.content.rate=r(num,den);p.sourceOffsetFrames=90;p.displayStartFrame=250;p.scrollLeft=500;
 expect(good(p).cells[0]!.sourceSeconds).toBeCloseTo(seconds,12);
});
it('keeps repeated uses of one asset distinct and does not prefer an unrelated converted asset',()=>{
 const a=fixture(),b=structuredClone(a);b.clip.id='occurrence-b';if(b.clip.content.kind!=='video')throw Error();b.clip.content.sourceIn=r(30);
 b.document.assets.unshift({...structuredClone(b.document.assets[0]!),id:'proxy',fingerprint:'proxy',file:'proxy.mp4'});
 expect(good(a).ownerKey).not.toBe(good(b).ownerKey);expect(good(b).url).toBe(good(a).url);expect(good(b).cells[0]!.sourceSeconds).toBeCloseTo(30+20/30);
 b.clip.content.assetId='proxy';expect(good(b).url).toContain('asset=proxy');
});
it('bounds visible cells and clips their local geometry instead of sampling offscreen media',()=>{
 const p=fixture();p.pixelsPerFrame=100;p.displayStartFrame=0;p.scrollLeft=15000;p.viewportWidth=10132;
 const view=good(p);expect(view.cells).toHaveLength(24);expect(view.cells[0]!.left).toBe(15000);expect(view.cells.at(-1)!.left+view.cells.at(-1)!.width).toBe(25000);
 p.scrollLeft=40000;expect(good(p).cells).toEqual([]);p.viewportWidth=132;expect(good(p).cells).toEqual([]);
});
it('does not invent a selected stream through the same URL',()=>{
 const p=fixture();p.document.assets[0]!.streams.push({...p.document.assets[0]!.streams[0]!,index:2});
 expect(filmstripPresentation(p)).toEqual({ok:false,reason:'multiple-video-streams'});
});
it('rejects missing source, missing FPS and invalid mapping without using another occurrence',()=>{
 const p=fixture();p.document.assets=[];expect(filmstripPresentation(p)).toEqual({ok:false,reason:'missing-source'});
 const q=fixture();delete q.document.assets[0]!.streams[0]!.frameRate;expect(filmstripPresentation(q)).toEqual({ok:false,reason:'invalid-time'});
 const v=fixture();v.sourceOffsetFrames=.5;expect(filmstripPresentation(v)).toEqual({ok:false,reason:'invalid-time'});
});
it('does not stretch or clamp beyond source end and does not mutate the saved document',()=>{
 const p=fixture();if(p.clip.content.kind!=='video')throw Error();p.clip.content.sourceIn=r(99);const saved=JSON.stringify(p.document);
 expect(good(p).cells).toHaveLength(1);expect(JSON.stringify(p.document)).toBe(saved);
 p.clip.content.sourceIn=r(101);expect(good(p).cells).toEqual([]);
});
