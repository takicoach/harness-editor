import {createHash} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {componentHash} from '../telopPack/identity';
import {createSequenceImageProject} from '../sequence/create';
import {SequenceStore} from '../sequence/store';
import {makeMediaSamples,type MediaSamples} from '../sequence/__fixtures__/mediaSamples';
import {rational} from '../../core/sequence/time';
import {sampleCatalog} from './__fixtures__/catalog';

const BYTES=Buffer.from('export const TELOP_ANIMATIONS=["none"];export const Telop=()=>null;');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const TPL='tpl:sample.motion:38',PACK='モーション/p/component';
let samples:MediaSamples,lib:string,root:string,project:string,seKey:string,server:Server,origin:string;
beforeAll(async()=>{samples=makeMediaSamples(await realpath(await mkdtemp(join(tmpdir(),'lib-place-samples-'))));},60_000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});});

const assetJson=()=>({id:`component-${sha(BYTES).slice(0,24)}`,kind:'component',name:'モーション',file:`.harness/components/${sha(BYTES)}.mjs`,fingerprint:sha(BYTES),streams:[],
  textStyleCatalog:{source:'installed',packId:'sample.motion',version:'t1',componentHash:componentHash(BYTES),animations:['none'],entries:[{id:38,name:'見本チップ',animations:['none']}]}});
