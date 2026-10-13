import {createHash} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {componentHash} from '../telopPack/identity';
import {createSequenceImageProject} from '../sequence/create';
import {SequenceStore} from '../sequence/store';
import {makeMediaSamples,type MediaSamples} from '../sequence/__fixtures__/mediaSamples';
import {sampleCatalog} from './__fixtures__/catalog';
import {libraryPackAsset,prepareLibraryItem} from './prepare';
import {readLibraryCatalog} from './catalog';

const BYTES=Buffer.from('export const TELOP_ANIMATIONS=["none"];export const Telop=()=>null;');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const TPL='tpl:sample.motion:38',PACK='モーション/p/component';
let samples:MediaSamples,lib:string,root:string,project:string,seKey:string,server:Server,origin:string;
beforeAll(async()=>{samples=makeMediaSamples(await realpath(await mkdtemp(join(tmpdir(),'lib-prep-samples-'))));},60_000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});});

const assetJson=(over:object={})=>({id:`component-${sha(BYTES).slice(0,24)}`,kind:'component',name:'モーション',file:`.harness/components/${sha(BYTES)}.mjs`,fingerprint:sha(BYTES),streams:[],
  textStyleCatalog:{source:'installed',packId:'sample.motion',version:'t1',componentHash:componentHash(BYTES),animations:['none'],entries:[{id:38,name:'見本チップ',animations:['none']}]},...over});
