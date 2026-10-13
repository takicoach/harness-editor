import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceDocument} from '../../core/sequence/model';
import {SequenceStore} from './store';
function document(revision=0,name='素材'):SequenceDocument{return {schemaVersion:2,id:'project',name:'編集',revision,fps:{num:30,den:1},resolution:{width:1920,height:1080},sequenceEndFrame:0,background:'#000000',
  assets:[{id:'media-a',kind:'media',file:'.harness/assets/a.mp4',name,fingerprint:'a'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',duration:{num:1,den:1},sampleRate:48000,channels:2}]}],
  tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};}
let directory:string;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'harness-asset-index-'));});
afterEach(()=>{vi.restoreAllMocks();rmSync(directory,{recursive:true,force:true});});
it('reuses one frozen asset index while the saved file keeps its identity, without cloning the document',()=>{
  const store=new SequenceStore(directory);expect(store.assetIndex()).toBeNull();
  store.save({expectedSavedRevision:null,executionId:'first',document:document()});
  const first=store.assetIndex()!;expect(first.get('media-a')!.name).toBe('素材');expect(Object.isFrozen(first.get('media-a')!.streams[0])).toBe(true);
  const clone=vi.spyOn(globalThis,'structuredClone');
  expect(new SequenceStore(directory).assetIndex()).toBe(first);expect(clone).not.toHaveBeenCalled();
});
it('rebuilds after a save and after an in-place rewrite that keeps size and modification time',()=>{
  const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'first',document:document()});const first=store.assetIndex()!;
  store.save({expectedSavedRevision:0,executionId:'second',document:document(1,'改名')});const second=store.assetIndex()!;
  expect(second).not.toBe(first);expect(second.get('media-a')!.name).toBe('改名');
  const file=join(directory,'.harness/project.v2.json'),before=statSync(file),raw=readFileSync(file,'utf8');
  writeFileSync(file,raw.replace('改名','異名'));utimesSync(file,before.atime,before.mtime);   // 同じ大きさ・同じ更新時刻（ctime だけ変わる）
  expect(store.assetIndex()!.get('media-a')!.name).toBe('異名');
});
it('peek reports the saved revision and content hash like load, without cloning the document',()=>{
  const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'first',document:document()});
  const loaded=store.load()!,clone=vi.spyOn(globalThis,'structuredClone');
  expect(store.peek()).toEqual({savedRevision:loaded.savedRevision,contentHash:loaded.contentHash,clipCount:0});expect(clone).not.toHaveBeenCalled();
});
