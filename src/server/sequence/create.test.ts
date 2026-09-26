import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import { createSequenceProject } from './create';
import { SequenceStore } from './store';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { scanProjects } from '../scanProjects';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => {
  // The actual media importer may probe with ffprobe, but cannot start npm/npx
  // (including a shell wrapper). This also covers both HTTP creation modes.
  const calls = vi.mocked(spawn).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const args of calls) expect(JSON.stringify(args)).not.toMatch(/\b(?:npm|npx)(?:\.cmd)?\b/);
  vi.mocked(spawn).mockClear();
});

let root:string,source:string;
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'native-create-'));source=join(root,'source.mp4');
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30000/1001',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1.001','-c:v','libx264','-c:a','aac','-movflags','+faststart',source]);
});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
it('creates a native-only project with one managed source, exact fps and linked original audio',async()=>{
  const original=await readFile(source);
  const result=await createSequenceProject(root,{name:'新しい動画',videoName:source,sourcePath:source});
  const directory=join(root,result.id),saved=new SequenceStore(directory).load()!;
  expect(await readdir(directory)).toEqual(['.harness']);
  expect(saved.document).toMatchObject({fps:{num:30000,den:1001},sequenceEndFrame:30,resolution:{width:320,height:180},revision:0});
  expect(saved.document.assets).toHaveLength(1);expect(saved.document.assets[0]?.name).toBe('source.mp4');
  expect(saved.document.clips.map(clip=>clip.content.kind)).toEqual(['video','audio']);
  expect(new Set(saved.document.clips.map(clip=>clip.linkGroupId)).size).toBe(1);
  expect(saved.document.clips[0]?.linkGroupId).toBeTruthy();
  expect(await readFile(join(directory,saved.document.assets[0]!.file))).toEqual(original);expect(await readFile(source)).toEqual(original);
  expect(scanProjects(root).find(project=>project.id===result.id)?.videoAssetId).toBe(saved.document.assets[0]?.id);
});
it('refuses a duplicate without touching its saved data, and removes only its own failed import',async()=>{
  const input={name:'existing',videoName:'video.mp4',sourcePath:source};
  await createSequenceProject(root,input);
  const file=join(root,'existing/.harness/project.v2.json'),before=await readFile(file);
  await expect(createSequenceProject(root,input)).rejects.toThrow(/すでにあります/);expect(await readFile(file)).toEqual(before);
  const bad=join(root,'bad.mp4');await writeFile(bad,'not a movie');
  await expect(createSequenceProject(root,{...input,name:'failed',sourcePath:bad})).rejects.toThrow();
  expect(await readdir(root)).not.toContain('failed');expect(await readFile(bad,'utf8')).toBe('not a movie');
});
it('allows only one creator for a concurrent project name and preserves cancellation input',async()=>{
  const input={name:'concurrent',videoName:'video.mp4',sourcePath:source};
  const result=await Promise.allSettled([createSequenceProject(root,input),createSequenceProject(root,input)]);
  expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(new SequenceStore(join(root,input.name)).load()).not.toBeNull();
  const controller=new AbortController();controller.abort();
  await expect(createSequenceProject(root,{...input,name:'cancelled'},controller.signal)).rejects.toThrow();expect(await readdir(root)).not.toContain('cancelled');
});
it('pins matched reference bytes before creating a document and rolls back a rejected creation',async()=>{
 const bytes=await readFile(source),fingerprint=createHash('sha256').update(bytes).digest('hex');
 await expect(createSequenceProject(root,{name:'wrong-reference',videoName:'video.mp4',sourcePath:source,reference:true,expectedFingerprint:'a'.repeat(64)})).rejects.toThrow('指紋');
 expect(await readdir(root)).not.toContain('wrong-reference');expect(await readFile(source)).toEqual(bytes);
 const result=await createSequenceProject(root,{name:'exact-reference',videoName:'video.mp4',sourcePath:source,reference:true,expectedFingerprint:fingerprint});
 const saved=new SequenceStore(join(root,result.id)).load()!;expect(saved.document.assets[0]?.fingerprint).toBe(fingerprint);
 expect((await lstat(join(root,result.id,saved.document.assets[0]!.file))).isSymbolicLink()).toBe(true);expect(saved.document.clips).toHaveLength(2);
});
