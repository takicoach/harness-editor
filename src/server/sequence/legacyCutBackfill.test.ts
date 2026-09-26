import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyLegacyTemplateProject} from '../../../tests/fixtures/legacyTemplateProject';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {SequenceStore} from './store';
import {SequenceService} from './service';
import {prepareLegacySequenceSnapshot,legacyInputFingerprint} from './migration';
import {LegacyCutBackfills} from './legacyCutBackfill';
import {handleSequenceApi} from './api';
import {sequenceContentBytes} from '../../core/sequence/validate';
import {SequenceError} from '../../core/sequence/errors';
import {serializeTelopData} from '../../core/telopData';
import {makeMediaSamples} from './__fixtures__/mediaSamples';
let mediaRoot:string,coverMp3:string,root:string,project:string,sessions:SequenceService,backfills:LegacyCutBackfills,server:Server|undefined;
beforeAll(async()=>{mediaRoot=await mkdtemp(join(tmpdir(),'backfill-media-'));const ff=resolveFfmpegBin();if(!ff.ok)throw new Error(ff.message);execFileSync(ff.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=size=32x32:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',join(mediaRoot,'main.mp4')]);coverMp3=makeMediaSamples(mediaRoot).coverMp3;},30_000);
afterAll(async()=>{await rm(mediaRoot,{recursive:true,force:true});});
beforeEach(async({task})=>{
 root=await mkdtemp(join(tmpdir(),'legacy-history-'));project=join(root,'case');copyLegacyTemplateProject(project);
 const path=join(project,'src/videoConfig.ts');await writeFile(path,(await readFile(path,'utf8')).replace('DURATION_FRAMES = 1500','DURATION_FRAMES = 60'));
 await writeFile(join(project,'src/テロップテンプレート/telopData.ts'),"export const telopData = [{id:1,startFrame:0,endFrame:60,text:'元字幕',template:2,animation:'none'}];");
 await writeFile(join(project,'cutData.ts'),'export const cutData = [{id:1,originalStart:0,originalEnd:15,playbackStart:0,playbackEnd:15},{id:2,originalStart:30,originalEnd:60,playbackStart:15,playbackEnd:45}];');
 if(task.name.includes('no old cuts'))await writeFile(join(project,'cutData.ts'),'export const cutData = [{id:1,originalStart:0,originalEnd:60,playbackStart:0,playbackEnd:60}];');
 await writeFile(join(project,'transcript.json'),JSON.stringify({durationMs:2000,words:[],segments:[]}));
 await mkdir(join(project,'public'));await cp(join(mediaRoot,'main.mp4'),join(project,'public/main.mp4'));
 if(task.name.includes('wholly cut caption'))await writeFile(join(project,'src/テロップテンプレート/telopData.ts'),serializeTelopData('export const telopData=[];',[{id:71,startFrame:14,endFrame:14,originalStart:18,originalEnd:27,text:'切れた帯だけの字幕',template:2,animation:'none'}]));
 if(task.name.includes('audio-only legacy bindings')){
  await writeFile(join(project,'src/テロップテンプレート/telopData.ts'),'export const telopData=[];');
  await mkdir(join(project,'public/BGM'));await cp(join(mediaRoot,'main.mp4'),join(project,'public/BGM/music.mp4'));
  await writeFile(join(project,'src/Bgm/bgmData.ts'),"export const bgmData=[{id:1,file:'music.mp4',startFrame:0,endFrame:45,volume:1,fadeInFrames:0,fadeOutFrames:0}];");
  if(task.name.includes('identical BGM and SE')){
   await mkdir(join(project,'public/se'));await cp(join(mediaRoot,'main.mp4'),join(project,'public/se/effect.mp4'));
   await writeFile(join(project,'src/SoundEffects/seData.ts'),"export const seData=[{id:2,file:'effect.mp4',startFrame:0,endFrame:45,volume:1}];");
  }
 }
 if(task.name.includes('cover-art legacy bindings')){
  await writeFile(join(project,'src/テロップテンプレート/telopData.ts'),'export const telopData=[];');
  await mkdir(join(project,'public/BGM'));await cp(coverMp3,join(project,'public/BGM/music.mp3'));
  await writeFile(join(project,'src/Bgm/bgmData.ts'),"export const bgmData=[{id:1,file:'music.mp3',startFrame:0,endFrame:45,volume:1,fadeInFrames:0,fadeOutFrames:0}];");
 }
 const old=await prepareLegacySequenceSnapshot(project);
 if(task.name.includes('cover-art legacy bindings')){
  const music=old.document.clips.find(c=>c.content.kind==='audio'&&c.content.role==='music');
  if(!music||music.content.kind!=='audio')throw new Error('試験用 BGM が無い');
  const assetId=music.content.assetId;
  const asset=old.document.assets.find(a=>a.id===assetId);
  if(!asset)throw new Error('試験用 BGM の登録が無い');
  const cover={index:1,kind:'video' as const,codec:'mjpeg',duration:asset.streams[0]!.duration,width:64,height:48,
   frameRate:{num:90000,den:1},rotation:0,color:{primaries:'unknown' as const,transfer:'unknown' as const,matrix:'bt470bg' as const,range:'full' as const}};
  const legacy={...asset,streams:[...asset.streams,cover]};
  old.document.assets=old.document.assets.map(a=>a.id===asset.id?legacy:a);
  const metadata=join(project,asset.file+'.json'),record=JSON.parse(await readFile(metadata,'utf8'));
  record.asset=legacy;await writeFile(metadata,JSON.stringify(record)+'\n');
 }
 new SequenceStore(project).save({expectedSavedRevision:null,executionId:'old-migration',document:old.document});
 sessions=new SequenceService();backfills=new LegacyCutBackfills(sessions);
});
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}await rm(root,{recursive:true,force:true});});
const owner=()=>{const s=sessions.open(project);return {sessionId:s.sessionId,expectedRevision:s.document.revision};};
it('recovers audio-only legacy bindings for identical BGM and SE files without conflating their clip roles',async()=>{
 const before=sessions.open(project).document;
 expect(before.rendering).toBeUndefined();
 const audio=before.clips.filter(c=>c.content.kind==='audio'&&(c.content.role==='music'||c.content.role==='effect'));
 expect(audio.map(c=>c.content.kind==='audio'?c.content.role:'').sort()).toEqual(['effect','music']);
 expect(new Set(audio.map(c=>c.content.kind==='audio'?c.content.assetId:'' )).size).toBe(1);
 const o=owner(),plan=await backfills.prepare(project,o);
 const imported=await backfills.adopt(project,{...o,executionId:'same-bytes-roles',planId:plan.planId,planDigest:plan.planDigest});
 expect(imported.document.clips).toEqual(before.clips);expect(imported.document.assets).toEqual(before.assets);
 const saved=imported.document.cutArchive!.entries[0]!.clips.filter(c=>c.content.kind==='audio'&&(c.content.role==='music'||c.content.role==='effect'));
 expect(saved.map(c=>c.content.kind==='audio'?c.content.role:'').sort()).toEqual(['effect','music']);
});
it('recovers cover-art legacy bindings from the saved BGM registration without changing its streams',async()=>{
 const before=sessions.open(project).document;
 expect(before.rendering).toBeUndefined();
 const music=before.clips.find(c=>c.content.kind==='audio'&&c.content.role==='music');
 expect(music?.content.kind).toBe('audio');
 const asset=before.assets.find(a=>a.id===(music?.content.kind==='audio'?music.content.assetId:''));
 expect(asset?.streams.map(s=>s.kind)).toEqual(['audio','video']);
 const o=owner(),plan=await backfills.prepare(project,o);
 const imported=await backfills.adopt(project,{...o,executionId:'cover-art',planId:plan.planId,planDigest:plan.planDigest});
 expect(imported.document.assets).toEqual(before.assets);
 expect(new SequenceStore(project).load()!.document.assets).toEqual(before.assets);
});
it.each([false,true])('recovers audio-only legacy bindings without a rendering name table, changed source=%s',async changed=>{
 const before=sessions.open(project).document;expect(before.rendering).toBeUndefined();expect(before.clips.some(c=>c.content.kind==='audio'&&c.content.role==='music')).toBe(true);
 if(changed){const path=join(project,'public/BGM/music.mp4');await writeFile(path,Buffer.concat([await readFile(path),Buffer.from([0])]));}
 if(changed)await expect(backfills.prepare(project,owner())).rejects.toThrow();
 else{
  const o=owner(),plan=await backfills.prepare(project,o),state=await backfills.adopt(project,{...o,executionId:'import-audio-only',planId:plan.planId,planDigest:plan.planDigest});
  expect(state.document.clips).toEqual(before.clips);expect(state.document.rendering).toBeUndefined();expect(state.document.assets).toEqual(before.assets);
  expect(state.document.cutArchive!.entries[0]!.clips.some(c=>c.content.kind==='audio'&&c.content.role==='music')).toBe(true);
 }
 expect(new SequenceStore(project).load()!.document).toEqual(before);
});
it('marks a saved legacy project with no old cuts without rewriting live edits, and can Undo the check',async()=>{
 const o=owner(),before=sessions.open(project).document,plan=await backfills.prepare(project,o);
 expect(plan.entries).toEqual([]);
 const state=await backfills.adopt(project,{...o,executionId:'checked-empty-history',planId:plan.planId,planDigest:plan.planDigest});
 expect(state.document.cutArchive).toBeUndefined();expect(state.document.clips).toEqual(before.clips);
 expect(state.document.legacy?.cutHistoryImport).toMatchObject({version:1,sourceFingerprint:before.legacy!.sourceFingerprint});
 sessions.save(project,{...owner(),expectedSavedRevision:0,executionId:'save-empty-history'});
 const reopened=new SequenceService().open(project);expect(reopened.document.legacy?.cutHistoryImport).toEqual(state.document.legacy?.cutHistoryImport);
 const undone=sessions.execute(project,{...owner(),executionId:'undo-empty-history',command:{type:'undo'}});
 expect(sequenceContentBytes(undone.document)).toEqual(sequenceContentBytes(before));
});
it.each([false,true])('imports a wholly cut caption using the actual saved renderer, damaged=%s',async damaged=>{
 const store=new SequenceStore(project),snapshot=store.load()!;
 expect(snapshot.document.clips.some(c=>c.content.kind==='telop')).toBe(false);
 const component=snapshot.document.assets.find(a=>a.kind==='component')!;expect(component).toBeDefined();
 expect(snapshot.document.rendering?.telopComponentAssetId).toBe(component.id);
 if(damaged)await writeFile(join(project,component.file),'damaged saved renderer');
 const before=sessions.open(project).document,saved=await readFile(store.file),fingerprint=await legacyInputFingerprint(project);
 if(damaged){await expect(backfills.prepare(project,owner())).rejects.toThrow();expect(sessions.open(project).document).toEqual(before);}
 else{
  const o=owner(),plan=await backfills.prepare(project,o);
  const state=await backfills.adopt(project,{...o,executionId:'recover-only-caption',planId:plan.planId,planDigest:plan.planDigest});
  expect(state.document.rendering).toEqual(before.rendering);expect(state.document.clips).toEqual(before.clips);
  const archived=state.document.cutArchive!.entries[0]!.clips.find(c=>c.content.kind==='telop')!;
  expect(archived.content).toMatchObject({kind:'telop',componentAssetId:component.id,data:{text:'切れた帯だけの字幕'}});
  const restored=sessions.execute(project,{...owner(),executionId:'restore-only-caption',command:{type:'restore-cut',entryId:state.document.cutArchive!.entries[0]!.id}});
  expect(restored.document.clips.find(c=>c.content.kind==='telop')?.content).toEqual(archived.content);
 }
 expect(await readFile(store.file)).toEqual(saved);expect(await legacyInputFingerprint(project)).toBe(fingerprint);
});
it('preserves current edits with one undo, persists the marker and prevents repeat after full restore',async()=>{
 const beforeInput=await legacyInputFingerprint(project),media=await readFile(join(project,'public/main.mp4'));let o=owner();
 const clip=sessions.open(project).document.clips.find(c=>c.content.kind==='telop')!;
 if(clip.content.kind!=='telop')throw new Error('caption');
 const edited=sessions.execute(project,{...o,executionId:'caption-name',command:{type:'update-clip',clipId:clip.id,patch:{name:'人の編集中',content:{...clip.content,data:{...clip.content.data,text:'人が変更した本文'}}}}});
 o=owner();const before=edited.document,plan=await backfills.prepare(project,o);
 expect(plan.entries).toHaveLength(1);const request={...o,executionId:'backfill',planId:plan.planId,planDigest:plan.planDigest};
 const added=await backfills.adopt(project,request);expect(added.document.clips).toEqual(before.clips);expect(added.document.rendering).toEqual(before.rendering);expect((await backfills.adopt(project,request)).replayed).toBe(true);
 let state=sessions.execute(project,{...owner(),executionId:'undo-import',command:{type:'undo'}});expect(sequenceContentBytes(state.document)).toBe(sequenceContentBytes(before));
 state=sessions.execute(project,{...owner(),executionId:'redo-import',command:{type:'redo'}});
 state=sessions.execute(project,{...owner(),executionId:'restore-all',command:{type:'restore-cut',entryId:state.document.cutArchive!.entries[0]!.id}});
 expect(state.document.cutArchive).toBeUndefined();sessions.save(project,{...owner(),expectedSavedRevision:0,executionId:'save-import'});
 const reloaded=new SequenceService(),again=new LegacyCutBackfills(reloaded),read=reloaded.open(project);
 expect(read.document.legacy?.cutHistoryImport).toBeDefined();await expect(again.prepare(project,{sessionId:read.sessionId,expectedRevision:read.document.revision})).rejects.toThrow(/引き継ぎ済み/);
 expect(await legacyInputFingerprint(project)).toBe(beforeInput);expect(await readFile(join(project,'public/main.mp4'))).toEqual(media);
});
it.each(['revision','source','asset','cancel','digest'] as const)('leaves JSON/session unchanged when %s invalidates a plan',async mode=>{
 const o=owner(),plan=await backfills.prepare(project,o),saved=await readFile(new SequenceStore(project).file);
 if(mode==='revision')sessions.execute(project,{...o,executionId:'other',command:{type:'set-ducking',patch:{enabled:true}}});
 if(mode==='source')await writeFile(join(project,'cutData.ts'),'export const cutData=[];');
 if(mode==='asset'){const asset=sessions.open(project).document.assets.find(a=>a.kind==='media')!;const bytes=await readFile(join(project,asset.file));bytes[bytes.length-1]!^=1;await writeFile(join(project,asset.file),bytes);}
 const before=sessions.open(project).document,abort=new AbortController();if(mode==='cancel')abort.abort();
 await expect(backfills.adopt(project,{...o,executionId:'adopt',planId:plan.planId,planDigest:mode==='digest'?'b'.repeat(64):plan.planDigest},abort.signal)).rejects.toThrow();
 expect(sessions.open(project).document).toEqual(before);expect(await readFile(new SequenceStore(project).file)).toEqual(saved);
});
it('uses the existing save CAS and leaves a failed save undoable',async()=>{
 const o=owner(),plan=await backfills.prepare(project,o);const added=await backfills.adopt(project,{...o,planId:plan.planId,planDigest:plan.planDigest,executionId:'adopt'});
 expect(()=>sessions.save(project,{...owner(),expectedSavedRevision:99,executionId:'bad-save'})).toThrow(/保存済み/);expect(sessions.open(project).dirty).toBe(true);expect(new SequenceStore(project).load()!.document.cutArchive).toBeUndefined();expect(added.canUndo).toBe(true);
});
it('exposes prepare/adopt through actual HTTP, but never accepts caller supplied archives',async()=>{
 server=createServer((req,res)=>{void handleSequenceApi(req,res,new URL(req.url!,'http://localhost'),root,sessions).catch(error=>{res.statusCode=error instanceof SequenceError?409:400;res.end(String(error));});});
 await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('address');const url=`http://127.0.0.1:${address.port}/api/sequence`;
 const post=(route:string,body:unknown)=>fetch(`${url}${route}?id=case`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const o=owner(),response=await post('/legacy-cuts/prepare',o);expect(response.status,await response.clone().text()).toBe(200);const plan=await response.json();
 expect((await post('/legacy-cuts/adopt',{...o,executionId:'extra',planId:plan.planId,planDigest:plan.planDigest,entries:[]})).status).toBe(400);
 expect(JSON.stringify(plan)).not.toContain(root);expect((await post('/command',{...o,executionId:'forged',command:{type:'adopt-legacy-cut-history',sourceFingerprint:plan.sourceFingerprint,entries:[]}})).status).toBe(400);
 const adopted=await post('/legacy-cuts/adopt',{...o,executionId:'http',planId:plan.planId,planDigest:plan.planDigest});expect(adopted.status,await adopted.clone().text()).toBe(200);expect((await adopted.json()).document.cutArchive.entries).toHaveLength(1);
});

it('rejects another project, retired sessions and restart-lost plans without saving',async()=>{const o=owner(),plan=await backfills.prepare(project,o),request={...o,executionId:'adopt',planId:plan.planId,planDigest:plan.planDigest};const other=join(root,'other');await mkdir(other);await expect(backfills.adopt(other,request)).rejects.toThrow(/別の編集状態/);await expect(new LegacyCutBackfills(sessions).adopt(project,request)).rejects.toThrow(/期限切れ/);sessions.discard(project,o.sessionId,o.expectedRevision);await expect(backfills.adopt(project,request)).rejects.toThrow(/編集内容/);expect(new SequenceStore(project).load()!.document.cutArchive).toBeUndefined();});
it('allows fresh preparation after adoption Undo and never reapplies a replayed old plan',async()=>{const o=owner(),plan=await backfills.prepare(project,o),request={...o,executionId:'adopt',planId:plan.planId,planDigest:plan.planDigest};await backfills.adopt(project,request);sessions.execute(project,{...owner(),executionId:'undo',command:{type:'undo'}});const again=await backfills.prepare(project,owner());expect(again.planId).not.toBe(plan.planId);expect((await backfills.adopt(project,request)).replayed).toBe(true);expect(sessions.open(project).document.cutArchive).toBeUndefined();});
it('does not apply legacy data to native imports or changed source fingerprints',async()=>{const store=new SequenceStore(project),saved=store.load()!;delete saved.document.legacy;saved.document.revision++;store.save({expectedSavedRevision:0,executionId:'native',document:saved.document});await expect(backfills.prepare(project,owner())).rejects.toThrow(/移行元/);});
