import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SequenceStore } from './store';
import type { SequenceDocument } from '../../core/sequence/model';
import { scanProjects, isSuperMovieProject } from '../scanProjects';
import { resolveProjectSteps } from '../projectSteps';
import { projectIdFromWatchedPath, watchAllProjectsStatus, type ProjectStatusEvent } from '../projectsWatch';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'native-summary-'));roots.push(root);
  const directory=join(root,'case');mkdirSync(directory);
  const document:SequenceDocument={schemaVersion:2,id:'case',name:'保存した名前',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:90,
    background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const store=new SequenceStore(directory);store.save({document,expectedSavedRevision:null,executionId:'initial'});
  return {root,directory,document,store};
}
it('lists native-only projects and ignores old TSX dimensions, contents and later timestamps',()=>{
  const {root,directory,document,store}=fixture();
  mkdirSync(join(directory,'src/テロップテンプレート'),{recursive:true});
  writeFileSync(join(directory,'src/videoConfig.ts'),'throw new Error("must not read legacy")');
  writeFileSync(join(directory,'src/テロップテンプレート/telopData.ts'),'invalid old captions');
  const item=scanProjects(root)[0]!;
  expect(item).toMatchObject({id:'case',name:'保存した名前',durationLabel:'0:03',orientation:'h',videoFile:null,steps:{cut:true,telop:'empty',rendered:false}});
  rmSync(join(directory,'src'),{recursive:true});expect(isSuperMovieProject(directory)).toBe(true);expect(scanProjects(root)).toHaveLength(1);
  document.revision++;document.sequenceEndFrame=180;store.save({document,expectedSavedRevision:0,executionId:'edit'});
  expect(scanProjects(root)[0]?.durationLabel).toBe('0:06');
});
it('marks rendered only for a complete file matching current saved content and never trusts a path in a receipt',()=>{
  const {directory,document,store}=fixture(),job='12345678-1234-1234-1234-123456789abc';
  const folder=join(directory,'.harness/exports',job);mkdirSync(folder,{recursive:true});
  const receipt=join(directory,'.harness/last-export.json');
  writeFileSync(receipt,JSON.stringify({jobId:job,contentHash:store.load()!.contentHash}));
  expect(resolveProjectSteps(directory).rendered).toBe(false);
  writeFileSync(join(folder,'output.mp4'),'verified output');expect(resolveProjectSteps(directory).rendered).toBe(true);
  document.revision++;document.sequenceEndFrame++;store.save({document,expectedSavedRevision:0,executionId:'change'});
  expect(resolveProjectSteps(directory).rendered).toBe(false);
  writeFileSync(receipt,JSON.stringify({jobId:'../../other',contentHash:store.load()!.contentHash}));expect(resolveProjectSteps(directory).rendered).toBe(false);
});
it('does not resurrect legacy state from a broken v2 document and watches only native metadata',()=>{
  const {root,directory}=fixture();writeFileSync(join(directory,'.harness/project.v2.json'),'broken');
  vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  expect(scanProjects(root)).toEqual([]);expect(()=>resolveProjectSteps(directory)).toThrow();
  expect(projectIdFromWatchedPath(root,join(directory,'.harness/project.v2.json'))).toBe('case');
  expect(projectIdFromWatchedPath(root,join(directory,'.harness/last-export.json'))).toBe('case');
  expect(projectIdFromWatchedPath(root,join(directory,'.harness/assets/video.mp4'))).toBeNull();
  expect(projectIdFromWatchedPath(root,join(directory,'サムネ/case サムネ.png'))).toBe('case');
  expect(projectIdFromWatchedPath(root,join(directory,'サムネ/case サムネ 案B.jpg'))).toBe('case');
  expect(projectIdFromWatchedPath(root,join(directory,'サムネ/memo.txt'))).toBeNull();
});
it('emits live status after a native save, including changes during watcher startup',async()=>{
  const {root,document,store}=fixture(),events:ProjectStatusEvent[]=[];
  const stop=watchAllProjectsStatus(root,event=>events.push(event),{debounceMs:20});
  try {
    document.revision++;document.name='ライブで編集';store.save({document,expectedSavedRevision:0,executionId:'live'});
    await vi.waitFor(()=>expect(events.some(event=>event.id==='case' && event.steps?.cut && event.lastEditedAt)).toBe(true),{timeout:3000,interval:30});
  } finally {stop();}
});
it('サムネの書き出しが無い案件は thumbnailCover を持たない（カードは従来どおり）',()=>{
  const {root}=fixture();
  const item=scanProjects(root)[0]!;
  expect(item.id).toBe('case');
  expect('thumbnailCover' in item).toBe(false);
});
it('メインの書き出し サムネ/<案件名> サムネ.(png|jpg) があれば thumbnailCover が付く。別名・リンク・中身の無いファイルは使わない',()=>{
  const {root,directory}=fixture(),folder=join(directory,'サムネ');mkdirSync(folder);
  writeFileSync(join(folder,'case サムネ 案B.png'),'other');
  expect(scanProjects(root)[0]!.thumbnailCover).toBeUndefined();
  const outside=join(root,'outside.png');writeFileSync(outside,'outside');symlinkSync(outside,join(folder,'case サムネ.png'));
  expect(scanProjects(root)[0]!.thumbnailCover).toBeUndefined();
  rmSync(join(folder,'case サムネ.png'));writeFileSync(join(folder,'case サムネ.png'),'');
  expect(scanProjects(root)[0]!.thumbnailCover).toBeUndefined();
  writeFileSync(join(folder,'case サムネ.png'),'png');
  expect(scanProjects(root)[0]!.thumbnailCover).toEqual({file:'サムネ/case サムネ.png',mtimeMs:expect.any(Number)});
  // 両方ある時は新しい方。
  writeFileSync(join(folder,'case サムネ.jpg'),'jpg');const later=new Date(Date.now()+60_000);utimesSync(join(folder,'case サムネ.jpg'),later,later);
  expect(scanProjects(root)[0]!.thumbnailCover).toEqual({file:'サムネ/case サムネ.jpg',mtimeMs:later.getTime()});
});
it('サムネのフォルダーがリンク（案件の外）なら使わない',()=>{
  const {root,directory}=fixture(),elsewhere=mkdtempSync(join(tmpdir(),'native-summary-outside-'));roots.push(elsewhere);
  writeFileSync(join(elsewhere,'case サムネ.png'),'outside');symlinkSync(elsewhere,join(directory,'サムネ'));
  expect(scanProjects(root)[0]!.thumbnailCover).toBeUndefined();
});
it('サムネを書き出すと、一覧へ thumbnailCover の差分を流す（一覧を開き直さなくてよい）',async()=>{
  const {root,directory}=fixture(),events:ProjectStatusEvent[]=[];
  const stop=watchAllProjectsStatus(root,event=>events.push(event),{debounceMs:20});
  try {
    await new Promise(resolve=>setTimeout(resolve,300));
    mkdirSync(join(directory,'サムネ'));writeFileSync(join(directory,'サムネ/case サムネ.png'),'png');
    await vi.waitFor(()=>expect(events.some(event=>event.id==='case'&&event.thumbnailCover?.file==='サムネ/case サムネ.png')).toBe(true),{timeout:4000,interval:30});
  } finally {stop();}
});
