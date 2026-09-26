import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile,rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { copyLegacyTemplateProject } from '../../../tests/fixtures/legacyTemplateProject';
import { handleApi } from '../plugin';
import { nativeExportContentDisposition } from './api';
import { SequenceService, type SequenceSessionState } from './service';
import { SequenceStore } from './store';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { legacyInputFingerprint, prepareLegacySequenceSnapshot } from './migration';
import { readSequenceComponent } from './components';
import { sequenceContentBytes } from '../../core/sequence/validate';
import { registeredSequenceAssets } from './assets';
import { sendApiError } from '../http';
import { saveProjectToDir } from '../saveProject';
import type { SaveRequest } from '../../shared/types';
import { createScriptDocument } from '../../core/scriptDocumentData';
import { createScriptEditArtifact } from '../scriptEditArtifacts';
import { TELOP_PACK } from '../telopPack/manifest';
import { PROJECT_TEMPLATE_PACK_ID } from '../telopPack/identity';
import type { ScriptEditInput } from '../../core/scriptEditProposal';
import { previewNativeScriptEdit,inspectNativeSavedScriptEdit } from './scriptEdits';
import { sequenceScriptEditCommand } from '../../core/sequence/scriptEdits';
import { sequenceContentHash } from './store';
import { planTransition, transitionJoins } from '../../core/sequence/transitions';

