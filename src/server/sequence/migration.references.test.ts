import {loadProject} from '../../core/project';
import {readProjectFiles} from '../loadProjectFiles';
import {legacyPreviewReferences} from '../../core/sequence/legacyPreview';
import {serializeTelopData} from '../../core/telopData';
import {clampImages,projectImages} from '../../core/imageEngine';
import {serializeInsertImageData} from '../../core/insertImageData';
import {readSequenceComponent} from './components';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyLegacyTemplateProject} from '../../../tests/fixtures/legacyTemplateProject';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {videoLinkPath, writeVideoLink} from '../videoLink';
import {SequenceStore} from './store';
import {legacyInputFingerprint, migrateSequenceProject, prepareLegacySequenceSnapshot} from './migration';
import {applySequenceCommand} from '../../core/sequence/commands';

const fault = vi.hoisted(() => ({afterImport: undefined as undefined | (() => Promise<void>)}));
vi.mock('./assets', async load => {
  const actual = await load<typeof import('./assets')>();
  return {...actual, importSequenceAsset: async (...args: Parameters<typeof actual.importSequenceAsset>) => {
    const asset = await actual.importSequenceAsset(...args); await fault.afterImport?.(); return asset;
  }};
});
vi.mock('./references', async load => {
  const actual = await load<typeof import('./references')>();
  return {...actual, registerSequenceReference: async (...args: Parameters<typeof actual.registerSequenceReference>) => {
    const asset = await actual.registerSequenceReference(...args); await fault.afterImport?.(); return asset;
  }};
});

let mediaRoot: string, root: string, project: string, source: string, leaf: string;
beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), 'harness-linked-migration-media-'));
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', join(mediaRoot, 'main.mp4')]);
}, 15000);
afterAll(async () => {await rm(mediaRoot, {recursive: true, force: true});});
beforeEach(async () => {
  fault.afterImport = undefined;
  root = await mkdtemp(join(tmpdir(), 'harness-linked-migration-')); project = join(root, 'case');
  source = join(root, 'external.mp4'); leaf = join(project, 'public/main.mp4');
  await cp(join(mediaRoot, 'main.mp4'), source); copyLegacyTemplateProject(project);
  const config = await readFile(join(project, 'src/videoConfig.ts'), 'utf8');
  await writeFile(join(project, 'src/videoConfig.ts'), config.replace('DURATION_FRAMES = 1500', 'DURATION_FRAMES = 60'));
  await writeFile(join(project, 'src/テロップテンプレート/telopData.ts'), 'export const telopData = [];');
  await writeFile(join(project, 'transcript.json'), JSON.stringify({durationMs: 2000, words: [], segments: []}));
  await mkdir(join(project, 'public')); await symlink(source, leaf);
  const info = await stat(source);
  writeVideoLink(project, {target: source, sizeBytes: info.size, mtimeMs: info.mtimeMs, width: 128, height: 72, fps: 30});
});
afterEach(async () => {fault.afterImport = undefined; await rm(root, {recursive: true, force: true});});