beforeEach(async()=>{
  lib=await realpath(await mkdtemp(join(tmpdir(),'lib-place-lib-')));root=await realpath(await mkdtemp(join(tmpdir(),'lib-place-root-')));
  vi.stubEnv('HARNESS_LIBRARY_DIR',lib);
  await mkdir(join(lib,'効果音'));await mkdir(join(lib,PACK),{recursive:true});
  await writeFile(join(lib,'効果音/pop.wav'),await readFile(samples.wav));await writeFile(join(lib,PACK,'m.mjs'),BYTES);
  seKey=`se:${sha(await readFile(samples.wav)).slice(0,16)}`;
  const c=sampleCatalog();c.media[0]={...c.media[0]!,key:seKey,fingerprint:sha(await readFile(samples.wav)),file:'効果音/pop.wav'} as never;
  await writeFile(join(lib,'catalog.json'),JSON.stringify(c));await writeFile(join(lib,PACK,'asset.json'),JSON.stringify(assetJson()));
  project=join(root,(await createSequenceImageProject(root,{name:'p',images:[{name:'a.png',sourcePath:samples.red}]})).id);
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(e=>sendApiError(res,e));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{vi.unstubAllEnvs();await new Promise(r=>server.close(r));await rm(lib,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});

const id=()=>project.split('/').pop()!;
const call=(route:string,body:unknown)=>fetch(`${origin}/api/sequence${route}?id=${encodeURIComponent(id())}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const ok=async(route:string,body:unknown)=>{const r=await call(route,body);expect(r.status,await r.clone().text()).toBe(200);return r.json();};
const docState=()=>{const d=new SequenceStore(project).load()!.document;return {revision:d.revision,json:JSON.stringify(d)};};
const ids=(s:{document:{assets:{id:string}[]}})=>s.document.assets.map(a=>a.id);
const TRACK={type:'add-track',track:{id:'lib-se',kind:'audio',name:'効果音',enabled:true}};
const VTRACK={type:'add-track',track:{id:'v',kind:'visual',name:'v',enabled:true}};
function seClip(asset:{id:string;streams:{index:number;kind:string}[]},clipId:string,startFrame:number){
  return {id:clipId,name:'ポン',trackId:'lib-se',startFrame,durationFrames:5,clock:{offset:rational(0),rate:rational(1),duration:rational(5)},
    content:{kind:'audio',assetId:asset.id,streamIndex:asset.streams.find(s=>s.kind==='audio')!.index,sourceIn:rational(0),rate:rational(1),role:'effect',loop:false,
      settings:{gainDb:-10,muted:false,fadeInFrames:0,fadeOutFrames:0}}};
}
const start=()=>ok('/session',{});
const place=(s:{sessionId:string;document:{revision:number}},executionId:string,keys:string[],commands:unknown[],revision=s.document.revision)=>
  call('/library/place',{sessionId:s.sessionId,expectedRevision:revision,executionId,keys,commands});

it('registers and places a library sound in one undoable step',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start();
  const placed=await (await place(s,'e1',[seKey],[TRACK,{type:'insert',clips:[seClip(asset,'c1',0)]}])).json();
  expect(ids(placed)).toContain(asset.id);expect(placed.document.clips.some((c:{id:string})=>c.id==='c1')).toBe(true);
  const undone=await ok('/command',{sessionId:s.sessionId,expectedRevision:placed.document.revision,executionId:'u1',command:{type:'undo'}});
  expect(ids(undone)).not.toContain(asset.id);expect(undone.document.clips.some((c:{id:string})=>c.id==='c1')).toBe(false);
  expect(undone.document.tracks.some((t:{id:string})=>t.id==='lib-se')).toBe(false);
});
it('places the same sound twice; the second succeeds and one undo removes only the second clip',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start();
  const first=await ok('/library/place',{sessionId:s.sessionId,expectedRevision:s.document.revision,executionId:'e1',keys:[seKey],commands:[TRACK,{type:'insert',clips:[seClip(asset,'c1',0)]}]});
  const secondRes=await call('/library/place',{sessionId:s.sessionId,expectedRevision:first.document.revision,executionId:'e2',keys:[seKey],commands:[{type:'insert',clips:[seClip(asset,'c2',10)]}]});
  expect(secondRes.status,await secondRes.clone().text()).toBe(200);
  const second=await secondRes.json();
  expect(second.document.assets.filter((a:{id:string})=>a.id===asset.id)).toHaveLength(1);
  expect(second.document.clips.filter((c:{id:string})=>['c1','c2'].includes(c.id))).toHaveLength(2);
  const undone=await ok('/command',{sessionId:s.sessionId,expectedRevision:second.document.revision,executionId:'u1',command:{type:'undo'}});
  expect(undone.document.clips.some((c:{id:string})=>c.id==='c2')).toBe(false);
  expect(undone.document.clips.some((c:{id:string})=>c.id==='c1')).toBe(true);
  expect(ids(undone)).toContain(asset.id);
});
it('replays the same executionId without placing twice',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start();
  const body={sessionId:s.sessionId,expectedRevision:s.document.revision,executionId:'e1',keys:[seKey],commands:[TRACK,{type:'insert',clips:[seClip(asset,'c1',0)]}]};
  const a=await ok('/library/place',body),b=await ok('/library/place',body);
  expect(a.replayed).toBe(false);expect(b.replayed).toBe(true);
  expect(b.document.clips.filter((c:{id:string})=>c.id==='c1')).toHaveLength(1);expect(b.document.revision).toBe(a.document.revision);
});
it('rejects a stale revision with 409 and leaves the document unchanged',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start(),before=docState();
  const r=await place(s,'e1',[seKey],[TRACK,{type:'insert',clips:[seClip(asset,'c1',0)]}],s.document.revision-1);
  expect(r.status).toBe(409);expect(docState()).toEqual(before);
});
it('rejects commands other than add-track and insert with 400',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start(),before=docState();
  expect((await place(s,'e1',[seKey],[{type:'delete',clipIds:['x'],linked:false}])).status).toBe(400);
  expect((await place(s,'e2',[seKey],[TRACK,{type:'register-assets',assets:[asset]}])).status).toBe(400);
  expect((await place(s,'e3',[],[TRACK])).status).toBe(400);
  expect((await place(s,'e4',[seKey],[])).status).toBe(400);
  expect(docState()).toEqual(before);
});
it('leaves the document unchanged (no stray registration) when the insert is invalid',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start(),before=docState();
  const clip=seClip(asset,'c1',0);(clip.content as {assetId:string}).assetId='missing-asset';
  const r=await place(s,'e1',[seKey],[TRACK,{type:'insert',clips:[clip]}]);
  expect(r.status).toBeGreaterThanOrEqual(400);expect(docState()).toEqual(before);
  const state=await ok('/session',{});expect(ids(state)).not.toContain(asset.id);expect(state.dirty).toBe(false);
});
it('rejects a component already registered with a different catalog with 409',async()=>{
  const {asset}=await ok('/library/prepare',{key:TPL}),s=await start();
  const other={...asset,textStyleCatalog:{...asset.textStyleCatalog,entries:[{id:99,name:'別',animations:['none']}]}};
  const reg=await ok('/command',{sessionId:s.sessionId,expectedRevision:s.document.revision,executionId:'r1',command:{type:'register-assets',assets:[other]}});
  expect((await place(reg,'e1',[TPL],[VTRACK])).status).toBe(409);
});
it('rejects a component already in the document without a textStyleCatalog with 409',async()=>{
  const {asset}=await ok('/library/prepare',{key:TPL}),s=await start();
  const {textStyleCatalog:_,...bare}=asset;
  const reg=await ok('/command',{sessionId:s.sessionId,expectedRevision:s.document.revision,executionId:'r1',command:{type:'register-assets',assets:[bare]}});
  expect((await place(reg,'e1',[TPL],[VTRACK])).status).toBe(409);
});
it('registers a motion component through place without a prior prepare',async()=>{
  const s=await start();
  const placed=await ok('/library/place',{sessionId:s.sessionId,expectedRevision:s.document.revision,executionId:'e1',keys:[TPL],commands:[VTRACK]});
  expect(placed.document.assets.some((a:{kind:string;textStyleCatalog?:{packId:string}})=>a.kind==='component'&&a.textStyleCatalog?.packId==='sample.motion')).toBe(true);
});
it('rejects a media key that was not prepared with 409',async()=>{
  const s=await start(),before=docState();
  const r=await place(s,'e1',[seKey],[TRACK]);
  expect(r.status).toBe(409);expect((await r.json()).error).toContain('取り込み');expect(docState()).toEqual(before);
});
it('maps unknown keys to 404 and an unmigrated project to 409',async()=>{
  const s=await start();
  expect((await place(s,'e1',['se:nope'],[TRACK])).status).toBe(404);
  await mkdir(join(root,'legacy'));
  const res=await fetch(`${origin}/api/sequence/library/place?id=legacy`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'x',expectedRevision:0,executionId:'e',keys:[seKey],commands:[TRACK]})});
  expect(res.status).toBe(409);
});
it('rejects malformed add-track / insert commands with 400, not 500',async()=>{
  const {asset}=await ok('/library/prepare',{key:seKey}),s=await start(),before=docState();
  expect((await place(s,'e1',[seKey],[{type:'add-track'}])).status).toBe(400);
  expect((await place(s,'e2',[seKey],[TRACK,{type:'insert',clips:'x'}])).status).toBe(400);
  expect((await place(s,'e3',[seKey],[{type:'add-track',track:{id:'t',kind:'audio',name:'x',enabled:true},index:'a'}])).status).toBe(400);
  void asset;expect(docState()).toEqual(before);
});
it('round-trips a motion and a sound placed with the screen builder: place, undo, redo',async()=>{
  const {buildLibraryPlacement,findLibraryTarget}=await import('../../app/native/library/placement');
  const catalog=JSON.parse(await readFile(join(lib,'catalog.json'),'utf8'));
  for(const key of [seKey,TPL]){
    const target=findLibraryTarget(catalog,key)!;expect(target).toBeTruthy();
    const {asset}=await ok('/library/prepare',{key}),s=await start();
    let n=0;const placed=buildLibraryPlacement(s.document,asset,target,0,undefined,()=>`g${++n}`);
    if('error' in placed)throw new Error(placed.error);
    const r=await ok('/library/place',{sessionId:s.sessionId,expectedRevision:s.document.revision,executionId:`p-${key}`,keys:[key],commands:placed.commands});
    expect(r.document.clips.some((c:{id:string})=>c.id===placed.selectId)).toBe(true);expect(ids(r)).toContain(asset.id);
    const undone=await ok('/command',{sessionId:s.sessionId,expectedRevision:r.document.revision,executionId:`u-${key}`,command:{type:'undo'}});
    expect(undone.document.clips.some((c:{id:string})=>c.id===placed.selectId)).toBe(false);expect(ids(undone)).not.toContain(asset.id);
    const redone=await ok('/command',{sessionId:s.sessionId,expectedRevision:undone.document.revision,executionId:`r-${key}`,command:{type:'redo'}});
    expect(redone.document.clips.some((c:{id:string})=>c.id===placed.selectId)).toBe(true);expect(ids(redone)).toContain(asset.id);
  }
});
