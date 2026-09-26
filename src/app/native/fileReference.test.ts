import {afterEach,expect,it,vi} from 'vitest';
import {File as NodeFile} from 'node:buffer';
import {createHash} from 'node:crypto';
import {fingerprintFile,resolveFileReference} from './fileReference';
import {createNativeProject} from './api';
const file=(bytes:Uint8Array|string,name='元動画.mp4')=>new NodeFile([typeof bytes==='string'?bytes:Buffer.from(bytes)],name) as unknown as File;
const controller=()=>new AbortController();
afterEach(()=>vi.unstubAllGlobals());
it('uses the desktop file location directly without searching or asking for it again',async()=>{
 const getPathForFile=vi.fn(()=>'/external/撮影素材/元動画.mp4');
 vi.stubGlobal('window',{harnessDesktop:{getPathForFile}});
 const fetch=vi.fn(),choose=vi.fn(),input=file('desktop video');vi.stubGlobal('fetch',fetch);
 await expect(resolveFileReference(input,controller().signal,choose)).resolves.toEqual({path:'/external/撮影素材/元動画.mp4',expectedFingerprint:createHash('sha256').update('desktop video').digest('hex')});
 expect(getPathForFile).toHaveBeenCalledWith(input);expect(fetch).not.toHaveBeenCalled();expect(choose).not.toHaveBeenCalled();
});
it('hashes all bytes with measured progress, including a different middle between identical ends',async()=>{
 const bytes=Buffer.alloc(12*1024*1024,7);bytes[6*1024*1024]=19;
 const updates:{loaded?:number;total?:number}[]=[];
 expect(await fingerprintFile(file(bytes),controller().signal,p=>updates.push(p))).toBe(createHash('sha256').update(bytes).digest('hex'));
 expect(updates[0]).toMatchObject({loaded:0,total:bytes.length});expect(updates.at(-1)).toMatchObject({loaded:bytes.length,total:bytes.length});
 expect(updates.every((p,i)=>!i||p.loaded!>=updates[i-1]!.loaded!)).toBe(true);
});
it('stops reading before matching or registration when cancelled during the hash',async()=>{
 const c=controller(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(resolveFileReference(file(Buffer.alloc(1024*1024)),c.signal,vi.fn(),()=>c.abort())).rejects.toMatchObject({name:'AbortError'});
 expect(fetch).not.toHaveBeenCalled();
});
it('sends metadata only and binds the discovered path to the dropped bytes',async()=>{
 const fetch=vi.fn(async(_url:string,_init:RequestInit)=>({ok:true,json:async()=>({matched:true,path:'/media/元動画.mp4'})}));vi.stubGlobal('fetch',fetch);
 const choose=vi.fn(),expectedFingerprint=createHash('sha256').update('video bytes').digest('hex');
 await expect(resolveFileReference(file('video bytes'),controller().signal,choose)).resolves.toEqual({path:'/media/元動画.mp4',expectedFingerprint});
 expect(choose).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledOnce();expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({name:'元動画.mp4',sizeBytes:11,fingerprint:expectedFingerprint});
});
it('uses the existing picker for ambiguous locations, preserving the original fingerprint',async()=>{
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({matched:false,reason:'ambiguous'})}));vi.stubGlobal('fetch',fetch);
 const choose=vi.fn(async()=>'/chosen/source.mp4');
 const result=await resolveFileReference(file('source'),controller().signal,choose);
 expect(choose).toHaveBeenCalledOnce();expect(result).toEqual({path:'/chosen/source.mp4',expectedFingerprint:createHash('sha256').update('source').digest('hex')});
});
it('does not return a location when the picker was cancelled during its completion',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({matched:false})})));const c=controller();
 await expect(resolveFileReference(file('source'),c.signal,async()=>{c.abort();return '/old/source.mp4';})).rejects.toMatchObject({name:'AbortError'});
});
it('passes the full identity to reference creation without sending the file',async()=>{
 const fetch=vi.fn(async(_url:string,_init:RequestInit)=>({ok:true,json:async()=>({id:'new'})}));vi.stubGlobal('fetch',fetch);
 await createNativeProject('参照','/media/source.mp4',undefined,'a'.repeat(64));
 expect(fetch.mock.calls[0]![0]).toContain('/api/create-project-link?');expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({expectedFingerprint:'a'.repeat(64)});
});
