import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const referenceFault=vi.hoisted(()=>({afterAdmission:undefined as undefined|(()=>Promise<void>)}));
vi.mock('./assets',async load=>{const actual=await load<typeof import('./assets')>();const after=async()=>{const action=referenceFault.afterAdmission;referenceFault.afterAdmission=undefined;await action?.();};return {...actual,
 verifiedSequenceAssetPath:async(...args:Parameters<typeof actual.verifiedSequenceAssetPath>)=>{const path=await actual.verifiedSequenceAssetPath(...args);await after();return path;},
 openSequenceAsset:async(...args:Parameters<typeof actual.openSequenceAsset>)=>{const lease=await actual.openSequenceAsset(...args);try{await after();return lease;}catch(e){await lease.close();throw e;}},
};});
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../../core/project';
import { legacyPreviewReferences, legacyPreviewResourceKey, projectLegacyPreview, type LegacyPreviewCatalog } from '../../core/sequence/legacyPreview';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { readProjectFiles } from '../loadProjectFiles';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { handleApi } from '../plugin';
import {videoLinkPath,writeVideoLink} from '../videoLink';
import { legacyInputFingerprint, prepareLegacyPreviewCatalog } from './migration';
import { parseLegacyPreviewReferences } from './legacyPreviewContexts';
import { copyLegacyTemplateProject } from '../../../tests/fixtures/legacyTemplateProject';

