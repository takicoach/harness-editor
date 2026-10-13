import {execFileSync} from 'node:child_process';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {createServer,type Server} from 'node:http';
import {mkdtemp,mkdir,readdir,readFile,realpath,rm,stat,symlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {createSequenceImageProject} from '../sequence/create';
import {makeMediaSamples,type MediaSamples} from '../sequence/__fixtures__/mediaSamples';
import {sampleCatalog} from './__fixtures__/catalog';
import {catalogScript,libraryFileName,refreshCatalogScript,saveToLibrary,withLock} from './save';

const FP2='b'.repeat(64),FP3='c'.repeat(64);
let samples:MediaSamples,lib:string,root:string,src:string,server:Server,origin:string;
beforeAll(async()=>{samples=makeMediaSamples(await realpath(await mkdtemp(join(tmpdir(),'lib-save-samples-'))));},60_000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});});
beforeEach(async()=>{
  lib=await realpath(await mkdtemp(join(tmpdir(),'lib-save-lib-')));root=await realpath(await mkdtemp(join(tmpdir(),'lib-save-root-')));
  vi.stubEnv('HARNESS_LIBRARY_DIR',lib);
  await mkdir(join(lib,'効果音'));await writeFile(join(lib,'効果音/pop.wav'),'x');
  await writeFile(join(lib,'catalog.json'),JSON.stringify(sampleCatalog()));
  src=join(root,'src.wav');await writeFile(src,'RIFFdata');
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(e=>sendApiError(res,e));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{vi.unstubAllEnvs();await new Promise(r=>server.close(r));await rm(lib,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});

const input=(over:Partial<Parameters<typeof saveToLibrary>[1]>={})=>({sourcePath:src,fingerprint:FP2,kind:'se' as const,name:'カチ／新',desc:'テスト',extension:'.wav',durationSec:0.06,...over});
const catalog=async()=>JSON.parse(await readFile(join(lib,'catalog.json'),'utf8'));
const lockPath=()=>join(lib,'catalog.lock');

it('copies the file, appends to catalog.json and regenerates catalog.js',async()=>{
  const r=await saveToLibrary(lib,input());
  expect(r.created).toBe(true);expect(r.item.file).toMatch(/^効果音\/カチ_新__[a-f0-9]{8}\.wav$/);
  expect(await readFile(join(lib,r.item.file),'utf8')).toBe('RIFFdata');
  expect((await catalog()).media.some((m:{key:string})=>m.key===r.item.key)).toBe(true);
  expect(await readFile(join(lib,'catalog.js'),'utf8')).toMatch(/^window\.CATALOG = /);
  await expect(stat(lockPath())).rejects.toThrow();
});
it('catalogScript is a window.CATALOG assignment',()=>{expect(catalogScript(sampleCatalog() as never)).toMatch(/^window\.CATALOG = \{.*\};\n$/s);});
it('libraryFileName strips path characters and keeps the fingerprint prefix',()=>{
  expect(libraryFileName('a/b\\c:d','abcdef0123','.WAV')).toBe('a_b_c_d__abcdef01.wav');
  expect(libraryFileName('  ','abcdef0123','.png')).toBe('素材__abcdef01.png');
});
it('libraryFileName does not cut a surrogate pair at 60 characters',()=>{
  const n=libraryFileName('a'.repeat(59)+'😀😀','abcdef0123','.png');
  expect(n).toBe('a'.repeat(59)+'😀__abcdef01.png');expect(n).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
});
it('libraryFileName replaces leading dots',()=>{
  expect(libraryFileName('.hidden','abcdef0123','.png')).toBe('_hidden__abcdef01.png');
  expect(libraryFileName('...x','abcdef0123','.png')).toBe('___x__abcdef01.png');
});
it('does not remove a lock that now belongs to someone else',async()=>{
  const other=JSON.stringify({token:'other',pid:process.pid,at:Date.now()});
  await withLock(lib,async()=>{await writeFile(lockPath(),other);});
  expect(await readFile(lockPath(),'utf8')).toBe(other);
});
it('lets only one of two simultaneous takeovers of a stale lock hold it',async()=>{
  await writeFile(lockPath(),JSON.stringify({token:'old',pid:99999999,at:Date.now()}));
  let holders=0,max=0;
  const go=()=>withLock(lib,async()=>{holders++;max=Math.max(max,holders);await new Promise(r=>setTimeout(r,150));holders--;return 'ok';});
  const r=await Promise.allSettled([go(),go()]);
  expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const bad=r.find(x=>x.status==='rejected') as PromiseRejectedResult;expect(bad.reason).toMatchObject({status:409});
  expect(max).toBe(1);
  expect((await readdir(lib)).filter(f=>f.includes('.stale.'))).toEqual([]);
  await expect(stat(lockPath())).rejects.toThrow();
});
it('returns the existing item for the same kind and fingerprint',async()=>{
  const a=await saveToLibrary(lib,input()),b=await saveToLibrary(lib,input({name:'別名'}));
  expect(b.created).toBe(false);expect(b.item.key).toBe(a.item.key);expect((await catalog()).media).toHaveLength(2);
});
it('keeps both items when two saves run at the same time',async()=>{
  const go=async(i:Parameters<typeof saveToLibrary>[1])=>{for(let n=0;n<20;n++){try{return await saveToLibrary(lib,i);}catch(e){if((e as {status?:number}).status!==409)throw e;await new Promise(r=>setTimeout(r,20));}}throw new Error('gave up');};
  await Promise.all([go(input()),go(input({fingerprint:FP3,name:'別'}))]);
  const keys=(await catalog()).media.map((m:{key:string})=>m.key);
  expect(keys).toContain(`se:${FP2.slice(0,16)}`);expect(keys).toContain(`se:${FP3.slice(0,16)}`);
});
it('refuses when another live save holds the lock',async()=>{
  await writeFile(lockPath(),JSON.stringify({pid:process.pid,at:Date.now()}));
  await expect(saveToLibrary(lib,input())).rejects.toMatchObject({status:409,message:expect.stringMatching(/ほかの保存が進行中/)});
  expect((await catalog()).media).toHaveLength(1);
});
it('takes over a lock whose process is gone',async()=>{
  await writeFile(lockPath(),JSON.stringify({pid:99999999,at:Date.now()}));
  expect((await saveToLibrary(lib,input())).created).toBe(true);
});
it('takes over a lock older than two minutes, and over an unreadable old lock',async()=>{
  await writeFile(lockPath(),JSON.stringify({pid:process.pid,at:Date.now()-3*60_000}));
  expect((await saveToLibrary(lib,input())).created).toBe(true);
  await writeFile(lockPath(),'garbage');const old=new Date(Date.now()-3*60_000);await utimes(lockPath(),old,old);
  expect((await saveToLibrary(lib,input({fingerprint:FP3}))).created).toBe(true);
});
it('keeps catalog.json correct and warns when catalog.js cannot be written',async()=>{
  await mkdir(join(lib,'catalog.js'));
  const r=await saveToLibrary(lib,input());
  expect(r.created).toBe(true);expect(r.warning).toMatch(/catalog\.js/);
  expect((await catalog()).media.some((m:{key:string})=>m.key===r.item.key)).toBe(true);
});
it('normalizes names and never overwrites an existing file',async()=>{
  const r=await saveToLibrary(lib,input({name:'が'.normalize('NFD')}));
  expect(r.item.name).toBe('が');expect(r.item.file.normalize('NFC')).toBe(r.item.file);
  await rm(join(lib,r.item.file));await writeFile(join(lib,r.item.file),'KEEP');
  await writeFile(join(lib,'catalog.json'),JSON.stringify(sampleCatalog()));
  const r2=await saveToLibrary(lib,input({name:'が'}));
  expect(r2.item.file).not.toBe(r.item.file);expect(await readFile(join(lib,r.item.file),'utf8')).toBe('KEEP');
});
it('refuses a symlinked kind folder',async()=>{
  const outside=await mkdtemp(join(tmpdir(),'lib-save-out-'));
  try{await rm(join(lib,'効果音'),{recursive:true});await symlink(outside,join(lib,'効果音'));
    await expect(saveToLibrary(lib,input())).rejects.toThrow();
    await expect(stat(join(outside,'x'))).rejects.toThrow();expect((await catalog()).media).toHaveLength(1);}
  finally{await rm(outside,{recursive:true,force:true});}
});
it('refuses an extension the library does not allow for the kind',async()=>{
  await expect(saveToLibrary(lib,input({extension:'.mp4'}))).rejects.toMatchObject({status:400});
  await expect(saveToLibrary(lib,input({kind:'image',extension:'.wav'}))).rejects.toMatchObject({status:400});
  expect((await catalog()).media).toHaveLength(1);
});
it('refuses a bad fingerprint',async()=>{await expect(saveToLibrary(lib,input({fingerprint:'zz'}))).rejects.toMatchObject({status:400});});
it('refreshCatalogScript rebuilds a missing or stale catalog.js only when it gets the lock',async()=>{
  await refreshCatalogScript(lib);expect(await readFile(join(lib,'catalog.js'),'utf8')).toMatch(/^window\.CATALOG = /);
  await writeFile(join(lib,'catalog.js'),'old');const old=new Date(Date.now()-60_000);await utimes(join(lib,'catalog.js'),old,old);
  await writeFile(lockPath(),JSON.stringify({pid:process.pid,at:Date.now()}));
  await refreshCatalogScript(lib);expect(await readFile(join(lib,'catalog.js'),'utf8')).toBe('old');
  await rm(lockPath());await refreshCatalogScript(lib);expect(await readFile(join(lib,'catalog.js'),'utf8')).toMatch(/^window\.CATALOG = /);
});
it('GET /api/library rebuilds a missing catalog.js',async()=>{
  expect((await fetch(`${origin}/api/library`)).status).toBe(200);
  expect(await readFile(join(lib,'catalog.js'),'utf8')).toMatch(/^window\.CATALOG = /);
});

// ---- POST /api/library/save
let project:string;
const pid=()=>project.split('/').pop()!;
const upload=async(file:string,name:string)=>{
  const r=await fetch(`${origin}/api/sequence/upload?id=${encodeURIComponent(pid())}&name=${encodeURIComponent(name)}`,{method:'POST',body:await readFile(file)});
  expect(r.status,await r.clone().text()).toBe(200);return (await r.json()).asset as {id:string};
};
const save=(body:unknown)=>fetch(`${origin}/api/library/save`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(async()=>{project=join(root,(await createSequenceImageProject(root,{name:'p',images:[{name:'a.png',sourcePath:samples.red}]})).id);});

it('API saves an uploaded (unplaced) sound to the library',async()=>{
  const a=await upload(samples.wav,'talk.wav');
  const r=await save({projectId:pid(),assetId:a.id,kind:'se',name:'しゃべり',desc:'メモ'});
  expect(r.status,await r.clone().text()).toBe(200);const body=await r.json();
  expect(body.created).toBe(true);expect(body.item.durationSec).toBeGreaterThan(1);
  expect((await catalog()).media.some((m:{key:string})=>m.key===body.item.key)).toBe(true);
  expect((await stat(join(lib,body.item.file))).isFile()).toBe(true);
});
it('既定の場所に素材置場がまだ無ければ、最初の保存で空の台帳を作ってから保存する',async()=>{
  vi.stubEnv('HARNESS_LIBRARY_DIR','');vi.stubEnv('HARNESS_PROJECT_ROOT',root);
  const a=await upload(samples.wav,'talk.wav');
  const r=await save({projectId:pid(),assetId:a.id,kind:'se',name:'最初の効果音',desc:''});
  expect(r.status,await r.clone().text()).toBe(200);const body=await r.json();
  const fresh=JSON.parse(await readFile(join(root,'素材置場','catalog.json'),'utf8'));
  expect(fresh.media.map((m:{key:string})=>m.key)).toEqual([body.item.key]);
  expect((await stat(join(root,'素材置場',body.item.file))).isFile()).toBe(true);
});
it('API saves a project image as an image',async()=>{
  const a=await upload(samples.green,'g.png');
  const r=await save({projectId:pid(),assetId:a.id,kind:'image',name:'緑',desc:''});
  expect(r.status,await r.clone().text()).toBe(200);expect((await r.json()).item.file).toMatch(/^画像\/.*\.png$/);
});
it('API accepts audio whose only picture is an attached cover',async()=>{
  const cover=await upload(samples.coverMp3,'cover.mp3');
  expect((await save({projectId:pid(),assetId:cover.id,kind:'bgm',name:'表紙つき',desc:''})).status).toBe(200);
});
it('API refuses a kind that does not match the content',async()=>{
  const wav=await upload(samples.wav,'talk.wav'),img=await upload(samples.blue,'b.png');
  expect((await save({projectId:pid(),assetId:wav.id,kind:'image',name:'x',desc:''})).status).toBe(400);
  expect((await save({projectId:pid(),assetId:img.id,kind:'se',name:'x',desc:''})).status).toBe(400);
  expect((await save({projectId:pid(),assetId:img.id,kind:'bgm',name:'x',desc:''})).status).toBe(400);
});
it('API refuses components, movies with a picture, bad input and unknown assets',async()=>{
  const wav=await upload(samples.wav,'talk.wav');
  expect((await save({projectId:pid(),assetId:'nope',kind:'se',name:'x',desc:''})).status).toBe(400);
  expect((await save({projectId:pid(),assetId:wav.id,kind:'video',name:'x',desc:''})).status).toBe(400);
  expect((await save({projectId:pid(),assetId:wav.id,kind:'se',name:' ',desc:''})).status).toBe(400);
  expect((await fetch(`${origin}/api/library/save`)).status).toBe(405);
  const mp4=join(root,'v.mp4');
  const ff=resolveFfmpegBin();if(!ff.ok)throw new Error(ff.message);
  execFileSync(ff.bin,['-y','-loglevel','error','-f','lavfi','-i','testsrc=size=64x48:rate=5:duration=1','-f','lavfi','-i','sine=duration=1','-shortest','-pix_fmt','yuv420p',mp4]);
  const movie=await upload(mp4,'v.mp4');
  expect((await save({projectId:pid(),assetId:movie.id,kind:'se',name:'x',desc:''})).status).toBe(400);
  expect((await catalog()).media).toHaveLength(1);
});
it('keeps both saves when two saves race to take over a stale lock',async()=>{
  await writeFile(lockPath(),JSON.stringify({token:'old',pid:99999999,at:Date.now()}));
  const go=async(i:Parameters<typeof saveToLibrary>[1])=>{for(let n=0;n<30;n++){try{return await saveToLibrary(lib,i);}catch(e){if((e as {status?:number}).status!==409)throw e;await new Promise(r=>setTimeout(r,20));}}throw new Error('gave up');};
  await Promise.all([go(input()),go(input({fingerprint:FP3,name:'別'}))]);
  const keys=(await catalog()).media.map((m:{key:string})=>m.key);
  expect(keys).toContain(`se:${FP2.slice(0,16)}`);expect(keys).toContain(`se:${FP3.slice(0,16)}`);
  expect((await readdir(lib)).filter(f=>f.includes('.stale.')||f.endsWith('.reclaim'))).toEqual([]);
});
it('does not take over a stale lock while another reclaim is in progress, and drops a reclaim lock older than 30 seconds',async()=>{
  await writeFile(lockPath(),JSON.stringify({token:'old',pid:99999999,at:Date.now()}));
  const guard=`${lockPath()}.reclaim`;
  await writeFile(guard,JSON.stringify({pid:process.pid,at:Date.now()}));
  await expect(withLock(lib,async()=>'x')).rejects.toMatchObject({status:409});
  expect(await readFile(lockPath(),'utf8')).toContain('"old"');
  await writeFile(guard,JSON.stringify({pid:process.pid,at:Date.now()-31_000}));
  expect(await withLock(lib,async()=>'ok')).toBe('ok');
  await expect(stat(guard)).rejects.toThrow();
});
it('does not remove a fresh lock that replaced the stale one while reclaiming',async()=>{
  // 古さの判定は補助ロックの中で読み直す: 新しい（生きた）ロックは退避されず busy になる
  await writeFile(lockPath(),JSON.stringify({token:'fresh',pid:process.pid,at:Date.now()}));
  await expect(withLock(lib,async()=>'x')).rejects.toMatchObject({status:409});
  expect(await readFile(lockPath(),'utf8')).toContain('"fresh"');
});
it('returns 404 with a reason (not a raw ENOENT) when the library folder is missing',async()=>{
  const gone=join(root,'nowhere');
  await expect(saveToLibrary(gone,input())).rejects.toMatchObject({status:404,message:expect.stringContaining('素材置場が見つかりません')});
});
