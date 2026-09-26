import {expect,it} from 'vitest';
import {videoOnlyMp4Bytes} from './videoOnlyMp4Bytes';

const join=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const text=(s:string)=>new TextEncoder().encode(s);
const box=(kind:string,...parts:Uint8Array[])=>{const body=join(...parts),head=new Uint8Array(8);new DataView(head.buffer).setUint32(0,body.length+8);head.set(text(kind),4);return join(head,body);};
const track=(kind:string)=>box('trak',box('mdia',box('hdlr',new Uint8Array(8),text(kind)),box('minf',box('stbl',box('stsz',new Uint8Array([0,0,0,0,0,0,0,4,2,124,99,64]))))));
function source(data:Uint8Array){return {size:data.length,async read(start:number,end:number,_signal?:AbortSignal){return data.slice(start,end).buffer;}};}

it('hides non-video tracks before sample expansion without touching video, media or offsets',async()=>{
  const audio=track('soun'),video=track('vide'),meta=track('meta'),ftyp=box('ftyp',text('isom'));
  const data=join(ftyp,box('moov',audio,video,meta),box('mdat',text('unchanged compressed video and audio'))),before=data.slice();
  const filtered=await videoOnlyMp4Bytes(source(data)),expected=data.slice();
  const masks=[ftyp.length+8+4,ftyp.length+8+audio.length+video.length+4];
  for(const offset of masks)expected.set(text('free'),offset);
  expect(filtered.size).toBe(data.length);
  expect(new Uint8Array(await filtered.read(0,data.length))).toEqual(expected);
  // A caller may split a type marker across arbitrary byte requests.
  for(const offset of masks)for(let at=offset-1;at<offset+5;at++)expect(new Uint8Array(await filtered.read(at,at+1))).toEqual(expected.slice(at,at+1));
  expect(data).toEqual(before);
});
it('retains both video track positions and returns the original source when nothing is excluded',async()=>{
  const data=join(box('moov',track('vide'),track('vide')),box('mdat',text('two video streams'))),original=source(data);
  expect(await videoOnlyMp4Bytes(original)).toBe(original);
});
it('preserves cancellation and does not mutate a shared range buffer',async()=>{
  const data=box('moov',track('soun'),track('vide')),cache=data.buffer.slice(0),calls:(AbortSignal|undefined)[]=[];
  const original={size:data.length,async read(start:number,end:number,signal?:AbortSignal){calls.push(signal);return start===0&&end===data.length?cache:cache.slice(start,end);}};
  const filtered=await videoOnlyMp4Bytes(original),abort=new AbortController();
  await filtered.read(0,data.length,abort.signal);
  expect(calls.at(-1)).toBe(abort.signal);expect(new Uint8Array(cache)).toEqual(data);
});
it.each([
  new Uint8Array([0,0,0,4,109,111,111,118]),
  new Uint8Array([0,0,0,16,109,111,111,118]),
  box('moov',box('trak',box('mdia'))),
  box('moov',track('vide'),box('mvex')),
  join(box('moov',track('vide')),box('moov',track('vide'))),
])('rejects invalid or unsupported metadata before invoking the sample parser',async data=>{
  await expect(videoOnlyMp4Bytes(source(data))).rejects.toThrow(/索引|分割MP4/);
});