it('migrates an explicitly linked main without copying its bytes and preserves AV clocks and old inputs', async () => {
  const before = await legacyInputFingerprint(project), bytes = await readFile(source), record = await readFile(videoLinkPath(project));
  const originalLeaf = await lstat(leaf);
  const result = await prepareLegacySequenceSnapshot(project);
  const asset = result.document.assets.find(a => a.id === result.document.legacy?.primaryAssetId)!;
  expect(asset.file).toMatch(/^\.harness\/references\//);
  expect((await lstat(join(project, asset.file))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(project, asset.file))).toEqual(bytes);
  expect(existsSync(join(project, '.harness/assets', asset.file.split('/').at(-1)!))).toBe(false);
  expect(result.document.sequenceEndFrame).toBe(60);
  const av = result.document.clips.filter(c => c.content.kind === 'video' || c.content.kind === 'audio');
  expect(av).toHaveLength(2);
  expect(av.map(c => [c.startFrame, c.durationFrames])).toEqual([[0, 60], [0, 60]]);
  expect(av.map(c => c.content.kind === 'video' || c.content.kind === 'audio' ? [c.content.sourceIn, c.content.rate] : null))
    .toEqual([[{num: 0, den: 1}, {num: 1, den: 1}], [{num: 0, den: 1}, {num: 1, den: 1}]]);
  expect(await legacyInputFingerprint(project)).toBe(before);
  expect(await readFile(videoLinkPath(project))).toEqual(record); expect(await readFile(source)).toEqual(bytes);
  expect((await lstat(leaf)).ino).toBe(originalLeaf.ino); expect(await readlink(leaf)).toBe(source);
  expect(new SequenceStore(project).load()).toBeNull();
});

it('keeps an already migrated document on replay even if the external drive is now absent', async () => {
  const first = await migrateSequenceProject(project, 'linked-migration');
  await rename(source, source + '.offline');
  const second = await migrateSequenceProject(project, 'linked-replay');
  expect(second.replayed).toBe(true); expect(second.document).toEqual(first.document);
});

it('saves old cut bands with the first migration while draft snapshots and original linked files stay unchanged',async()=>{
  await writeFile(join(project,'cutData.ts'),'export const cutData = [{id:1,originalStart:0,originalEnd:15,playbackStart:0,playbackEnd:15},{id:2,originalStart:30,originalEnd:60,playbackStart:15,playbackEnd:45}];');
  const fingerprint=await legacyInputFingerprint(project),bytes=await readFile(source),inode=(await lstat(leaf)).ino;
  const preview=await prepareLegacySequenceSnapshot(project);expect(preview.document.cutArchive).toBeUndefined();expect(preview.document.sequenceEndFrame).toBe(45);
  const migrated=await migrateSequenceProject(project,'old-cuts');expect(migrated.document.clips).toEqual(preview.document.clips);
  const entry=migrated.document.cutArchive!.entries[0]!;expect(entry.durationFrames).toBe(15);expect(entry.legacyRecovery?.sourceFingerprint).toBe(fingerprint);
  const store=new SequenceStore(project),saved=store.load()!;expect(saved.document.cutArchive).toEqual(migrated.document.cutArchive);
  const restored=applySequenceCommand(saved.document,{type:'restore-cut',entryId:entry.id});expect(restored.sequenceEndFrame).toBe(60);
  store.save({expectedSavedRevision:saved.savedRevision,executionId:'restore-old-cut',document:restored});expect(store.load()!.document.clips).toEqual(restored.clips);
  expect(await legacyInputFingerprint(project)).toBe(fingerprint);expect(await readFile(source)).toEqual(bytes);expect((await lstat(leaf)).ino).toBe(inode);expect(await readlink(leaf)).toBe(source);
});

it.each(['missing', 'mismatched', 'unregistered'] as const)('refuses %s main links without publishing editing authority', async mode => {
  if (mode === 'missing') await rename(source, source + '.offline');
  if (mode === 'mismatched') await writeFile(source, 'different bytes');
  if (mode === 'unregistered') await unlink(videoLinkPath(project));
  await expect(migrateSequenceProject(project, 'invalid-link')).rejects.toThrow();
  expect(new SequenceStore(project).load()).toBeNull();
});

it.each(['record', 'leaf'] as const)('rejects a changed legacy %s after admission instead of saving a stale migration', async changed => {
  fault.afterImport = async () => {
    if (changed === 'record') await writeFile(videoLinkPath(project), (await readFile(videoLinkPath(project), 'utf8')) + '\n');
    else {await unlink(leaf); await symlink(source, leaf);}
  };
  await expect(migrateSequenceProject(project, 'changed-link')).rejects.toThrow(/変更/);
  expect(new SequenceStore(project).load()).toBeNull();
});

it('keeps the managed import path for ordinary legacy media', async () => {
  await unlink(videoLinkPath(project)); await unlink(leaf); await cp(source, leaf);
  const result = await prepareLegacySequenceSnapshot(project);
  const asset = result.document.assets.find(a => a.id === result.document.legacy?.primaryAssetId)!;
  expect(asset.file).toMatch(/^\.harness\/assets\//);
  expect((await lstat(join(project, asset.file))).isFile()).toBe(true);
});

it('retries a rejected migration after the explicit legacy link moves to identical bytes', async () => {
  const replacement = join(root, 'replacement.mp4'); await cp(source, replacement);
  fault.afterImport = async () => {
    fault.afterImport = undefined; await rename(source, source + '.offline'); await unlink(leaf); await symlink(replacement, leaf);
    const info = await stat(replacement);
    writeVideoLink(project, {target: replacement, sizeBytes: info.size, mtimeMs: info.mtimeMs, width: 128, height: 72, fps: 30});
  };
  await expect(migrateSequenceProject(project, 'first-stale')).rejects.toThrow(/変更/);
  expect(new SequenceStore(project).load()).toBeNull();
  const retry = await migrateSequenceProject(project, 'retry-current');
  const asset = retry.document.assets.find(a => a.id === retry.document.legacy?.primaryAssetId)!;
  expect(asset.file).toMatch(/^\.harness\/references\//);
  expect(await readlink(join(project, asset.file))).toBe(await realpath(replacement));
  expect(await readFile(join(project, asset.file))).toEqual(await readFile(replacement));
});

it('preserves the pre-reference editing fingerprint used by already migrated projects', async () => {
  const linked = await legacyInputFingerprint(project);
  await rename(videoLinkPath(project), videoLinkPath(project) + '.retained');
  expect(await legacyInputFingerprint(project)).toBe(linked);
});


it('retains a caption wholly inside an old cut through actual catalog preparation, first migration and restore',async()=>{
  await writeFile(join(project,'cutData.ts'),'export const cutData = [{id:1,originalStart:0,originalEnd:15,playbackStart:0,playbackEnd:15},{id:2,originalStart:30,originalEnd:60,playbackStart:15,playbackEnd:45}];');
  const captionSource=serializeTelopData('export const telopData=[];',[{id:71,startFrame:14,endFrame:14,originalStart:18,originalEnd:27,text:'切れた帯だけの字幕',template:2,animation:'none'}]);
  await writeFile(join(project,'src/テロップテンプレート/telopData.ts'),captionSource);
  const loaded=loadProject(readProjectFiles(project));expect(loaded.telops[0]).toMatchObject({originalStart:18,originalEnd:27});expect(legacyPreviewReferences(loaded).telop).toBe(true);
  const fingerprint=await legacyInputFingerprint(project),original=await readFile(source),draft=await prepareLegacySequenceSnapshot(project);
  expect(draft.document.clips.some(c=>c.content.kind==='telop')).toBe(false);
  const preparedRenderer=draft.document.assets.find(a=>a.kind==='component'&&a.name==='Telop');expect(preparedRenderer).toBeDefined();
  const result=await migrateSequenceProject(project,'only-cut-caption'),doc=result.document,entry=doc.cutArchive!.entries[0]!;
  expect(doc.clips).toEqual(draft.document.clips);expect(doc.rendering?.telopComponentAssetId).toBe(preparedRenderer!.id);
  expect(doc.rendering?.staticFiles?.['main.mp4']).toBe(doc.legacy?.primaryAssetId);
  const caption=entry.clips.find(c=>c.content.kind==='telop');expect(caption).toMatchObject({startFrame:3,durationFrames:9,content:{componentAssetId:preparedRenderer!.id,data:{text:'切れた帯だけの字幕'}}});
  expect((await readSequenceComponent(project,preparedRenderer!)).length).toBeGreaterThan(100);
  const saved=new SequenceStore(project).load()!.document;expect(saved.cutArchive).toEqual(doc.cutArchive);expect(saved.rendering).toEqual(doc.rendering);
  const restored=applySequenceCommand(saved,{type:'restore-cut',entryId:entry.id});expect(restored.clips.find(c=>c.content.kind==='telop')).toMatchObject({startFrame:18,durationFrames:9,content:{componentAssetId:preparedRenderer!.id}});
  expect(await legacyInputFingerprint(project)).toBe(fingerprint);expect(await readFile(source)).toEqual(original);
});

it('catalogs every raw saved image, restores a crossing image and does not invent the lost interval of an entirely cut image',async()=>{
  await writeFile(join(project,'cutData.ts'),'export const cutData = [{id:1,originalStart:0,originalEnd:15,playbackStart:0,playbackEnd:15},{id:2,originalStart:30,originalEnd:60,playbackStart:15,playbackEnd:45}];');
  const regions=[{start:15,end:30}];
  // Actual legacy save path: clamp -> project -> serializer has no originalStart/End fields.
  const images=[{id:41,originalStart:10,originalEnd:35,file:'cross.png',type:'plain' as const,scale:1},{id:42,originalStart:18,originalEnd:27,file:'hidden.png',type:'plain' as const,scale:1}];
  const savedImages=projectImages(clampImages(images,regions).images,regions);
  const serialized=serializeInsertImageData(null,savedImages)!;expect(serialized).not.toMatch(/originalStart|originalEnd/);
  await writeFile(join(project,'src/InsertImage/insertImageData.ts'),serialized);await mkdir(join(project,'public/images'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  for(const name of ['cross.png','hidden.png'])await writeFile(join(project,'public/images',name),png);
  const loaded=loadProject(readProjectFiles(project)),references=legacyPreviewReferences(loaded);
  expect(loaded.images.find(i=>i.id===41)).toMatchObject({originalStart:10,originalEnd:35});
  expect(loaded.images.find(i=>i.id===42)).toMatchObject({originalStart:0,originalEnd:0});
  expect(references.images).toEqual([{id:41,file:'cross.png'},{id:42,file:'hidden.png'}]);
  const fingerprint=await legacyInputFingerprint(project),draft=await prepareLegacySequenceSnapshot(project);expect(draft.document.clips.filter(c=>c.content.kind==='image')).toHaveLength(1);
  const migrated=await migrateSequenceProject(project,'saved-images'),doc=migrated.document,entry=doc.cutArchive!.entries[0]!;
  expect(doc.clips).toEqual(draft.document.clips);
  for(const name of ['cross.png','hidden.png']){const id=doc.rendering!.staticFiles!['images/'+name];expect(id).toBeDefined();const asset=doc.assets.find(a=>a.id===id)!;expect(asset.kind).toBe('image');expect(await readFile(join(project,asset.file))).toEqual(png);}
  const renderer=doc.assets.find(a=>a.id===doc.rendering?.imageComponentAssetId)!;expect(renderer.kind).toBe('component');expect((await readSequenceComponent(project,renderer)).length).toBeGreaterThan(100);
  const archived=entry.clips.filter(c=>c.content.kind==='image');expect(archived).toHaveLength(1);expect(archived[0]).toMatchObject({startFrame:0,durationFrames:15,content:{legacyId:41}});
  const stored=new SequenceStore(project).load()!.document;expect(stored.cutArchive).toEqual(doc.cutArchive);expect(stored.rendering).toEqual(doc.rendering);
  const restored=applySequenceCommand(stored,{type:'restore-cut',entryId:entry.id});expect(restored.clips.filter(c=>c.content.kind==='image').reduce((sum,c)=>sum+c.durationFrames,0)).toBe(25);
  expect(restored.clips.some(c=>c.content.kind==='image'&&c.content.legacyId===42)).toBe(false);expect(await legacyInputFingerprint(project)).toBe(fingerprint);
});
