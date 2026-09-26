import {afterEach,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm,lstat} from 'node:fs/promises';
import {renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerSequenceReference,reconnectSequenceReference} from './references';
import {registeredSequenceAssets} from './assets';
import {serveSequenceAsset} from './serveAsset';
import type {SequenceAsset} from '../../core/sequence/model';
const roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function wav(size=4096){const b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%300,i);return b;}
async function fixture(size?:number){const root=await mkdtemp(join(tmpdir(),'harness-reference-http-'));roots.push(root);const project=join(root,'project'),source=join(root,'source.wav'),bytes=wav(size);await mkdir(project);await writeFile(source,bytes);const asset=await registerSequenceReference(project,source);return {root,project,source,bytes,asset};}
async function listen(project:string,asset:SequenceAsset,onFirstWrite?:()=>void){
 const s=createServer((req,res)=>{
  if(onFirstWrite){const write=res.write.bind(res);let seen=false;res.write=((...args:Parameters<typeof write>)=>{if(!seen){seen=true;onFirstWrite();}return write(...args);}) as typeof res.write;}
  void serveSequenceAsset(res,project,asset,req.headers.range).catch(error=>{if(res.headersSent)res.destroy(error);else{res.writeHead(422);res.end('素材を読み込めません');}});
 });servers.push(s);await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const address=s.address();if(!address||typeof address==='string')throw new Error('listen');return `http://127.0.0.1:${address.port}`;
}
it('lists a reference-only registry and serves exact byte ranges without a managed copy',async()=>{
 const f=await fixture();await expect(lstat(join(f.project,'.harness/assets'))).rejects.toMatchObject({code:'ENOENT'});expect(await registeredSequenceAssets(f.project)).toEqual([f.asset]);
 const response=await fetch(await listen(f.project,f.asset),{headers:{Range:'bytes=71-150'}});
 expect(response.status).toBe(206);expect(response.headers.get('content-range')).toBe(`bytes 71-150/${f.bytes.length}`);expect(response.headers.get('content-type')).toBe('audio/wav');expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes.subarray(71,151));
 expect(await readFile(f.source)).toEqual(f.bytes);
});
it('keeps offline metadata and resumes the same asset after explicitly reconnecting identical bytes',async()=>{
 const f=await fixture(),url=await listen(f.project,f.asset),moved=join(f.root,'moved.wav');await rename(f.source,moved);
 expect(await registeredSequenceAssets(f.project)).toEqual([f.asset]);expect((await fetch(url)).status).toBe(422);
 await reconnectSequenceReference(f.project,f.asset,moved);const response=await fetch(url);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
});
it('does not finish a response if the source path is replaced while bytes are streaming',async()=>{
 const f=await fixture(2*1024*1024);
 const url=await listen(f.project,f.asset,()=>{renameSync(f.source,f.source+'.old');writeFileSync(f.source,f.bytes);});
 await expect((async()=>{const response=await fetch(url);await response.arrayBuffer();})()).rejects.toThrow();
 expect((await fetch(await listen(f.project,f.asset))).status).toBe(200); // identical bytes rechecked from the new file
});
it('rejects changed bytes before sending a saved asset response',async()=>{
 const f=await fixture(),changed=Buffer.from(f.bytes);changed[100]=changed[100]!^1;await writeFile(f.source,changed);
 expect((await fetch(await listen(f.project,f.asset))).status).toBe(422);
});