describe('live legacy resource context over the actual API', () => {
  let root: string, directory: string, origin: string, server: Server;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-draft-preview-')); directory = join(root, 'case');
    copyLegacyTemplateProject(directory);
    await writeFile(join(directory, 'src/テロップテンプレート/telopData.ts'), 'export const telopData = [];');
    await writeFile(join(directory, 'transcript.json'), JSON.stringify({ durationMs: 2000, words: [], segments: [] }));
    await mkdir(join(directory, 'public'));
    const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
    execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=128x72:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', join(directory, 'public/main.mp4')]);
    await cp(directory, join(root, 'other'), { recursive: true });
    server = createServer((req, res) => { void handleApi(req, res, new URL(req.url!, origin), root).catch(error => { res.statusCode = 500; res.end(String(error)); }); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 15000);
  afterAll(async () => { await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
  afterEach(()=>{referenceFault.afterAdmission=undefined;});
  const request = (route: string, params: Record<string, string>, init?: RequestInit) => fetch(`${origin}/api/legacy-preview${route}?${new URLSearchParams({ id: 'case', ...params })}`, init);
  async function linkedFixture(id:string){
    const directory=join(root,id),source=join(root,id+'.mp4');await cp(join(root,'other'),directory,{recursive:true});
    await rename(join(directory,'public/main.mp4'),source);await symlink(source,join(directory,'public/main.mp4'));
    const info=await stat(source);writeVideoLink(directory,{target:source,sizeBytes:info.size,mtimeMs:info.mtimeMs,width:128,height:72,fps:30});
    const project=loadProject(readProjectFiles(directory));project.videoConfig.durationFrames=60;
    const response=await request('',{id},{method:'POST',body:JSON.stringify(legacyPreviewReferences(project))});expect(response.status).toBe(200);
    const prepared:{token:string;catalog:LegacyPreviewCatalog}=await response.json();return {directory,source,prepared};
  }
  it('reuses the same linked reference across two preview POSTs without replacing its registry generation',async()=>{
    const id='linked-repeat',f=await linkedFixture(id),first=f.prepared.catalog.assets.find(asset=>asset.id===f.prepared.catalog.bindings.main)!;
    const leaf=join(f.directory,first.file),recordPath=leaf+'.json',registry=join(f.directory,'.harness/references');
    const recordBytes=await readFile(recordPath),record=JSON.parse(recordBytes.toString('utf8')),recordInfo=await lstat(recordPath),leafInfo=await lstat(leaf),names=(await readdir(registry)).sort(),source=await readFile(f.source);
    let secondToken:string|undefined;
    try{
      expect(first.file).toMatch(/^\.harness\/references\//);
      const project=loadProject(readProjectFiles(f.directory));project.videoConfig.durationFrames=60;
      const response=await request('',{id},{method:'POST',body:JSON.stringify(legacyPreviewReferences(project))});expect(response.status).toBe(200);
      const second:{token:string;catalog:LegacyPreviewCatalog}=await response.json();secondToken=second.token;expect(second.token).not.toBe(f.prepared.token);
      const asset=second.catalog.assets.find(asset=>asset.id===second.catalog.bindings.main)!;
      expect({id:asset.id,file:asset.file}).toEqual({id:first.id,file:first.file});expect(asset).toEqual(first);
      const after=await lstat(recordPath);expect([after.dev,after.ino]).toEqual([recordInfo.dev,recordInfo.ino]);expect(await readFile(recordPath)).toEqual(recordBytes);expect(JSON.parse((await readFile(recordPath)).toString('utf8')).generation).toBe(record.generation);
      const linkAfter=await lstat(leaf);expect([linkAfter.dev,linkAfter.ino]).toEqual([leafInfo.dev,leafInfo.ino]);expect((await readdir(registry)).sort()).toEqual(names);expect(names.some(name=>name.startsWith('.previous-'))).toBe(false);
      expect(await readFile(f.source)).toEqual(source);expect(existsSync(join(f.directory,'.harness/project.v2.json'))).toBe(false);
    }finally{await request('',{id,context:f.prepared.token},{method:'DELETE'});if(secondToken)await request('',{id,context:secondToken},{method:'DELETE'});}
  },15000);
  it('serves an explicitly linked draft through POST, media Range, audio info and byte-exact PCM without saving v2',async()=>{
    const id='linked-http',f=await linkedFixture(id),source=await readFile(f.source),before=await stat(f.source),record=await readFile(videoLinkPath(f.directory));
    const asset=f.prepared.catalog.assets.find(asset=>asset.id===f.prepared.catalog.bindings.main)!,params={id,context:f.prepared.token,asset:asset.id};
    try{
      expect(asset.file).toMatch(/^\.harness\/references\//);expect((await stat(f.source)).ino).toBe(before.ino);
      const range=await request('/asset',params,{headers:{Range:'bytes=0-63'}});expect(range.status).toBe(206);expect(range.headers.get('content-range')).toBe(`bytes 0-63/${source.length}`);expect(Buffer.from(await range.arrayBuffer())).toEqual(source.subarray(0,64));
      const stream=asset.streams.find(stream=>stream.kind==='audio')!;
      const info=await request('/audio/info',{...params,stream:String(stream.index)});expect(info.status).toBe(200);
      const pcm=await info.json();expect(pcm.sampleRate).toBe(48000);expect(pcm.channels).toBe(2);expect(pcm.rate).toEqual({num:1,den:1});
      const audio=await fetch(origin+pcm.url);expect(audio.status).toBe(200);const bytes=Buffer.from(await audio.arrayBuffer());expect(bytes.length).toBe(pcm.sampleCount*8);
      const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
      const oracle=execFileSync(ffmpeg.bin,['-v','error','-i',f.source,'-map',`0:${stream.index}`,'-vn','-ac','2','-ar','48000','-f','f32le','pipe:1'],{maxBuffer:4*1024*1024});expect(bytes).toEqual(oracle);
      const audioRange=await fetch(origin+pcm.url,{headers:{Range:'bytes=8-31'}});expect(audioRange.status).toBe(206);expect(Buffer.from(await audioRange.arrayBuffer())).toEqual(oracle.subarray(8,32));
      expect((await request('/asset',{...params,id:'other'})).status).toBe(404);
      expect(await readFile(videoLinkPath(f.directory))).toEqual(record);expect(await readFile(f.source)).toEqual(source);expect((await stat(f.source)).ino).toBe(before.ino);
      expect(existsSync(join(f.directory,'.harness/project.v2.json'))).toBe(false);expect(existsSync(join(f.directory,'.harness/assets',asset.file.split('/').at(-1)!))).toBe(false);
    }finally{await request('',{id,context:f.prepared.token},{method:'DELETE'});}
    expect((await request('/asset',params)).status).toBe(404);
  },20000);
  it('never completes linked draft media Range with replacement bytes after source admission',async()=>{
    const id='linked-swap',f=await linkedFixture(id),asset=f.prepared.catalog.assets.find(asset=>asset.id===f.prepared.catalog.bindings.main)!;let swapped=false;
    referenceFault.afterAdmission=async()=>{await rename(f.source,f.source+'.original');await writeFile(f.source,Buffer.alloc((await stat(f.source+'.original')).size,88));swapped=true;};
    try{
      let completed=false,status=0,firstBytes='';
      try{const response=await request('/asset',{id,context:f.prepared.token,asset:asset.id},{headers:{Range:'bytes=0-63'}});status=response.status;firstBytes=Buffer.from(await response.arrayBuffer()).subarray(0,8).toString('hex');completed=response.ok;}catch{/* A fixed lease may destroy the response before a valid body completes. */}
      expect(swapped).toBe(true);expect(completed,JSON.stringify({status,firstBytes})).toBe(false);expect(existsSync(join(f.directory,'.harness/project.v2.json'))).toBe(false);
    }finally{await request('',{id,context:f.prepared.token},{method:'DELETE'});}
  },15000);
  it('reports a missing project as 404 without a raw filesystem path', async () => {
    const response = await request('', { id: 'missing-case' }, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404); expect(await response.text()).not.toContain(root);
  });
  it('previews captions over the background when main media is missing without weakening saved migration', async () => {
    const before = await legacyInputFingerprint(directory), project = loadProject(readProjectFiles(directory));
    project.videoConfig.durationFrames = 60; project.videoConfig.videoFile = 'absent.mp4';
    project.telops = [{id:7,originalStart:0,originalEnd:60,text:'映像欠落中も編集',template:1,animation:'none'}];
    const refs = legacyPreviewReferences(project);
    await expect(prepareLegacyPreviewCatalog(directory, refs)).rejects.toMatchObject({status:404});
    const response = await request('', {}, {method:'POST',body:JSON.stringify(refs)});
    expect(response.status).toBe(200);
    const prepared: {token:string;catalog:LegacyPreviewCatalog} = await response.json();
    expect(prepared.catalog.missingMain).toBe(true); expect(prepared.catalog.bindings.main).toBe('');
    expect(prepared.catalog.assets.some(asset => asset.kind === 'media')).toBe(false);
    const projected = projectLegacyPreview(project,prepared.catalog,'missing-main',1,'missing');
    expect(projected.document.sequenceEndFrame).toBe(60);
    const scene = new ScenePlan(projected.document).frame(20);
    expect(scene.visuals.some(item => item.clip.content.kind === 'telop')).toBe(true);
    expect(scene.visuals.some(item => item.clip.content.kind === 'video')).toBe(false);
    expect(await legacyInputFingerprint(directory)).toBe(before);
    expect(existsSync(join(directory,'public/absent.mp4'))).toBe(false);
    expect(existsSync(join(directory,'.harness/project.v2.json'))).toBe(false);
    await request('',{context:prepared.token},{method:'DELETE'});
  });
  it('does not treat permission failures, directories, or escaping links as missing main media', async () => {
    const project = loadProject(readProjectFiles(directory));
    const blocked = join(directory,'public/blocked'); await mkdir(blocked); await writeFile(join(blocked,'main.mp4'),'present');
    await mkdir(join(directory,'public/main-directory'));
    await symlink(join(root,'other/public/main.mp4'),join(directory,'public/outside.mp4'));
    await writeFile(join(directory,'public/not-directory'),'present');
    for(const main of ['main-directory','outside.mp4','not-directory/main.mp4']) {
      const response=await request('',{},{method:'POST',body:JSON.stringify(legacyPreviewReferences({...project,videoConfig:{...project.videoConfig,videoFile:main}}))});
      expect(response.status, main).not.toBe(200);
    }
    try {
      await chmod(blocked,0);
      await expect(stat(join(blocked,'main.mp4'))).rejects.toMatchObject({code:'EACCES'});
      const response=await request('',{},{method:'POST',body:JSON.stringify(legacyPreviewReferences({...project,videoConfig:{...project.videoConfig,videoFile:'blocked/main.mp4'}}))});
      expect(response.status).not.toBe(200);
    } finally {await chmod(blocked,0o755);}
  });
  it('serves combined clip 1.5x and shuttle 8x PCM through the actual legacy API', async () => {
    const project=loadProject(readProjectFiles(directory));project.mainSpeed=1.5;
    const response=await request('',{},{method:'POST',body:JSON.stringify(legacyPreviewReferences(project))});expect(response.status).toBe(200);
    const prepared:{token:string;catalog:LegacyPreviewCatalog}=await response.json();
    try {
      const projected=projectLegacyPreview(project,prepared.catalog,'rate-preview',1,'rate');
      const mainAudio=projected.document.clips.find(clip=>clip.content.kind==='audio')?.content;
      expect(mainAudio?.kind==='audio' ? mainAudio.rate : null).toEqual({num:3,den:2});
      const asset=prepared.catalog.assets.find(asset=>asset.id===prepared.catalog.bindings.main)!;
      const stream=asset.streams.find(stream=>stream.kind==='audio')!;
      const info=await request('/audio/info',{context:prepared.token,asset:asset.id,stream:String(stream.index),rateNum:'12',rateDen:'1'});
      expect(info.status).toBe(200);const pcm=await info.json();expect(pcm.sampleCount).toBeGreaterThan(0);
      expect(new URL(pcm.url,origin).searchParams.get('rateNum')).toBe('12');
      const data=await fetch(origin+pcm.url);expect(data.status).toBe(200);expect((await data.arrayBuffer()).byteLength).toBe(pcm.sampleCount*pcm.channels*4);
    } finally {await request('',{context:prepared.token},{method:'DELETE'});}
  });
  it('prepares first unsaved caption, projects edits locally, serves frozen video/component/PCM without saving', async () => {
    const before = await legacyInputFingerprint(directory), source = await readFile(join(directory, 'src/テロップテンプレート/telopData.ts'));
    const project = loadProject(readProjectFiles(directory)); project.videoConfig.durationFrames = 60;
    project.telops = [{ id: 7, originalStart: 0, originalEnd: 60, text: 'まだ保存していない字幕', template: 1, animation: 'none' }];
    const response = await request('', {}, { method: 'POST', body: JSON.stringify(legacyPreviewReferences(project)) });
    expect(response.status).toBe(200);
    const prepared: { token: string; catalog: LegacyPreviewCatalog } = await response.json();
    const params = { context: prepared.token, asset: prepared.catalog.bindings.main };
    expect((await request('/asset', params, { headers: { Range: 'bytes=0-15' } })).status).toBe(206);
    const component = await request('/component', { ...params, asset: prepared.catalog.bindings.telopComponent! });
    expect(component.status).toBe(200); expect(await component.text()).toContain('@harness/frame-runtime');
    const stream = prepared.catalog.assets.find(asset => asset.id === params.asset)!.streams.find(stream => stream.kind === 'audio')!;
    const info = await request('/audio/info', { ...params, stream: String(stream.index) }); expect(info.status).toBe(200);
    const pcm = await info.json(); expect(new URL(pcm.url, origin).searchParams.get('context')).toBe(prepared.token);
    const audio = await fetch(origin + pcm.url); expect(audio.status).toBe(200); expect((await audio.arrayBuffer()).byteLength).toBe(pcm.sampleCount * pcm.channels * 4);
    const catalogBefore = JSON.stringify(prepared.catalog), first = projectLegacyPreview(project, prepared.catalog, 'stable-preview', 1, '旧案件');
    project.telops[0]!.text = '編集中に打ち替え'; project.cutRegions = [{ start: 15, end: 30 }];
    const second = projectLegacyPreview(project, prepared.catalog, 'stable-preview', 2, '旧案件');
    expect(first.document.id).toBe(second.document.id); expect(second.document.revision).toBe(2);
    expect(second.document.sequenceEndFrame).toBe(45); expect(first.document.sequenceEndFrame).toBe(60);
    expect(second.document.clips.filter(clip => clip.content.kind === 'telop').every(clip => clip.content.kind === 'telop' && clip.content.data.text === '編集中に打ち替え')).toBe(true);
    expect(new ScenePlan(second.document).frame(16).visuals.length).toBeGreaterThan(0);
    expect(JSON.stringify(prepared.catalog)).toBe(catalogBefore);
    project.videoConfig.videoFile = 'different.mp4'; expect(() => projectLegacyPreview(project, prepared.catalog, 'stable-preview', 3, '旧案件')).toThrow(/素材を準備/);
    expect(await legacyInputFingerprint(directory)).toBe(before); expect(await readFile(join(directory, 'src/テロップテンプレート/telopData.ts'))).toEqual(source);
    expect(existsSync(join(directory, '.harness/project.v2.json'))).toBe(false); expect(existsSync(join(directory, '.harness/exports'))).toBe(false);
    expect((await fetch(`${origin}/api/sequence/asset?id=case&asset=${params.asset}`)).status).toBe(404);
    expect((await request('/asset', { ...params, id: 'other' })).status).toBe(404);
    expect((await request('/asset', { ...params, asset: 'not-in-this-context' })).status).toBe(404);
    expect((await request('', { context: prepared.token }, { method: 'DELETE' })).status).toBe(200);
    expect((await request('/asset', params)).status).toBe(404);
  }, 30000);
});

describe('legacy preview resource request validation', () => {
  const good = { main: 'main.mp4', telop: false, image: false, images: [], videoInserts: [], bgm: [], se: [] };
  it.each(['../escape.mp4', '/tmp/escape.mp4', 'x\\y.mp4', 'C:/escape.mp4', '', 'x/./y.mp4'])('rejects unsafe resource name %s', main => {
    expect(() => parseLegacyPreviewReferences({ ...good, main })).toThrow(/指定が不正/);
  });
  it('keeps raw percent names, canonicalizes IDs and rejects unexpected resource authority', () => {
    expect(parseLegacyPreviewReferences({ ...good, main: '100%20.mp4', se: [{ id: 2, file: '声%20.wav' }, { id: 1, file: 'a.wav' }] }).se.map(x => x.id)).toEqual([1, 2]);
    expect(() => parseLegacyPreviewReferences({ ...good, assets: [] })).toThrow();
    expect(() => parseLegacyPreviewReferences({ ...good, se: [{ id: 1, file: 'a.wav' }, { id: 1, file: 'b.wav' }] })).toThrow();
  });
  it('resource keys survive JSON property reordering and server normalization', () => {
    const original = { ...good, se: [{ id: 2, file: 'b.wav' }, { id: 1, file: 'a.wav' }] };
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).reverse())));
    reordered.se = reordered.se.map((item: { id: number; file: string }) => ({ file: item.file, id: item.id }));
    expect(legacyPreviewResourceKey(parseLegacyPreviewReferences(reordered))).toBe(legacyPreviewResourceKey(original));
  });
});