let mediaRoot: string, root: string, project: string, server: Server, origin: string;
it('suggests the original project name with a ハーネス prefix for downloaded movies',()=>{
  const header=nativeExportContentDisposition('練習方法: 初回 / テスト');
  expect(header).toContain('filename="harness.mp4"');
  expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe('ハーネス_練習方法_ 初回 _ テスト.mp4');
  expect(nativeExportContentDisposition('..').endsWith(encodeURIComponent('ハーネス_動画.mp4'))).toBe(true);
});
beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'harness-sequence-fixture-'));
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', join(mediaRoot, 'main.mp4')]);
}, 15000);
afterAll(async () => { await rm(mediaRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-sequence-api-')); project = join(root, 'case');
  copyLegacyTemplateProject(project);
  const config = await readFile(join(project, 'src/videoConfig.ts'), 'utf8');
  await writeFile(join(project, 'src/videoConfig.ts'), config.replace('DURATION_FRAMES = 1500', 'DURATION_FRAMES = 60'));
  await writeFile(join(project, 'src/テロップテンプレート/telopData.ts'), `export const telopData = [{id:1,startFrame:0,endFrame:60,text:'元の字幕',template:2,animation:'none'}];`);
  await writeFile(join(project, 'transcript.json'), JSON.stringify({ durationMs: 2000, words: [{ text: '発話', start: 0, end: 1900 }], segments: [] }));
  await mkdir(join(project, 'public')); await cp(join(mediaRoot, 'main.mp4'), join(project, 'public/main.mp4'));
  server = createServer((req, res) => {
    void handleApi(req, res, new URL(req.url!, 'http://localhost'), root)
      // 応答形（{error,reason?}）は本番の plugin.ts と同じ 1 本（sendApiError）を通す。
      // 手で複製すると reason の有無などが静かにずれ、テストが本番と別の形を検証してしまう。
      .catch(error => { sendApiError(res, error); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

it('prepares a frozen legacy export without committing editing authority or changing old inputs',async()=>{
  const fingerprint=await legacyInputFingerprint(project),video=await readFile(join(project,'public/main.mp4'));
  const result=await prepareLegacySequenceSnapshot(project);
  expect(new SequenceStore(project).load()).toBeNull();
  expect(await legacyInputFingerprint(project)).toBe(fingerprint);
  expect(await readFile(join(project,'public/main.mp4'))).toEqual(video);
  expect(result.document.legacy?.sourceFingerprint).toBe(fingerprint);
  expect(result.document.sequenceEndFrame).toBe(60);
  const caption=result.document.assets.find(asset=>asset.id===result.document.rendering?.telopComponentAssetId)!;
  const frozen=await readSequenceComponent(project,caption);
  await writeFile(join(project,'src/テロップテンプレート/Telop.tsx'),'changed old component');
  await writeFile(join(project,'public/main.mp4'),'changed old video');
  expect(await readSequenceComponent(project,caption)).toEqual(frozen);
  const media=result.document.assets.find(asset=>asset.id===result.document.legacy?.primaryAssetId)!;
  expect(await readFile(join(project,media.file))).toEqual(video);
  expect(new SequenceStore(project).load()).toBeNull();
});
async function post(route: string, body: unknown) {
  return fetch(`${origin}/api/sequence${route}?id=case`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function migrate(): Promise<void> {
  const response = await post('/migrate', { executionId: 'migration' });
  expect(response.status, await response.text()).toBe(200);
}
it('preflights saved sources and rejects a direct export before creating a job when a source disappears',async()=>{
 await migrate();const state=await open(),request={sessionId:state.sessionId,expectedRevision:state.document.revision};
 const healthy=await post('/export/preflight',request);expect(healthy.status).toBe(200);expect((await healthy.json()).issues).toEqual([]);
 const asset=state.document.assets.find(a=>a.kind==='media')!;await rename(join(project,asset.file),join(project,asset.file+'.offline'));
 const checked=await post('/export/preflight',request);expect(checked.status).toBe(200);expect((await checked.json()).issues).toEqual(expect.arrayContaining([expect.objectContaining({assetId:asset.id,name:asset.name})]));
 const rejected=await post('/export',{...request,executionId:'missing-before-export'});expect(rejected.status).toBe(422);expect((await rejected.json()).error).toContain(asset.name);
 const list=await fetch(`${origin}/api/sequence/export/list?id=case`);expect((await list.json()).jobs).toEqual([]);
 expect((await post('/export/preflight',{...request,expectedRevision:999})).status).toBe(409);
});
async function open(): Promise<SequenceSessionState> {
  const response = await post('/session', {}); expect(response.status).toBe(200); return response.json();
}
describe('native sequence HTTP boundary', () => {
  it('saves and undoes shared ducking settings, rejects stale or malformed changes without touching clips',async()=>{
    await migrate();const initial=await open();
    const request={sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'ducking',command:{type:'set-ducking',patch:{enabled:true,strength:'strong'}}};
    const response=await post('/command',request);expect(response.status,await response.clone().text()).toBe(200);const edited:SequenceSessionState=await response.json();
    expect(edited.document).toEqual({...initial.document,revision:initial.document.revision+1,ducking:{enabled:true,strength:'strong'}});
    expect((await post('/command',request)).status).toBe(200);expect((await post('/command',{...request,executionId:'stale-duck'})).status).toBe(409);
    for(const [index,patch] of [null,[],{enabled:'yes'},{strength:'loud'},{unexpected:true}].entries()){
      expect((await post('/command',{...request,expectedRevision:edited.document.revision,executionId:`bad-duck-${index}`,command:{type:'set-ducking',patch}})).status).toBe(400);
    }
    expect((await open()).document).toEqual(edited.document);
    expect((await post('/save',{sessionId:initial.sessionId,expectedRevision:edited.document.revision,expectedSavedRevision:initial.savedRevision,executionId:'save-duck'})).status).toBe(200);
    expect(new SequenceStore(project).load()!.document).toEqual(edited.document);
    const undone=await post('/command',{sessionId:initial.sessionId,expectedRevision:edited.document.revision,executionId:'undo-duck',command:{type:'undo'}});
    expect(undone.status).toBe(200);const restored:SequenceSessionState=await undone.json();expect(sequenceContentBytes(restored.document)).toBe(sequenceContentBytes(initial.document));expect(restored.canUndo).toBe(false);
  });
  it('persists one atomic scene-fade edit, protects replay/revision and undoes all targets together',async()=>{
    await migrate();const initial=await open();
    const request={sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'scene-fades',command:{type:'set-scene-fades',targets:[{kind:'head'},{kind:'tail'}],change:{enabled:true,color:'#FF3B30',durationFrames:31}}};
    const response=await post('/command',request);expect(response.status,await response.clone().text()).toBe(200);
    const edited:SequenceSessionState=await response.json();expect(edited.document.clips.filter(c=>c.content.kind==='scene-fade')).toHaveLength(2);
    expect(edited.document.clips.filter(c=>c.content.kind!=='scene-fade')).toEqual(initial.document.clips);expect(edited.document.sequenceEndFrame).toBe(initial.document.sequenceEndFrame);
    expect((await post('/command',request)).status).toBe(200);
    expect((await post('/command',{...request,executionId:'stale'})).status).toBe(409);
    const invalid=await post('/command',{...request,expectedRevision:edited.document.revision,executionId:'invalid',command:{...request.command,targets:Array.from({length:1001},()=>({kind:'head'}))}});
    expect(invalid.status).toBe(400);expect((await open()).document).toEqual(edited.document);
    const saved=await post('/save',{sessionId:initial.sessionId,expectedRevision:edited.document.revision,expectedSavedRevision:initial.savedRevision,executionId:'save-fades'});expect(saved.status).toBe(200);
    expect(new SequenceStore(project).load()!.document).toEqual(edited.document);
    const undone=await post('/command',{sessionId:initial.sessionId,expectedRevision:edited.document.revision,executionId:'undo-fades',command:{type:'undo'}});
    expect(undone.status).toBe(200);const restored:SequenceSessionState=await undone.json();
    expect(sequenceContentBytes(restored.document)).toBe(sequenceContentBytes(initial.document));expect(restored.canUndo).toBe(false);
  });
  it('allows a well-formed set-transition, rejects malformed shapes and unknown keys, and releases with transition:null',async()=>{
    await migrate();const initial=await open();
    const clip=initial.document.clips.find(c=>c.content.kind==='video')!;
    const splitFrame=Math.floor(initial.document.sequenceEndFrame/2);
    const split=await post('/command',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'split',command:{type:'split',clipIds:[clip.id],frame:splitFrame}});
    expect(split.status,await split.clone().text()).toBe(200);
    const afterSplit:SequenceSessionState=await split.json();
    const join=transitionJoins(afterSplit.document)[0]!;
    const planned=planTransition(afterSplit.document,join.joinKey,'crossfade',10);
    if('error' in planned)throw new Error(`fixture: ${planned.error}`);
    const request={sessionId:initial.sessionId,expectedRevision:afterSplit.document.revision,executionId:'transition',command:{type:'set-transition',joinKey:join.joinKey,transition:planned.transition}};
    const response=await post('/command',request);expect(response.status,await response.clone().text()).toBe(200);
    const edited:SequenceSessionState=await response.json();
    expect(edited.document.transitions).toHaveLength(1);
    expect(edited.document.transitions[0]).toMatchObject({joinKey:join.joinKey,kind:'crossfade',durationFrames:10});
    const rev=edited.document.revision;
    const badShapes=[
      {type:'set-transition',joinKey:123,transition:planned.transition},
      {type:'set-transition',joinKey:join.joinKey,transition:{...planned.transition,kind:123}},
      {type:'set-transition',joinKey:join.joinKey,transition:{...planned.transition,durationFrames:0}},
      {type:'set-transition',joinKey:join.joinKey,transition:{...planned.transition,extra:'not part of the shape'}},
    ];
    for(const [index,command] of badShapes.entries()){
      const res=await post('/command',{sessionId:initial.sessionId,expectedRevision:rev,executionId:`bad-transition-${index}`,command});
      expect(res.status,await res.clone().text()).toBe(400);
    }
    const release=await post('/command',{sessionId:initial.sessionId,expectedRevision:rev,executionId:'release',command:{type:'set-transition',joinKey:join.joinKey,transition:null}});
    expect(release.status,await release.clone().text()).toBe(200);
    const released:SequenceSessionState=await release.json();
    expect(released.document.transitions).toHaveLength(0);
  });
  it('allows remove-asset for an unused asset, rejects a malformed assetId, and 400s a referenced one with targets',async()=>{
    await migrate();const initial=await open();
    const usedClip=initial.document.clips.find(c=>c.content.kind==='video')!,usedClipContent=usedClip.content;
    if(usedClipContent.kind!=='video')throw new Error('fixture: expected a video clip');
    const usedAssetId=usedClipContent.assetId;
    // 未参照の素材を1件つくる（未使用のLUT）。
    const cube='LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
    const uploaded=await fetch(`${origin}/api/sequence/upload?id=case&name=invert.cube`,{method:'POST',body:cube});
    expect(uploaded.status,await uploaded.clone().text()).toBe(200);
    const {asset}=await uploaded.json();
    const registered=await post('/register',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'register-lut',assetIds:[asset.id]});
    expect(registered.status,await registered.clone().text()).toBe(200);
    const withLut:SequenceSessionState=await registered.json();
    const malformed=await post('/command',{sessionId:initial.sessionId,expectedRevision:withLut.document.revision,executionId:'bad-remove',command:{type:'remove-asset',assetId:123}});
    expect(malformed.status,await malformed.clone().text()).toBe(400);
    const removed=await post('/command',{sessionId:initial.sessionId,expectedRevision:withLut.document.revision,executionId:'remove-unused',command:{type:'remove-asset',assetId:asset.id}});
    expect(removed.status,await removed.clone().text()).toBe(200);
    const afterRemove:SequenceSessionState=await removed.json();
    expect(afterRemove.document.assets.some(a=>a.id===asset.id)).toBe(false);
    const blocked=await post('/command',{sessionId:initial.sessionId,expectedRevision:afterRemove.document.revision,executionId:'remove-used',command:{type:'remove-asset',assetId:usedAssetId}});
    expect(blocked.status,await blocked.clone().text()).toBe(400);
    const blockedBody=await blocked.json();
    expect(blockedBody.code).toBe('BROKEN_REFERENCE');
    expect(blockedBody.targets.length).toBeGreaterThan(0);
    // M-a: 拒否理由の本文には、どのクリップが使っているかがユーザーに分かるようクリップ名が入る。
    expect(blockedBody.error).toContain(usedClip.name);
  });
  it('fixes the speech audio into a new asset and swaps the reference with one replace-audio-source',async()=>{
    await migrate();const initial=await open();
    const speech=initial.document.clips.find(c=>c.content.kind==='audio'&&c.content.role==='speech');
    if(!speech||speech.content.kind!=='audio')throw new Error('fixture: expected a speech audio clip');
    const originalAssetId=speech.content.assetId;
    const fixResponse=await fetch(`${origin}/api/audio-fix?id=case`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({assetId:originalAssetId,kind:'denoise'})});
    expect(fixResponse.status,await fixResponse.clone().text()).toBe(200);
    const fixed=await fixResponse.json();
    expect(fixed.asset.origin).toEqual({kind:'audio-fix',from:originalAssetId,fix:'denoise'});
    // 形が不正な参照切替は文書へ届かない。
    for(const [index,command] of [{type:'replace-audio-source',trackId:123,fromAssetId:originalAssetId,toAssetId:fixed.asset.id},
      {type:'replace-audio-source',trackId:speech.trackId,fromAssetId:'',toAssetId:fixed.asset.id},
      {type:'replace-audio-source',trackId:speech.trackId,fromAssetId:originalAssetId,toAssetId:'../escape'}].entries()) {
      const malformed=await post('/command',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:`bad-swap-${index}`,command});
      expect(malformed.status,JSON.stringify(command)).toBe(400);
    }
    const registered=await post('/register',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'register-fixed',assetIds:[fixed.asset.id]});
    expect(registered.status,await registered.clone().text()).toBe(200);
    const withFixed:SequenceSessionState=await registered.json();
    const swapped=await post('/command',{sessionId:initial.sessionId,expectedRevision:withFixed.document.revision,executionId:'swap-audio',
      command:{type:'replace-audio-source',trackId:speech.trackId,fromAssetId:originalAssetId,toAssetId:fixed.asset.id}});
    expect(swapped.status,await swapped.clone().text()).toBe(200);
    const after:SequenceSessionState=await swapped.json();
    const movedClip=after.document.clips.find(c=>c.id===speech.id)!;
    expect(movedClip.content.kind==='audio'&&movedClip.content.assetId).toBe(fixed.asset.id);
    // 原本は文書にも素材台帳にも残る（裁定 P0-1: 上書きしない）。
    expect(after.document.assets.some(a=>a.id===originalAssetId)).toBe(true);
    expect((await registeredSequenceAssets(project)).some(a=>a.id===originalAssetId)).toBe(true);
    const undone=await post('/command',{sessionId:initial.sessionId,expectedRevision:after.document.revision,executionId:'undo-swap',command:{type:'undo'}});
    expect(undone.status).toBe(200);
    const restored:SequenceSessionState=await undone.json();
    expect(restored.document.clips).toEqual(withFixed.document.clips);
  },60000);
  it('rejects a malformed replace-text-style-asset and lets a well-formed one reach the document',async()=>{
    await migrate();const initial=await open();
    for(const [index,command] of [{type:'replace-text-style-asset',fromAssetId:123,toAssetId:'b'},
      {type:'replace-text-style-asset',fromAssetId:'a',toAssetId:''},
      {type:'replace-text-style-asset',fromAssetId:'a',toAssetId:'../escape'}].entries()) {
      const malformed=await post('/command',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:`bad-style-swap-${index}`,command});
      expect(malformed.status,JSON.stringify(command)).toBe(400);
    }
    // 形は通る。素材が無いことだけを文書側が拒否する（transport の 400 ではない）。
    const accepted=await post('/command',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'style-swap-missing',
      command:{type:'replace-text-style-asset',fromAssetId:'missing-a',toAssetId:'missing-b'}});
    expect(accepted.status,await accepted.clone().text()).not.toBe(400);
  });
  it('registers native styles while preserving frozen project styles, rejects stale requests, and persists the catalog',async()=>{
    await migrate();const initial=await open(),original=initial.document.rendering!.telopComponentAssetId!;
    const path=join(project,'src/テロップテンプレート/Telop.tsx'),source=await readFile(path,'utf8');
    // Catalog discovery must read the frozen component even if the original TSX changes.
    await writeFile(path,'throw new Error("must not load old TSX");');
    const request={sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'native-style-pack'};
    const response=await post('/text-styles',request);expect(response.status,await response.clone().text()).toBe(200);
    const result:SequenceSessionState=await response.json();
    expect(result.document.clips).toEqual(initial.document.clips);
    expect(result.document.rendering).toEqual(initial.document.rendering);
    const projectCatalog=result.document.assets.find(asset=>asset.id===original)?.textStyleCatalog;
    // 案件テンプレートが同梱するスタイル番号そのもの。件数は雛形が正なのでテストに書かない
    // （T15b で 15＋77 種を統合したとき、7 固定の期待値では毎回テストを書き換えることになる）。
    const templateStyleIds=[...readFileSync(resolve(import.meta.dirname,'../../../project-template/src/テロップテンプレート/Telop.tsx'),'utf8')
      .match(/const TEMPLATE_MAP[\s\S]*?\n};/)![0].matchAll(/^\s+(\d+):/gm)].map(match=>Number(match[1])).sort((left,right)=>left-right);
    expect(projectCatalog).toMatchObject({source:'project',packId:PROJECT_TEMPLATE_PACK_ID,entries:templateStyleIds.map(id=>({id,name:`スタイル ${id}`}))});
    expect(projectCatalog!.version).toBe(initial.document.assets.find(asset=>asset.id===original)!.fingerprint.slice(0,8));
    expect(projectCatalog!.componentHash).toMatch(/^[a-f0-9]{16}$/);
    const builtin=result.document.assets.find(asset=>asset.textStyleCatalog?.source==='builtin')!;
    expect(builtin.textStyleCatalog!.entries).toHaveLength(TELOP_PACK.length);
    const component=await fetch(`${origin}/api/sequence/component?id=case&asset=${builtin.id}`);
    expect(component.status).toBe(200);expect(await component.text()).toContain('NATIVE_TEXT_STYLE_CATALOG');
    expect(await readFile(path,'utf8')).toBe('throw new Error("must not load old TSX");');
    expect((await post('/text-styles',{...request,executionId:'stale'})).status).toBe(409);
    const saved=await post('/save',{sessionId:result.sessionId,expectedRevision:result.document.revision,expectedSavedRevision:initial.savedRevision,executionId:'save-style-pack'});
    expect(saved.status,await saved.clone().text()).toBe(200);
    expect(new SequenceStore(project).load()!.document.assets).toEqual(result.document.assets);
    expect(source).toContain('Telop');
  });
  it('2回目の /text-styles はカタログが揃っているので revision を進めない（選択するだけでdirtyにならない）',async()=>{
    await migrate();const initial=await open();
    const first=await post('/text-styles',{sessionId:initial.sessionId,expectedRevision:initial.document.revision,executionId:'first-prepare'});
    expect(first.status,await first.clone().text()).toBe(200);
    const registered:SequenceSessionState=await first.json();
    const second=await post('/text-styles',{sessionId:registered.sessionId,expectedRevision:registered.document.revision,executionId:'second-prepare'});
    expect(second.status,await second.clone().text()).toBe(200);
    const again:SequenceSessionState=await second.json();
    expect(again.document.revision).toBe(registered.document.revision);
    expect(again.dirty).toBe(registered.dirty);
    expect(again.document.assets).toEqual(registered.document.assets);
  });
  it.each(['caption','structure'] as const)('freezes native %s input, previews without mutation, and preserves one Undo',async kind=>{
    await migrate();const initial=await open(),script=createScriptDocument('発話',{documentId:'script',revision:'one'});
    await post('/command',{sessionId:initial.sessionId,expectedRevision:0,executionId:'script',command:{type:'set-script',script}});
    await post('/save',{sessionId:initial.sessionId,expectedRevision:1,expectedSavedRevision:0,executionId:'script-save'});
    const saved=await open(),speech=saved.document.clips.find(c=>c.content.kind==='audio'&&c.content.role==='speech')!;
    const request={sessionId:saved.sessionId,expectedRevision:1,occurrenceId:speech.id,mode:kind};
    const response=await post('/script/edit-input',request);expect(response.status,await response.clone().text()).toBe(200);
    const input:ScriptEditInput=await response.json();
    expect(input.native?.source.occurrenceId).toBe(speech.id);
    const caption=saved.document.clips.find(c=>c.id===input.native!.captions[0]!.clipId)!;
    expect(caption.content.kind).toBe('telop');
    const passage=input.alignment.packet.script.passages[0]!,candidate=input.alignment.proposals[0]!.candidates[0]!;
    const proposal={schemaVersion:1,kind,proposalId:`script-edit:${kind}:${input.inputHash}`,inputHash:input.inputHash,generator:input.alignment.proposals[0]!.generator,
      passages:[{passageId:passage.id,action:'use',candidateIndex:0,reason:'合成テストの一致候補'}],
      ...(kind==='caption'?{changes:[{telopId:input.editing.telops[0]!.id,before:input.editing.telops[0]!.text,after:'発話',passageId:passage.id,scriptRange:passage.range,wordRef:candidate.wordRef}]}:{})};
    const artifact=createScriptEditArtifact(input,proposal),reviewRequest={sessionId:saved.sessionId,expectedRevision:1,artifact};
    await writeFile(join(project,'src/videoConfig.ts'),'invalid legacy');
    const previewResponse=await post('/script/edit-review',reviewRequest);expect(previewResponse.status,await previewResponse.clone().text()).toBe(200);
    const preview=await previewResponse.json();expect(preview.before).toEqual(saved.document);
    expect((await open()).document).toEqual(saved.document);expect(new SequenceStore(project).load()!.contentHash).toBe(saved.savedContentHash);
    if(kind==='caption') {
      expect(preview.after.clips.find((c:{id:string})=>c.id===caption.id).content.data).toEqual({...((caption.content as {data:object}).data),text:'発話'});
      expect(preview.after.clips.filter((c:{id:string})=>c.id!==caption.id)).toEqual(saved.document.clips.filter(c=>c.id!==caption.id));
      expect(preview.plan.native.targets).toEqual([{telopId:input.editing.telops[0]!.id,clipId:caption.id}]);
    }else {
      expect(preview.after.sequenceEndFrame).toBe(57);
      expect(preview.plan.native.ranges).toEqual([{startFrame:0,endFrame:57}]);
    }
    // A fresh service reads the persistent frozen input; applying uses the common history.
    const fresh=new SequenceService(),state=fresh.open(project);
    expect(previewNativeScriptEdit(project,'case',artifact).after).toEqual(preview.after);
    const command=sequenceScriptEditCommand(state.document,sequenceContentHash(state.document),artifact);
    expect(command.type).toBe(kind==='caption'?'batch':'reorder-ranges');
    const inputRequest={schemaVersion:1,projectId:'case',operationId:'script:judgment',baseRevision:`native:${state.sessionId}:1`,script:{judgmentId:'judgment',artifact},changes:[]};
    expect(inspectNativeSavedScriptEdit(project,'case',artifact).savedState).toBe('input');
    const applied=fresh.applyEditor(project,'case',state.sessionId,inputRequest);
    expect(applied.document.clips).toEqual(preview.after.clips);
    fresh.save(project,{sessionId:state.sessionId,expectedRevision:2,expectedSavedRevision:1,executionId:'save-adopt'});
    expect(inspectNativeSavedScriptEdit(project,'case',artifact)).toMatchObject({documentFormat:'sequence-v2',savedState:'proposal',presenceHash:sequenceContentHash(applied.document)});
    const undone=fresh.execute(project,{sessionId:state.sessionId,expectedRevision:2,executionId:'undo-adopt',command:{type:'undo'}});
    expect(sequenceContentBytes(undone.document)).toBe(sequenceContentBytes(saved.document));
    expect(fresh.applyEditor(project,'case',state.sessionId,inputRequest).replayed).toBe(true);
    expect(fresh.open(project).document).toEqual(undone.document);
    expect((await post('/script/edit-review',reviewRequest)).status).toBe(409);
    await writeFile(join(project,'.harness/script-inputs',`${input.inputHash}.json`),'{}');
    expect(()=>previewNativeScriptEdit(project,'case',artifact)).toThrow(/入力ID/);
  });
  it('aligns a saved script with the chosen frozen source without changing captions or reading old files',async()=>{
    await migrate();const initial=await open(),script=createScriptDocument('発話',{documentId:'script',revision:'one'});
    const edited=await (await post('/command',{sessionId:initial.sessionId,expectedRevision:0,executionId:'script',command:{type:'set-script',script}})).json();
    const speech=edited.document.clips.find((c:{content:{kind:string;role?:string}})=>c.content.kind==='audio' && c.content.role==='speech');
    const request={sessionId:initial.sessionId,expectedRevision:1,occurrenceId:speech.id,mode:'caption'};
    expect((await post('/script/alignment',request)).status).toBe(409);
    expect((await post('/save',{sessionId:initial.sessionId,expectedRevision:1,expectedSavedRevision:0,executionId:'save-script'})).status).toBe(200);
    await writeFile(join(project,'src/videoConfig.ts'),'invalid legacy file');await writeFile(join(project,'transcript.json'),'invalid legacy transcript');
    const response=await post('/script/alignment',request);expect(response.status).toBe(200);
    const artifact=await response.json();expect(artifact.packet.script).toEqual(script);
    expect(artifact.proposals[0].status).toBe('unique');expect(artifact.packet.editRevision).toMatch(/^native:1:/);
    expect((await open()).document.clips).toEqual(initial.document.clips);
    expect((await post('/script/alignment',{...request,expectedRevision:0})).status).toBe(409);
    expect((await post('/script/alignment',{...request,occurrenceId:'missing'})).status).toBe(400);
    expect((await post('/script/alignment',{...request,mode:'unknown'})).status).toBe(400);
    const asset=edited.document.assets.find((a:{id:string})=>a.id===speech.content.assetId);
    await writeFile(join(project,asset.file),'changed managed source');
    expect((await post('/script/alignment',request)).status).not.toBe(200);
  });
  it('migrates without changing legacy files, serves pinned component/media and survives old-source edits', async () => {
    const before = await legacyInputFingerprint(project), originalMedia = await readFile(join(project, 'public/main.mp4'));
    await migrate();
    expect(await legacyInputFingerprint(project)).toBe(before);
    const saved = new SequenceStore(project).load()!;
    expect(saved.document.sequenceEndFrame).toBe(60);
    const media = saved.document.assets.find(a => a.kind === 'media')!;
    const renderer = saved.document.assets.find(a => a.kind === 'component')!;
    const componentUrl = `${origin}/api/sequence/component?id=case&asset=${renderer.id}`;
    const component = await (await fetch(componentUrl)).text();
    const response = await fetch(`${origin}/api/sequence/asset?id=case&asset=${media.id}`, { headers: { Range: 'bytes=0-31' } });
    expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(originalMedia.subarray(0, 32));
    await writeFile(join(project, 'src/テロップテンプレート/Telop.tsx'), 'invalid old source');
    await writeFile(join(project, 'public/main.mp4'), 'replaced old media');
    expect(await (await fetch(componentUrl)).text()).toBe(component);
    expect(new SequenceStore(project).load()!.contentHash).toBe(saved.contentHash);
    expect(await (await fetch(`${origin}/api/sequence/legacy-status?id=case`)).json()).toEqual({ status: 'changed' });
    expect((await (await post('/migrate', { executionId: 'again' })).json()).replayed).toBe(true);
    const pinned = await fetch(`${origin}/api/sequence/asset?id=case&asset=${media.id}`);
    expect(Buffer.from(await pinned.arrayBuffer())).toEqual(originalMedia);
  });
  it('shares one human/AI history, rejects stale edits and undoes an entire ripple in one action', async () => {
    await migrate(); const initial = await open();
    expect((await open()).sessionId).toBe(initial.sessionId);
    const cut = { sessionId: initial.sessionId, expectedRevision: 0, executionId: 'cut', command: { type: 'ripple-delete', startFrame: 15, endFrame: 30 } };
    const edited = await (await post('/command', cut)).json();
    expect(edited.document.sequenceEndFrame).toBe(45); expect(edited.canUndo).toBe(true); expect(edited.dirty).toBe(true);
    expect((await (await post('/command', cut)).json()).replayed).toBe(true);
    expect((await post('/command', { ...cut, executionId: 'stale-ai' })).status).toBe(409);
    const undone = await (await post('/command', { ...cut, expectedRevision: 1, executionId: 'undo', command: { type: 'undo' } })).json();
    expect(sequenceContentBytes(undone.document)).toBe(sequenceContentBytes(initial.document));
    expect(undone.document.revision).toBe(2); expect(undone.canRedo).toBe(true);
    const saved = await (await post('/save', { sessionId: initial.sessionId, expectedRevision: 2, expectedSavedRevision: 0, executionId: 'save' })).json();
    expect(saved.dirty).toBe(false); expect(new SequenceStore(project).load()!.savedRevision).toBe(2);
    expect(new SequenceStore(project).load()!.contentHash).toBe(initial.savedContentHash);
  });
  it('accepts a rippled trim that actually closes the gap, and refuses a non-boolean ripple flag', async () => {
    await migrate(); const initial = await open();
    const clip = initial.document.clips.find(c => c.content.kind === 'video')!;
    // 検算: この案件は DURATION_FRAMES=60（beforeEach）で映像が尺いっぱい。式で導くので数値は手で埋めない。
    const end = Math.min(clip.startFrame + clip.durationFrames, initial.document.sequenceEndFrame);
    const ok = await post('/command', { sessionId: initial.sessionId, expectedRevision: 0, executionId: 'ripple',
      command: { type: 'trim', clipId: clip.id, edge: 'end', frame: end - 10, ripple: true } });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    // 終了端を 10fr 縮めると [end-10, end) を全トラックから取り除くので、尺は 10 減り復元記録が 1 件増える。
    // ripple を無視した従来 trim では尺は変わらず記録も増えないので、これは ripple が効いた証拠になる。
    expect(body.document.sequenceEndFrame).toBe(initial.document.sequenceEndFrame - 10);
    expect(body.document.cutArchive.entries).toHaveLength(1);
    const bad = await post('/command', { sessionId: initial.sessionId, expectedRevision: 1, executionId: 'bad-ripple',
      command: { type: 'trim', clipId: clip.id, edge: 'end', frame: 10, ripple: 'yes' } });
    expect(bad.status).toBe(400);
  });
  it('retries an acknowledged save after further edits without overwriting them', async () => {
    await migrate(); const initial = await open();
    const save = { sessionId: initial.sessionId, expectedRevision: 0, expectedSavedRevision: 0, executionId: 'save' };
    expect((await post('/save', save)).status).toBe(200);
    await post('/command', { sessionId: initial.sessionId, expectedRevision: 0, executionId: 'new', command: { type: 'ripple-delete', startFrame: 10, endFrame: 20 } });
    const retry = await (await post('/save', save)).json();
    expect(retry.replayed).toBe(true); expect(retry.document.revision).toBe(1); expect(retry.dirty).toBe(true);
    expect(new SequenceStore(project).load()!.document.sequenceEndFrame).toBe(60);
  });
  it('refuses external save conflicts and only discards the expected unsaved revision', async () => {
    await migrate(); const initial = await open();
    await post('/command', { sessionId: initial.sessionId, expectedRevision: 0, executionId: 'new', command: { type: 'ripple-delete', startFrame: 10, endFrame: 20 } });
    const store = new SequenceStore(project), document = store.load()!.document;
    document.revision = 2; document.name = '外部変更';
    store.save({ expectedSavedRevision: 0, executionId: 'external', document });
    expect((await post('/session', {})).status).toBe(409);
    expect((await post('/discard', { sessionId: initial.sessionId, expectedRevision: 0 })).status).toBe(409);
    const restored = await (await post('/discard', { sessionId: initial.sessionId, expectedRevision: 1 })).json();
    expect(restored.document.name).toBe('外部変更'); expect(restored.sessionId).not.toBe(initial.sessionId);
  });
  it('prepares and streams shared mixer PCM without exposing an absolute server path', async () => {
    await migrate(); const saved = new SequenceStore(project).load()!, asset = saved.document.assets.find(a => a.kind === 'media')!;
    const response = await fetch(`${origin}/api/sequence/audio?id=case&asset=${asset.id}&stream=1&rateNum=2&rateDen=1`);
    const pcm = await response.json(); expect(response.status).toBe(200); expect(pcm.sampleRate).toBe(48000);
    expect(pcm).not.toHaveProperty('file'); expect(pcm.sampleCount).toBeGreaterThan(45000); expect(pcm.sampleCount).toBeLessThan(51000);
    const block = await fetch(origin + pcm.url, { headers: { Range: 'bytes=0-63' } });
    expect(block.status).toBe(206); expect((await block.arrayBuffer()).byteLength).toBe(64);
  });
  it('serves bounded source waveform bins from verified managed PCM with rate, source offset and silence',async()=>{
    await migrate();const saved=new SequenceStore(project).load()!,asset=saved.document.assets.find(a=>a.kind==='media')!;
    const query=new URLSearchParams({id:'case',asset:asset.id,stream:'1',rateNum:'2',rateDen:'1',sourceInNum:'1',sourceInDen:'2',fpsNum:'30',fpsDen:'1',startFrame:'-1',frameCount:'5',clipFrames:'3',bins:'5',loop:'0'});
    const response=await fetch(`${origin}/api/sequence/waveform?${query}`),result=await response.json();expect(response.status).toBe(200);
    expect(result.precision).toBe('prepared-pcm-sample-floor');expect(result.sampleRate).toBe(48000);expect(result.bins).toHaveLength(5);
    expect(result.bins[0]).toEqual({peak:0,rms:0,samples:1600});expect(result.bins[4]).toEqual({peak:0,rms:0,samples:1600});
    expect(result.bins[1].peak).toBeGreaterThan(.01);expect(result.bins[1].rms).toBeGreaterThan(.005);
    expect(JSON.stringify(result)).not.toContain(project);expect(result.request.rate).toEqual({num:2,den:1});
    query.set('bins','2401');expect((await fetch(`${origin}/api/sequence/waveform?${query}`)).status).toBe(400);
    query.set('bins','5');query.set('loop','yes');expect((await fetch(`${origin}/api/sequence/waveform?${query}`)).status).toBe(400);
    query.set('loop','0');query.set('stream','0');expect((await fetch(`${origin}/api/sequence/waveform?${query}`)).status).toBe(422);
    query.set('stream','1');await writeFile(join(project,asset.file),'modified managed original');
    expect((await fetch(`${origin}/api/sequence/waveform?${query}`)).status).toBe(422);
    expect((await post('/waveform',{})).status).toBe(405);
  });
  it('rejects malformed edits, unsupported methods, traversal, and changed managed assets', async () => {
    await migrate(); const initial = await open();
    expect((await post('/command', { sessionId: initial.sessionId, expectedRevision: 0, executionId: 'bad', command: { type: 'delete', clipIds: 'legacy-video-1' } })).status).toBe(400);
    expect((await open()).document.revision).toBe(0);
    expect((await fetch(`${origin}/api/sequence/save?id=case`)).status).toBe(405);
    expect((await fetch(`${origin}/api/sequence?id=..`)).status).toBe(400);
    const media = initial.document.assets.find(a => a.kind === 'media')!;
    const url = `${origin}/api/sequence/asset?id=case&asset=${media.id}`;
    expect((await fetch(url)).status).toBe(200);
    await writeFile(join(project, media.file), 'changed managed asset');
    expect((await fetch(url)).status).toBe(422);
    expect((await fetch(`${origin}/api/sequence/asset?id=case&asset=unknown&path=/etc/hosts`)).status).toBe(404);
  });
  it('keeps an uploaded LUT reusable after a revision conflict and persists its registration through save/reopen', async () => {
    await migrate(); const initial = await open();
    const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
    const uploaded = await fetch(`${origin}/api/sequence/upload?id=case&name=look.cube`, { method: 'POST', body: cube });
    const { asset } = await uploaded.json(); expect(uploaded.status).toBe(200); expect(asset.kind).toBe('lut');
    expect(new SequenceStore(project).load()!.document.assets.some(a => a.id === asset.id)).toBe(false);
    const register = { sessionId: initial.sessionId, executionId: 'lut', expectedRevision: 99, assetIds: [asset.id] };
    expect((await post('/register', register)).status).toBe(409);
    const registry = await (await fetch(`${origin}/api/sequence/assets?id=case`)).json();
    expect(registry.assets.some((a: { id: string }) => a.id === asset.id)).toBe(true);
    const registered = await (await post('/register', { ...register, expectedRevision: 0 })).json();
    expect(registered.document.assets.some((a: { id: string }) => a.id === asset.id)).toBe(true);
    expect(registered.document.revision).toBe(1);
    const bytes = await (await fetch(`${origin}/api/sequence/asset?id=case&asset=${asset.id}`)).text(); expect(bytes).toBe(cube);
    expect((await post('/save', { sessionId: initial.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 'save-lut' })).status).toBe(200);
    const reopened = new SequenceService().open(project);
    expect(reopened.document.assets.some(a => a.id === asset.id)).toBe(true);
    const invalid = await fetch(`${origin}/api/sequence/upload?id=case&name=broken.cube`, { method: 'POST', body: 'LUT_3D_SIZE 2\n0 0 0' });
    expect(invalid.status).toBe(422);
    expect((await (await fetch(`${origin}/api/sequence/assets?id=case`)).json()).assets).toHaveLength(registry.assets.length);
  });
  it('prevents legacy save/render entry points from rereading or writing the old project after migration', async () => {
    await migrate(); const hash = new SequenceStore(project).load()!.contentHash, before = await legacyInputFingerprint(project);
    const save = await fetch(`${origin}/api/project?id=case`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(save.status).toBe(409); expect(await save.text()).toContain('新形式');
    expect(() => saveProjectToDir(project, {} as SaveRequest)).toThrow(/新形式/);
    await writeFile(join(project, 'src/videoConfig.ts'), 'invalid legacy config');
    const render = await fetch(`${origin}/api/render?id=case`, { method: 'POST', body: '{}' });
    expect(render.status).toBe(409); expect(await render.text()).toContain('新形式');
    expect(new SequenceStore(project).load()!.contentHash).toBe(hash);
    expect(await legacyInputFingerprint(project)).not.toBe(before);
  });
  it('C-1: /command が apply-text-style-all と set-text-style-hidden を受け付け、形の不正だけを 400 にする', async () => {
    await migrate(); const initial = await open();
    const preparation = await post('/text-styles', { sessionId: initial.sessionId, expectedRevision: initial.document.revision, executionId: 'prepare-styles' });
    expect(preparation.status, await preparation.clone().text()).toBe(200);
    const prepared: SequenceSessionState = await preparation.json();
    const pack = prepared.document.assets.find(asset => asset.textStyleCatalog?.source === 'builtin')!;
    const styleId = pack.textStyleCatalog!.entries[0]!.id;
    const applied = await post('/command', { sessionId: prepared.sessionId, expectedRevision: prepared.document.revision, executionId: 'apply-all',
      command: { type: 'apply-text-style-all', assetId: pack.id, styleId, clearUnsupportedAnimations: true } });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const afterApply: SequenceSessionState = await applied.json();
    const telops = afterApply.document.clips.filter(clip => clip.content.kind === 'telop');
    expect(telops.length).toBeGreaterThan(0);
    for (const clip of telops) {
      if (clip.content.kind !== 'telop') throw new Error('fixture: expected a telop clip');
      expect(clip.content.componentAssetId).toBe(pack.id); expect(clip.content.data.template).toBe(styleId);
    }
    const hiddenResponse = await post('/command', { sessionId: prepared.sessionId, expectedRevision: afterApply.document.revision, executionId: 'hide-style',
      command: { type: 'set-text-style-hidden', assetId: pack.id, hidden: [styleId] } });
    expect(hiddenResponse.status, await hiddenResponse.clone().text()).toBe(200);
    const afterHidden: SequenceSessionState = await hiddenResponse.json();
    expect(afterHidden.document.textStylePrefs?.hidden[pack.id]).toEqual([styleId]);
    const revision = afterHidden.document.revision;
    const badShapes = [
      { type: 'apply-text-style-all', assetId: 123, styleId },
      { type: 'apply-text-style-all', assetId: pack.id, styleId, trackId: 123 },
      { type: 'apply-text-style-all', assetId: pack.id, styleId: 0 },
      { type: 'apply-text-style-all', assetId: pack.id, styleId: 1.5 },
      { type: 'apply-text-style-all', assetId: pack.id, styleId, clearUnsupportedAnimations: 'yes' },
      { type: 'set-text-style-hidden', assetId: pack.id, hidden: 'none' },
      { type: 'set-text-style-hidden', assetId: pack.id, hidden: [-1] },
      { type: 'set-text-style-hidden', assetId: pack.id, hidden: [1.5] },
    ];
    for (const [index, command] of badShapes.entries()) {
      const response = await post('/command', { sessionId: prepared.sessionId, expectedRevision: revision, executionId: `bad-style-${index}`, command });
      expect(response.status, `${index}: ${await response.clone().text()}`).toBe(400);
    }
  }, 60000);
  it('C-1: /command の register-assets は描画部品だけを受け、保存済みバイトと指紋が合わないものを拒む', async () => {
    await migrate(); const initial = await open();
    const component = initial.document.assets.find(asset => asset.kind === 'component')!;
    const revision = initial.document.revision;
    const badShapes = [
      { type: 'register-assets', assets: [] },
      { type: 'register-assets', assets: [{ ...component, kind: 'media' }] },
      { type: 'register-assets', assets: [{ ...component, id: '../escape' }] },
      { type: 'register-assets', assets: [{ ...component, fingerprint: 'f'.repeat(64) }] },
      { type: 'register-assets', assets: [{ ...component, file: '../outside.mjs' }] },
    ];
    for (const [index, command] of badShapes.entries()) {
      const response = await post('/command', { sessionId: initial.sessionId, expectedRevision: revision, executionId: `bad-register-${index}`, command });
      expect(response.status, `${index}: ${await response.clone().text()}`).toBe(400);
    }
    const accepted = await post('/command', { sessionId: initial.sessionId, expectedRevision: revision, executionId: 'register-known',
      command: { type: 'register-assets', assets: [{ ...component, name: '追加パック test' }] } });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
  }, 60000);
  it('does not commit v2 or rewrite sources when a legacy renderer cannot be migrated', async () => {
    await writeFile(join(project, 'src/テロップテンプレート/Telop.tsx'), `import {Video} from 'remotion'; export const Telop = () => <Video />;`);
    const before = await legacyInputFingerprint(project);
    const response = await post('/migrate', { executionId: 'unsupported' });
    expect(response.status).toBe(422); expect(await response.text()).toContain('Video');
    expect(new SequenceStore(project).load()).toBeNull();
    expect(await legacyInputFingerprint(project)).toBe(before);
  });
});

// 履歴（git show）にも有料素材にも依存しない入力検査。履歴に依存する検査は api.product.test.ts（内部のみ）。
describe('POST /api/telop-template-update/plan (I-2, Task 18)', () => {
  async function postPlan(id: string) {
    return fetch(`${origin}/api/telop-template-update/plan?id=${encodeURIComponent(id)}`, { method: 'POST' });
  }
  it('400: 不正な projectId は拒む', async () => {
    const response = await postPlan('../escape');
    expect(response.status, await response.clone().text()).toBe(400);
  });
});

describe('POST /api/telop-template-update/apply (I-2, Task 19)', () => {
  // plugin.ts は planId の形を sequenceService.open より前に検証するので、旧テンプレートへの差し替え（git show）は要らない。
  async function postApply(body: unknown) {
    return fetch(`${origin}/api/telop-template-update/apply?id=case`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('400: planId が無ければ拒む', async () => {
    const response = await postApply({ expectedRevision: 1 });
    expect(response.status, await response.clone().text()).toBe(400);
  });
  it('400: `../` を含む planId は案件の外へ出る前に拒む（I-4）', async () => {
    for (const planId of ['../x', '../../../../etc', 'nope']) {
      const response = await postApply({ planId, expectedRevision: 1 });
      expect(response.status, `${planId}: ${await response.clone().text()}`).toBe(400);
    }
    const revert = await fetch(`${origin}/api/telop-template-update/revert?id=case`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: '../x' }) });
    expect(revert.status, await revert.clone().text()).toBe(400);
  });
});

describe('POST /api/telop-template-update/revert (I-2, Task 20)', () => {
  async function postRevert(body: unknown) {
    return fetch(`${origin}/api/telop-template-update/revert?id=case`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('400: planId が無ければ拒む', async () => {
    const response = await postRevert({});
    expect(response.status, await response.clone().text()).toBe(400);
  });
});

describe('GET /api/telop-template-update/status (Codex P2)', () => {
  async function getStatus(id: string) {
    return fetch(`${origin}/api/telop-template-update/status?id=${encodeURIComponent(id)}`, { method: 'GET' });
  }
  it('400: 不正な projectId は拒む', async () => {
    const response = await getStatus('../escape');
    expect(response.status, await response.clone().text()).toBe(400);
  });
  it('200: 控えが無ければ applied は null', async () => {
    const response = await getStatus('case');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ applied: null });
  });
});

it('reports external saves without replacing the session and requires the observed hash on reload',async()=>{
  await migrate();const initial=await open(),store=new SequenceStore(project),document=store.load()!.document;
  document.name='外部で変更';document.revision++;
  const saved=store.save({document,executionId:'outside',expectedSavedRevision:0});
  const status=await (await post('/session/status',{sessionId:initial.sessionId})).json();
  expect(status.sessionId).toBe(initial.sessionId);expect(status.document.name).toBe(initial.document.name);
  expect(status.externalChange).toMatchObject({contentHash:saved.contentHash,savedRevision:1});
  expect((await open()).sessionId).toBe(initial.sessionId);
  const reloaded=await (await post('/session/reload',{sessionId:initial.sessionId,expectedRevision:0,savedRevision:1,contentHash:saved.contentHash})).json();
  expect(reloaded.document.name).toBe('外部で変更');expect(reloaded.sessionId).not.toBe(initial.sessionId);
});
it('accepts an external AI batch without browser standby and exposes durable, deduplicated activity',async()=>{
  await migrate();const initial=await open(),document=structuredClone(initial.document);document.revision++;document.name='AI batch';
  const request={metadata:{operationId:'outside-codex',kind:'ai',source:'外部Codex',summary:'構成を調整'},before:{savedRevision:initial.savedRevision,contentHash:initial.savedContentHash},document};
  const first=await post('/external-edit',request);expect(first.status,await first.clone().text()).toBe(200);
  expect((await first.json()).status).toBe('saved');expect((await post('/external-edit',request)).status).toBe(200);
  const list=await fetch(`${origin}/api/sequence/external-edits?id=case`);expect(list.status).toBe(200);
  expect((await list.json()).records).toHaveLength(1);
});
it('creates a native preview proxy without changing source clocks or the saved editing document',async()=>{
  await migrate();const initial=await open(),before=await readFile(join(project,'.harness/project.v2.json'),'utf8');
  const asset=initial.document.assets.find(asset=>asset.streams.some(stream=>stream.kind==='video'))!;
  const result=await post('/proxy',{sessionId:initial.sessionId,assetId:asset.id});expect(result.status,await result.clone().text()).toBe(200);
  let status:any;
  const until=Date.now()+15000;
  do {
    const response=await fetch(`${origin}/api/sequence/proxies?id=case`);expect(response.status).toBe(200);
    status=(await response.json()).assets.find((item:any)=>item.assetId===asset.id);
    if(status.ready||status.job?.phase==='failed')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }while(Date.now()<until);
  expect(status.ready,JSON.stringify(status)).toBe(true);
  const range=await fetch(`${origin}/api/sequence/asset?id=case&asset=${asset.id}&preview=1`,{headers:{Range:'bytes=0-63'}});
  expect(range.status).toBe(206);expect((await range.arrayBuffer()).byteLength).toBe(64);
  expect(await readFile(join(project,'.harness/project.v2.json'),'utf8')).toBe(before);
},20000);