const writeLib=async(over:{asset?:object;catalog?:(c:ReturnType<typeof sampleCatalog>)=>void}={})=>{
  const c=sampleCatalog();
  c.media[0]={...c.media[0]!,key:seKey,fingerprint:sha(await readFile(samples.wav)),file:'効果音/pop.wav'} as never;
  over.catalog?.(c);
  await writeFile(join(lib,'catalog.json'),JSON.stringify(c));
  await writeFile(join(lib,PACK,'asset.json'),JSON.stringify(assetJson(over.asset)));
};
beforeEach(async()=>{
  lib=await realpath(await mkdtemp(join(tmpdir(),'lib-prep-lib-')));root=await realpath(await mkdtemp(join(tmpdir(),'lib-prep-root-')));
  vi.stubEnv('HARNESS_LIBRARY_DIR',lib);
  await mkdir(join(lib,'効果音'));await mkdir(join(lib,PACK),{recursive:true});
  await writeFile(join(lib,'効果音/pop.wav'),await readFile(samples.wav));await writeFile(join(lib,PACK,'m.mjs'),BYTES);
  seKey=`se:${sha(await readFile(samples.wav)).slice(0,16)}`;
  project=join(root,(await createSequenceImageProject(root,{name:'p',images:[{name:'a.png',sourcePath:samples.red}]})).id);
  await writeLib();
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(e=>sendApiError(res,e));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{vi.unstubAllEnvs();await new Promise(r=>server.close(r));await rm(lib,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
const docState=()=>{const d=new SequenceStore(project).load()!.document;return {revision:d.revision,json:JSON.stringify(d)};};

it('copies a library sound into the project without touching the library file or its origin',async()=>{
  const asset=await prepareLibraryItem(project,lib,seKey);
  expect(asset.kind).toBe('media');expect(asset.origin).toBeUndefined();
  expect(asset.file).toMatch(/^\.harness\/assets\/[a-f0-9]{64}\.wav$/);
  expect((await stat(join(project,asset.file))).ino).not.toBe((await stat(join(lib,'効果音/pop.wav'))).ino);
  expect(await readFile(join(lib,'効果音/pop.wav'))).toEqual(await readFile(samples.wav));
  expect(await prepareLibraryItem(project,lib,seKey)).toEqual(asset);
});
it('stores the motion component and returns it with the library catalog, idempotently',async()=>{
  const asset=await prepareLibraryItem(project,lib,TPL);
  expect(asset.kind).toBe('component');expect(asset.textStyleCatalog?.packId).toBe('sample.motion');
  expect(asset.id).toBe(assetJson().id);
  expect(await prepareLibraryItem(project,lib,TPL)).toEqual(asset);
  const pack=(await readLibraryCatalog(lib)).packs[0]!;
  expect(await libraryPackAsset(project,lib,pack)).toEqual(asset);
});
it('rejects a library pack whose asset.json does not match the component bytes',async()=>{
  await writeLib({asset:{id:'component-'+'b'.repeat(24),fingerprint:'b'.repeat(64)}});
  await expect(prepareLibraryItem(project,lib,TPL)).rejects.toThrow(/一致しません/);
});
it('rejects an incomplete catalog in asset.json',async()=>{
  await writeLib({asset:{textStyleCatalog:{source:'installed',packId:'sample.motion'}}});
  await expect(prepareLibraryItem(project,lib,TPL)).rejects.toMatchObject({status:409});
});
it('rejects a template that the component entries do not list',async()=>{
  await writeLib({catalog:c=>{c.templates[0]!.template=99;c.templates[0]!.key='tpl:sample.motion:99';}});
  await expect(prepareLibraryItem(project,lib,'tpl:sample.motion:99')).rejects.toMatchObject({status:409,message:expect.stringContaining('一覧にありません')});
});
it('rejects a catalog media fingerprint that does not match the file',async()=>{
  await writeLib({catalog:c=>{c.media[0]!.fingerprint='c'.repeat(64);}});
  await expect(prepareLibraryItem(project,lib,seKey)).rejects.toMatchObject({status:409,message:expect.stringContaining('指紋が一致しません')});
});
it('does not change the document',async()=>{
  const before=docState();
  await prepareLibraryItem(project,lib,seKey);await prepareLibraryItem(project,lib,TPL);
  expect(docState()).toEqual(before);
});
it('serves /library/prepare: 404 for an unknown key, 200 with the asset and an unchanged document',async()=>{
  const id=project.split('/').pop()!,url=`${origin}/api/sequence/library/prepare?id=${encodeURIComponent(id)}`;
  const post=(key:unknown)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
  expect((await post('se:nope')).status).toBe(404);
  const before=docState();
  const ok=await post(TPL);expect(ok.status).toBe(200);
  expect((await ok.json()).asset.kind).toBe('component');
  expect(docState()).toEqual(before);
});
it('rejects a catalog whose componentHash does not match the component bytes',async()=>{
  await writeLib({asset:{textStyleCatalog:{...assetJson().textStyleCatalog,componentHash:'f'.repeat(16)}}});
  await expect(prepareLibraryItem(project,lib,TPL)).rejects.toMatchObject({status:409,message:expect.stringContaining('一致しません')});
});
it('rejects malformed entries / animations / name in asset.json with 409, not 500',async()=>{
  const cat=assetJson().textStyleCatalog;
  for(const asset of [{textStyleCatalog:{...cat,entries:'x'}},{textStyleCatalog:{...cat,animations:{}}},{name:123}]){
    await writeLib({asset});
    await expect(prepareLibraryItem(project,lib,TPL)).rejects.toMatchObject({status:409});
  }
});
it('returns the stored file even when asset.json carries a hostile file path',async()=>{
  await writeLib({asset:{file:'../../../etc/passwd'}});
  const asset=await prepareLibraryItem(project,lib,TPL);
  expect(asset.file).toMatch(/^\.harness\/components\/[a-f0-9]{64}\.mjs$/);
});
it('serves /library/prepare: 409 over HTTP for a mismatched pack',async()=>{
  await writeLib({asset:{fingerprint:'b'.repeat(64)}});
  const id=project.split('/').pop()!;
  const res=await fetch(`${origin}/api/sequence/library/prepare?id=${encodeURIComponent(id)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:TPL})});
  expect(res.status).toBe(409);
});
it('serves /library/prepare: 409 for an unmigrated project and creates nothing',async()=>{
  await mkdir(join(root,'legacy'));
  const res=await fetch(`${origin}/api/sequence/library/prepare?id=legacy`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:TPL})});
  expect(res.status).toBe(409);
  await expect(stat(join(root,'legacy/.harness/assets'))).rejects.toThrow();
  await expect(stat(join(root,'legacy/.harness/components'))).rejects.toThrow();
});
