import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({path:'',afterRead:null as (()=>Promise<void>|void)|null,closed:0,readBytes:[] as number[]}));
vi.mock('node:fs/promises',async load=>{
 const fs=await load<typeof import('node:fs/promises')>();return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  const handle=await fs.open(...args);if(args[0]!==io.path)return handle;
  const read=handle.read.bind(handle),close=handle.close.bind(handle);
  handle.read=((...values:unknown[])=>Reflect.apply(read,handle,values).then(async(result:{bytesRead:number})=>{io.readBytes.push(result.bytesRead);const callback=io.afterRead;io.afterRead=null;await callback?.();return result;})) as typeof handle.read;
  handle.close=async()=>{try{await close();}finally{io.closed++;}};return handle;
 }};
});
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,type Server} from 'node:http';
import {matchSequenceReference} from './referenceMatch';
import {findSizeMatches} from '../matchVideoSource';
import {handleApi} from '../plugin';
import {HttpError} from '../http';
import {SequenceStore} from './store';
const owned:string[]=[],servers:Server[]=[];
afterEach(async()=>{io.path='';io.afterRead=null;io.closed=0;io.readBytes=[];vi.unstubAllEnvs();for(const s of servers){s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));}servers.length=0;for(const dir of owned.splice(0))await rm(dir,{recursive:true,force:true});});
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){const temp=await mkdtemp(join(tmpdir(),'native-reference-match-'));owned.push(temp);const root=await realpath(temp),project=join(root,'projects'),media=join(root,'media');await mkdir(project);await mkdir(media);return {root,project,media,roots:[{key:'owned',label:'owned',path:media}]};}
const request=(name:string,bytes:Buffer|string)=>({name,sizeBytes:Buffer.byteLength(bytes),fingerprint:hash(bytes)});
it.each(['.mp4','.wav','.png','.flac','.webp'])('matches a unique %s by full bytes without creating a project or copying',async ext=>{
 const f=await fixture(),name='日本語'+ext,bytes=Buffer.alloc(ext==='.mp4'?3*1024*1024:4096,71),source=join(f.media,name);await writeFile(source,bytes);
 expect(await matchSequenceReference(request(name,bytes),f.roots,f.project)).toEqual({matched:true,path:source,fingerprint:hash(bytes)});
 expect(await readdir(f.project)).toEqual([]);expect(hash(await readFile(source))).toEqual(hash(bytes));
});
it('keeps legacy video-only matching by default and opts into media explicitly',async()=>{
 const f=await fixture();await writeFile(join(f.media,'a.wav'),'a');
 expect(findSizeMatches(f.roots,{name:'a.wav',sizeBytes:1}).candidates).toEqual([]);
 expect(findSizeMatches(f.roots,{name:'a.wav',sizeBytes:1},{extensions:['.wav']}).candidates).toHaveLength(1);
});
it('rejects ambiguity before using a hash to choose a preferred occurrence',async()=>{
 const f=await fixture();await mkdir(join(f.media,'other'));await writeFile(join(f.media,'a.wav'),'a');await writeFile(join(f.media,'other/a.wav'),'b');
 expect(await matchSequenceReference(request('a.wav','a'),f.roots,f.project)).toEqual({matched:false,reason:'ambiguous'});
});
it('refuses an incomplete scan even when its first candidate is exact',async()=>{
 const f=await fixture();await writeFile(join(f.media,'a.wav'),'a');await mkdir(join(f.media,'z'));await mkdir(join(f.media,'z/deeper'));
 expect(await matchSequenceReference(request('a.wav','a'),f.roots,f.project,undefined,{limits:{maxDepth:1,maxEntries:100,maxMillis:1000}})).toEqual({matched:false,reason:'search-truncated'});
});
it('rejects equal size but different middle bytes using the full fingerprint',async()=>{
 const f=await fixture(),a=Buffer.alloc(10*1024*1024,1),b=Buffer.from(a);b[5*1024*1024]=2;await writeFile(join(f.media,'a.mov'),b);
 expect(await matchSequenceReference(request('a.mov',a),f.roots,f.project)).toEqual({matched:false,reason:'content-mismatch'});
});
it('does not follow linked files/directories or search inside the project root',async()=>{
 const f=await fixture();await writeFile(join(f.project,'a.wav'),'a');await symlink(join(f.project,'a.wav'),join(f.media,'a.wav'));await symlink(f.project,join(f.media,'linked'));
 const all=[{key:'all',label:'all',path:f.root}];expect(await matchSequenceReference(request('a.wav','a'),all,f.project)).toEqual({matched:false,reason:'no-candidate'});
});
it('deduplicates overlapping explicit browse roots and never accepts a supplied path',async()=>{
 const f=await fixture();await writeFile(join(f.media,'a.wav'),'a');
 expect((await matchSequenceReference(request('a.wav','a'),[...f.roots,...f.roots],f.project)).matched).toBe(true);
 await expect(matchSequenceReference({...request('a.wav','a'),path:'/outside'},f.roots,f.project)).rejects.toMatchObject({status:400});
 for(const fingerprint of ['a'.repeat(63),'A'.repeat(64),'head-tail-digest'])await expect(matchSequenceReference({...request('a.wav','a'),fingerprint},f.roots,f.project)).rejects.toMatchObject({status:400});
});
it('cancels after an actual bounded FD read and closes the descriptor',async()=>{
 const f=await fixture(),bytes=Buffer.alloc(16*1024*1024,1);await writeFile(join(f.media,'a.wav'),bytes);const controller=new AbortController();
 io.path=join(f.media,'a.wav');io.afterRead=()=>controller.abort();
 await expect(matchSequenceReference(request('a.wav',bytes),f.roots,f.project,controller.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(io.readBytes).toEqual([1024*1024]);expect(io.closed).toBe(1);
});
it('rejects path replacement by an outside symlink while hashing the original FD',async()=>{
 const f=await fixture(),bytes=Buffer.alloc(2*1024*1024,1),path=join(f.media,'a.wav'),outside=join(f.root,'outside.wav');await writeFile(path,bytes);await writeFile(outside,bytes);
 io.path=path;io.afterRead=async()=>{await rename(path,path+'.old');await symlink(outside,path);};
 expect(await matchSequenceReference(request('a.wav',bytes),f.roots,f.project)).toEqual({matched:false,reason:'unreadable'});expect(io.closed).toBe(1);
});
it('rejects mutation during hashing even when the expected digest was read first',async()=>{
 const f=await fixture(),bytes=Buffer.from('a'),path=join(f.media,'a.wav');await writeFile(path,bytes);
 io.path=path;io.afterRead=()=>writeFile(path,'b');
 expect(await matchSequenceReference(request('a.wav',bytes),f.roots,f.project)).toEqual({matched:false,reason:'content-mismatch'});expect(io.closed).toBe(1);
});
async function server(root:string){const s=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(e=>{res.writeHead(e instanceof HttpError?e.status:500);res.end(String(e));});});servers.push(s);await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));const address=s.address();if(!address||typeof address==='string')throw Error('listen');return `http://127.0.0.1:${address.port}`;}
function wav(){const b=Buffer.alloc(1644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);return b;}
it('serves project-free matching and rejects changed selection on real register/create HTTP paths',async()=>{
 const f=await fixture(),bytes=wav(),source=join(f.media,'speech.wav');await writeFile(source,bytes);vi.stubEnv('SME_BROWSE_ROOTS',f.media);const origin=await server(f.project);
 const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const match=await post('/api/sequence/reference-match',request('speech.wav',bytes));expect(match.status).toBe(200);expect(await match.json()).toMatchObject({matched:true,path:source});
 expect((await fetch(origin+'/api/sequence/reference-match')).status).toBe(405);
 expect((await post('/api/sequence/reference-match',{...request('speech.wav',bytes),fingerprint:'bad'})).status).toBe(400);
 const project=join(f.project,'owned');await mkdir(project);new SequenceStore(project).save({document:{schemaVersion:2,id:'doc',name:'owned',revision:0,fps:{num:30,den:1},resolution:{width:1,height:1},sequenceEndFrame:0,background:'#000',assets:[],tracks:[],clips:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}},expectedSavedRevision:null,executionId:'seed'});
 const saved=await readFile(join(project,'.harness/project.v2.json'));
 const bad=await post('/api/sequence/reference?id=owned',{path:source,expectedFingerprint:'a'.repeat(64)});expect(bad.status).toBe(422);expect(await bad.text()).toContain('指紋');expect(await readFile(join(project,'.harness/project.v2.json'))).toEqual(saved);
 const good=await post('/api/sequence/reference?id=owned',{path:source,expectedFingerprint:hash(bytes)});expect(good.status).toBe(200);expect((await good.json()).asset.fingerprint).toBe(hash(bytes));expect(await readFile(join(project,'.harness/project.v2.json'))).toEqual(saved);
 // A video-named valid WAV reaches the expected-hash guard before the video requirement.
 const movie=join(f.media,'movie.mp4');await writeFile(movie,bytes);const createPath='/api/create-project-link?'+new URLSearchParams({native:'1',name:'new-project',path:movie});
 const failed=await post(createPath,{expectedFingerprint:'a'.repeat(64)});expect(failed.status).toBe(500);expect(await failed.text()).toContain('指紋');expect(await readdir(f.project)).not.toContain('new-project');expect(await readFile(movie)).toEqual(bytes);
});
