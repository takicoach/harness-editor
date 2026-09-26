import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
});
it('emits live status after a native save, including changes during watcher startup',async()=>{
  const {root,document,store}=fixture(),events:ProjectStatusEvent[]=[];
  const stop=watchAllProjectsStatus(root,event=>events.push(event),{debounceMs:20});
  try {
    document.revision++;document.name='ライブで編集';store.save({document,expectedSavedRevision:0,executionId:'live'});
    await vi.waitFor(()=>expect(events.some(event=>event.id==='case' && event.steps?.cut && event.lastEditedAt)).toBe(true),{timeout:3000,interval:30});
  } finally {stop();}
});
