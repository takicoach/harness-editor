import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {SequenceStore} from './store';
import {nativeApiProject} from './__fixtures__/nativeApiProject';
let media:string,project:Awaited<ReturnType<typeof nativeApiProject>>;
beforeAll(async()=>{
  media=await mkdtemp(join(tmpdir(),'harness-readonly-media-'));const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=128x72:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',join(media,'main.mp4')]);
  project=await nativeApiProject(join(media,'main.mp4'));
},30000);
afterAll(async()=>{await project.close();await rm(media,{recursive:true,force:true});});
it('serves media ranges and source audio without rereading, hashing or cloning the saved document',async()=>{
  const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.kind==='media')!,load=vi.spyOn(SequenceStore.prototype,'load');
  const range=await fetch(`${project.origin}/api/sequence/asset?id=${project.id}&asset=${asset.id}`,{headers:{range:'bytes=0-99'}});expect(range.status).toBe(206);await range.arrayBuffer();
  const audio=await fetch(`${project.origin}/api/sequence/audio?id=${project.id}&asset=${asset.id}&stream=1`);expect(audio.status,await audio.clone().text()).toBe(200);await audio.json();
  expect(load).not.toHaveBeenCalled();load.mockRestore();
},30000);
it('still answers 404 for an unknown asset and serves a renamed asset after a save',async()=>{
  expect((await fetch(`${project.origin}/api/sequence/asset?id=${project.id}&asset=missing`)).status).toBe(404);
  const store=new SequenceStore(project.directory),saved=store.load()!,asset=saved.document.assets.find(a=>a.kind==='media')!;
  store.save({expectedSavedRevision:saved.savedRevision,executionId:'rename',document:{...saved.document,revision:saved.document.revision+1,assets:saved.document.assets.map(a=>a.id===asset.id?{...a,name:'改名'}:a)}});
  expect(store.assetIndex()!.get(asset.id)!.name).toBe('改名');
  expect((await fetch(`${project.origin}/api/sequence/asset?id=${project.id}&asset=${asset.id}`,{headers:{range:'bytes=0-9'}})).status).toBe(206);
},30000);
