// 書き出し前の確認は、応答しない読みを無期限に待たない（2026-10-06: 起動後に読み取りが open() で固まり、preflight が 176 秒以上返らなかった）。
// 開く処理が戻らない状況は書き手の無い FIFO で作る（試験の終わりに書き手を開いて解放する）。読みが進まない状況は試験用の遅延 HARNESS_TEST_DIGEST_DELAY_MS で作る。
import {afterEach,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,realpath,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {importSequenceAsset} from './assets';
import {exportPreflightTesting,preflightSequenceExport} from './exportPreflight';
import {FS_REPORT_MS,fsWatchTesting} from './fsWatch';
import {referenceVerificationTesting,registerSequenceReference} from './references';

const MiB=1024*1024,roots:string[]=[],fifos:string[]=[],LIMIT=exportPreflightTesting.unresponsiveMs,STALL=referenceVerificationTesting.stallMs;
async function release(fifo:string){try{const writer=await open(fifo,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENXIO')throw e;}}
afterEach(async()=>{
  for(const fifo of fifos.splice(0))await release(fifo);
  await vi.waitFor(()=>expect(fsWatchTesting.pending()).toEqual([]));
  vi.unstubAllEnvs();vi.restoreAllMocks();await referenceVerificationTesting.idle();referenceVerificationTesting.forget();
  exportPreflightTesting.unresponsiveMs=LIMIT;referenceVerificationTesting.stallMs=STALL;fsWatchTesting.reportMs=FS_REPORT_MS;
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});
function wav(mib:number){const samples=mib*MiB/2,b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%100,i);return b;}
async function project(){const root=await mkdtemp(join(await realpath(tmpdir()),'harness-preflight-stuck-'));roots.push(root);const dir=join(root,'project');await mkdir(dir);return {root,dir};}
function documentOf(assets:SequenceAsset[]):SequenceDocument{
  return {schemaVersion:2,id:'p',name:'p',revision:0,fps:{num:30,den:1},resolution:{width:32,height:32},sequenceEndFrame:1,background:'#000',assets,tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
}
async function touch(path:string){const later=new Date(Date.now()+5000);await utimes(path,later,later);}

it('returns a named issue instead of waiting forever when a linked source does not open, logs its path, and does not open it again',async()=>{
  const p=await project(),source=join(p.root,'撮影.wav');await writeFile(source,wav(1));
  const asset=await registerSequenceReference(p.dir,source,'撮影.wav');
  await rm(source);execFileSync('/usr/bin/mkfifo',[source]);fifos.push(source);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);exportPreflightTesting.unresponsiveMs=300;fsWatchTesting.reportMs=100;
  const started=Date.now(),result=await preflightSequenceExport(p.dir,documentOf([asset]));
  expect(Date.now()-started).toBeLessThan(3000);
  expect(result.issues).toEqual([{assetId:asset.id,name:'撮影.wav',message:'読み込みが応答しません（このMacのディスク）。ドライブの接続を確かめてください。'}]);
  expect(JSON.stringify(result)).not.toContain(p.root);
  // 診断: どのパスで止まったかが [sme] の記録に出る。
  const logged=warn.mock.calls.map(call=>call.join(' ')).filter(line=>line.startsWith('[sme]'));
  expect(logged.some(line=>line.includes(source)&&/秒/.test(line))).toBe(true);
  // 止まった open が戻らないうちの再確認は、同じパスを開き直さずにすぐ答える（作業用スレッドを積み重ねない）。
  const again=Date.now(),second=await preflightSequenceExport(p.dir,documentOf([asset]));
  expect(Date.now()-again).toBeLessThan(250);expect(second.issues[0]!.message).toContain('読み込みが応答しません');
  expect(fsWatchTesting.pending().filter(call=>call.path===source)).toHaveLength(1);
},10000);
it('stops at the first unresponsive source rather than spending the limit on every later one',async()=>{
  const p=await project(),stuck=join(p.root,'a.wav'),later=join(p.root,'b.wav');await writeFile(stuck,wav(1));await writeFile(later,wav(1));
  const assets=[await registerSequenceReference(p.dir,stuck,'a.wav'),await registerSequenceReference(p.dir,later,'b.wav')];
  await rm(stuck);execFileSync('/usr/bin/mkfifo',[stuck]);fifos.push(stuck);vi.spyOn(console,'warn').mockImplementation(()=>undefined);exportPreflightTesting.unresponsiveMs=300;
  const result=await preflightSequenceExport(p.dir,documentOf(assets));
  expect(result.issues.map(issue=>issue.name)).toEqual(['a.wav']);expect(result.checked).toBe(1);
},10000);
it('gives up on a managed copy whose content read stops making progress',async()=>{
  const p=await project(),source=join(p.root,'取り込み.wav');await writeFile(source,wav(3));
  const asset=await importSequenceAsset(p.dir,source,'取り込み.wav');await touch(join(p.dir,asset.file));
  vi.stubEnv('HARNESS_TEST_DIGEST_DELAY_MS','2000');vi.spyOn(console,'warn').mockImplementation(()=>undefined);exportPreflightTesting.unresponsiveMs=300;
  const started=Date.now(),result=await preflightSequenceExport(p.dir,documentOf([asset]));
  expect(Date.now()-started).toBeLessThan(1800);
  expect(result.issues).toEqual([{assetId:asset.id,name:'取り込み.wav',message:'読み込みが応答しません（このMacのディスク）。ドライブの接続を確かめてください。'}]);
},10000);
it('reports a linked source whose background check stalled with the same named reason',async()=>{
  const p=await project(),source=join(p.root,'カード.wav');await writeFile(source,wav(2));
  const asset=await registerSequenceReference(p.dir,source,'カード.wav');await touch(source);
  vi.stubEnv('HARNESS_TEST_DIGEST_DELAY_MS','2000');vi.spyOn(console,'warn').mockImplementation(()=>undefined);referenceVerificationTesting.stallMs=200;
  const result=await preflightSequenceExport(p.dir,documentOf([asset]));
  expect(result.issues).toEqual([{assetId:asset.id,name:'カード.wav',message:'読み込みが応答しません（このMacのディスク）。ドライブの接続を確かめてください。'}]);
},10000);
