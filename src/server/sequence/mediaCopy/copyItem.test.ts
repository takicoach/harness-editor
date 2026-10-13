import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,mkdir,open,readdir,readFile,rename,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {promisify} from 'node:util';
import {CREATE_EXCLUSIVE,READ_ONLY,WRITE_FLAGS,isSimulatedCrash,type IoCall,type IoFault} from './io';
import {COPY_ROOT_NAME,CopyFolderError,ensureCopyFolder,listVolumes,type CopyFolder} from './volumes';
import {MONITOR_MS,SpaceMonitor,SpaceReservations,SpaceStopError,safetyMargin} from './space';
import {CopySourceChangedError,CopyVerifyError,PART_SUFFIX,RESERVATION_MARK_BYTES,ReservationLostError,alternateName,copyOneItem,removeOwnedCopyFiles,type CopyItemHooks,type OwnedCopyFiles} from './copyItem';
import {MiB,copyWorld,type CopyWorld} from './__fixtures__/copyWorld';
import {wav} from './__fixtures__/copyProject';

let world:CopyWorld,folder:CopyFolder,owned:OwnedCopyFiles,phases:string[],unidentified:string[];
/** 試験の世界を作る。exfatEmptyInodes: 空のファイルの ino を exFAT と同じく共通の仮の値にする（実測: 初めて書いた時に本当の値になる）。 */
function useWorld(options:{exfatEmptyInodes?:boolean}={}){
  beforeEach(async()=>{world=await copyWorld(options);owned={};phases=[];unidentified=[];const ssd=(await listVolumes(world.io)).find(volume=>volume.uuid==='SSD')!;
    folder=await ensureCopyFolder(world.io,ssd,world.ssd,[COPY_ROOT_NAME,'案件-12345678']);});
  afterEach(async()=>{
    try{
      // 元の媒体（SD）には、どの試験でも読み取り専用で開く・読む・閉じる・調べる以外をしていない（作成・書き込み・同期・移動・削除・フォルダー作成なし）
      const onSource=(call:IoCall)=>[call.path,call.from].some(path=>path!==undefined&&(path===world.sd||path.startsWith(`${world.sd}/`)));
      expect(world.faulty.calls.filter(call=>onSource(call)&&!(call.op==='open'?call.flags===READ_ONLY:['read','close','stat','lstat','statfs','volumeDetails'].includes(call.op)))).toEqual([]);
      // 記録した実体の ino はどれも確かな数（exFAT の空のファイルの仮の値を記録しない。ジョブ記録の zod の int() は安全な整数しか通さない）
      expect(unidentified).toEqual([]);
    }finally{await world.cleanup();}
  });
}
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const source=async(name:string,mib:number,seed=0)=>{const path=join(world.sd,name);await writeFile(path,wav(mib,seed));return path;};
/** 作業の記録の代わり: 段と、作った実体（パッチ）を覚える。failAt 回目の段では、記録（メモリ）を変えてから「書けない」で投げる（jobs.ts の update と同じ順）。 */
const hooks=(signal=new AbortController().signal,failAt?:number):CopyItemHooks=>({signal,progress:async()=>undefined,phase:async(phase,patch)=>{
  phases.push(`${phase}:${Object.keys(patch).sort().join(',')}`);
  for(const key of ['reserved','part','final','sourceIdentity'] as const){const value=patch[key];if(value&&value.ino!==undefined&&!Number.isSafeInteger(value.ino))unidentified.push(`${phase}:${key}:${value.ino}`);}
  for(const [key,value] of Object.entries(patch)){if(value===undefined)delete (owned as Record<string,unknown>)[key];else (owned as Record<string,unknown>)[key]=value;}
  if(phases.length===failAt)throw Object.assign(new Error('記録を書けません（試験）'),{code:'EIO'});}});
const names=async()=>(await readdir(folder.path)).sort();
const sourceOpens=(path:string)=>world.faulty.calls.filter(call=>call.op==='open'&&call.path===path);
const isPart=(call:IoCall)=>call.path.endsWith(PART_SUFFIX);
const partReopen=(call:IoCall)=>call.op==='open'&&isPart(call)&&call.flags===READ_ONLY;
const errnoOf=(error:unknown)=>{const value=error as {code?:string;cause?:{code?:string}}|undefined;return value?.code??value?.cause?.code;};
/** 元のファイルの指紋と更新時刻を覚え、後で変わっていないことを確かめる。 */
const keep=async(path:string)=>({path,sha:await sha(path),mtimeMs:(await stat(path)).mtimeMs});
const untouched=async(saved:{path:string;sha:string;mtimeMs:number})=>{expect(await sha(saved.path)).toBe(saved.sha);expect((await stat(saved.path)).mtimeMs).toBe(saved.mtimeMs);};

describe.each([['APFS',false],['exFAT-like empty inodes',true]] as const)('on %s',(_label,exfatEmptyInodes)=>{
  useWorld({exfatEmptyInodes});
  it('copies, verifies the copy, names it, and never opens the original for writing',async()=>{
    const path=await source('clip.wav',9),before=await sha(path),mtime=(await stat(path)).mtimeMs;
    const copied=await copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks());
    expect(copied).toMatchObject({path:join(folder.path,'clip.wav'),fingerprint:before,reused:false});expect(await sha(copied.path)).toBe(before);
    const named=await stat(copied.path);expect(copied.identity).toMatchObject({ino:named.ino,size:(await stat(path)).size});
    expect(sourceOpens(path).length).toBeGreaterThan(0);expect(sourceOpens(path).every(call=>call.flags===READ_ONLY&&((call.flags??0)&WRITE_FLAGS)===0)).toBe(true);
    expect(await sha(path)).toBe(before);expect((await stat(path)).mtimeMs).toBe(mtime);expect(await names()).toEqual(['clip.wav']);
    // 予約の印は作る前に記録し（ino なし）、ino を確かめられた時に記録し直す。.part も同じ（名前を作る前に記録し、ino を確かめられた時に記録し直す）
    expect(phases).toEqual(['copying:finalName,reserved,reused,sourceIdentity','copying:reserved','copying:part','copying:part','verifying:fingerprint,part','named:final,part,reserved']);
    // 確定した実体は dev・ino に加えて大きさ・更新時刻で記録する（exFAT は付け直しで同じ番号が別のファイルに使われる）
    expect(owned.final).toEqual({dev:named.dev,ino:named.ino,size:named.size,mtimeMs:named.mtimeMs});
    // .part は fsync してから読み直し、予約の印を確かめてから rename し、rename の後にフォルダーを fsync する（設計 §5 の手順 4・5）
    const order=world.faulty.calls.filter(call=>call.op==='sync'&&(isPart(call)||call.path===folder.path)||partReopen(call)||call.op==='rename')
      .map(call=>`${call.op}:${call.path===folder.path?'folder':'part'}`);
    expect(order).toEqual(['sync:part','open:part','rename:part','sync:folder']);
  });
  it('reuses a finished copy with the same size and fingerprint without reading the original, and never deletes it',async()=>{
    const path=await source('clip.wav',9);await writeFile(join(folder.path,'clip.wav'),await readFile(path));const fingerprint=await sha(path);
    const copied=await copyOneItem(world.io,{path,expectedFingerprint:fingerprint},{folder,name:'clip.wav'},hooks());
    expect(copied).toMatchObject({path:join(folder.path,'clip.wav'),reused:true,fingerprint});expect(world.faulty.calls.some(call=>call.op==='read'&&call.path===path)).toBe(false);
    // 既にある名前を読み比べる前に、記録から予約を外す（比べる間に止まっても既存ファイルを自分の予約として扱わない）
    expect(phases).toEqual(['copying:finalName,reserved,reused,sourceIdentity','copying:reserved','named:finalName,reserved,reused,sourceIdentity']);expect(owned).toEqual({finalName:'clip.wav',reused:true});
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:[],kept:[]});expect(await names()).toEqual(['clip.wav']);
  });
  it('returns the name as it is on the disk when it reuses a file whose name differs only in case',async()=>{
    const path=await source('clip.wav',9);await writeFile(join(folder.path,'Clip.WAV'),await readFile(path));
    let caseInsensitive=true;try{await stat(join(folder.path,'clip.wav'));}catch{caseInsensitive=false;}
    const copied=await copyOneItem(world.io,{path,expectedFingerprint:await sha(path)},{folder,name:'clip.wav'},hooks());
    if(caseInsensitive){expect(copied).toMatchObject({path:join(folder.path,'Clip.WAV'),reused:true});expect(owned.finalName).toBe('Clip.WAV');expect(await names()).toEqual(['Clip.WAV']);}
    else expect(copied).toMatchObject({path:join(folder.path,'clip.wav'),reused:false});
  });
  it('takes the next name when a different file already has the name, and leaves that file alone',async()=>{
    const path=await source('clip.wav',9),foreign=join(folder.path,'clip.wav');await writeFile(foreign,wav(9,7));const theirs=await sha(foreign);
    await writeFile(join(folder.path,'clip (2).wav'),'short');
    const copied=await copyOneItem(world.io,{path,expectedFingerprint:await sha(path)},{folder,name:'clip.wav'},hooks());
    expect(copied.path).toBe(join(folder.path,'clip (3).wav'));expect(await sha(foreign)).toBe(theirs);expect(await readFile(join(folder.path,'clip (2).wav'),'utf8')).toBe('short');
  });
  it('when adding (no fingerprint yet), uses an identical file that already has the name and removes only its own files',async()=>{
    const path=await source('clip.wav',9);await writeFile(join(folder.path,'clip.wav'),await readFile(path));
    const copied=await copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks());
    expect(copied).toMatchObject({path:join(folder.path,'clip.wav'),reused:true,fingerprint:await sha(path)});expect(await names()).toEqual(['clip.wav']);
    expect(copied.sourceIdentity).toMatchObject({size:(await stat(path)).size});
    expect(phases).toEqual(['copying:finalName,reserved,reused,sourceIdentity','copying:reserved','copying:finalName,reserved,reused,sourceIdentity','copying:reserved','copying:part','copying:part','named:finalName,part,reserved,reused']);
    expect(owned).toMatchObject({finalName:'clip.wav',reused:true});expect(owned.reserved).toBeUndefined();
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:[],kept:[]});expect(await names()).toEqual(['clip.wav']);
  });
  it('when adding, keeps its own copy if the identical file changed after it was compared',async()=>{
    const path=await source('clip.wav',9),existing=join(folder.path,'clip.wav'),data=await readFile(path);await writeFile(existing,data);
    world.faults.push({op:'write',match:isPart,nth:1,before:async()=>{await new Promise(resolve=>setTimeout(resolve,5));await writeFile(existing,data);}});   // 同じ中身で書き直す（更新時刻が変わる）
    const copied=await copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks());
    expect(copied).toMatchObject({path:join(folder.path,'clip (2).wav'),reused:false});expect(await names()).toEqual(['clip (2).wav','clip.wav']);expect(await sha(existing)).toBe(await sha(path));
  });
  it('when adding, stops and keeps its files on the record if its own part cannot be confirmed before reusing',async()=>{
    const path=await source('clip.wav',9);await writeFile(join(folder.path,'clip.wav'),await readFile(path));
    world.faults.push({op:'lstat',match:isPart,nth:1,before:async call=>{await unlink(call.path);await writeFile(call.path,'theirs');}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopyVerifyError);
    expect(owned).toMatchObject({finalName:'clip (2).wav',reused:false});expect(owned.part).toBeDefined();
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:[],kept:[owned.part!.name]});
    expect(await readFile(join(folder.path,owned.part!.name),'utf8')).toBe('theirs');expect(await sha(join(folder.path,'clip.wav'))).toBe(await sha(path));
  });
  it.each([
    ['replaced by another file',async(final:string)=>{await unlink(final);await writeFile(final,'someone else');}],
    ['replaced by another empty file',async(final:string)=>{await unlink(final);await writeFile(final,'');}],
    ['given another mark of the same size',async(final:string)=>{const handle=await open(final,'r+');try{await handle.write(Buffer.alloc(RESERVATION_MARK_BYTES,0x41),0,RESERVATION_MARK_BYTES,0);}finally{await handle.close();}}],
    ['written into by someone else',async(final:string)=>{await appendFile(final,'someone else');}],
    ['replaced by a link',async(final:string)=>{await writeFile(join(world.root,'elsewhere.txt'),'someone else');await unlink(final);await symlink(join(world.root,'elsewhere.txt'),final);}],
    ['replaced by a folder',async(final:string)=>{await unlink(final);await mkdir(final);}],
    ['removed',async(final:string)=>{await unlink(final);}],
  ] as const)('stops when the reserved name was %s during the copy, and never touches what is there now (P0)',async(label,replace)=>{
    const path=await source('clip.wav',9),final=join(folder.path,'clip.wav'),original=await keep(path);let after:Buffer|undefined;
    // 置き換えた直後の中身（リンクは先の中身）を覚え、止まった後・片付けの後も同じであることを確かめる
    world.faults.push({op:'open',match:partReopen,before:async()=>{await replace(final);after=await readFile(final).catch(()=>undefined);}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(ReservationLostError);
    expect(world.faulty.calls.some(call=>call.op==='rename')).toBe(false);
    const cleaned=await removeOwnedCopyFiles(world.io,folder.path,owned);expect(cleaned.removed).toEqual([owned.part!.name]);
    if(label==='removed'){expect(cleaned.kept).toEqual([]);expect(await names()).toEqual([]);}
    else{expect(cleaned.kept).toEqual(['clip.wav']);expect(await names()).toEqual(['clip.wav']);}
    if(after)expect(await readFile(final)).toEqual(after);
    expect(world.faulty.calls.filter(call=>call.op==='unlink').map(call=>call.path)).toEqual([join(folder.path,owned.part!.name)]);
    await untouched(original);
  });
  it('does not hang when the reservation is replaced by a FIFO, and stops with ReservationLostError',async()=>{
    const path=await source('clip.wav',9),final=join(folder.path,'clip.wav');
    world.faults.push({op:'open',match:partReopen,before:async()=>{await unlink(final);await promisify(execFile)('/usr/bin/mkfifo',[final]);}});
    const run=copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks()).then(()=>'copied',(error:unknown)=>error);
    const outcome=await Promise.race([run,new Promise(resolve=>setTimeout(()=>resolve('hung'),2000))]);
    // 固まった時は書き手として開いて読み手を放す（残りの試験を道連れにしない）
    if(outcome==='hung'){const writer=await open(final,constants.O_WRONLY|constants.O_NONBLOCK).catch(()=>undefined);await writer?.close();await run;}
    expect(outcome).toBeInstanceOf(ReservationLostError);
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:[owned.part!.name],kept:['clip.wav']});expect((await stat(final)).isFIFO()).toBe(true);
  });
  it('records the name only after the folder is synced, so a lost rename still leaves its part and reservation on the record',async()=>{
    const path=await source('clip.wav',9);let atSync:OwnedCopyFiles|undefined;
    world.faults.push({op:'sync',match:call=>call.path===folder.path,before:()=>{atSync=structuredClone(owned);},error:'EIO'});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toMatchObject({code:'EIO'});
    expect(atSync).toMatchObject({finalName:'clip.wav',reserved:expect.any(Object),part:expect.any(Object)});expect(atSync!.final).toBeUndefined();
    expect(owned.final).toBeUndefined();expect(owned.part).toBeDefined();expect(owned.reserved).toBeDefined();
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:['clip.wav'],kept:[]});expect(await names()).toEqual([]);
  });
  it('writes only the first few kilobytes of the part before recording it',async()=>{
    const path=await source('clip.wav',9);let first:number|undefined;
    world.faults.push({op:'write',match:isPart,nth:1,before:call=>{first=call.bytes;}});
    await copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks());expect(first).toBeLessThanOrEqual(4096);
  });
  it('stops before naming when the copy folder was replaced, and writes nothing into the new folder',async()=>{
    const path=await source('clip.wav',9);
    world.faults.push({op:'lstat',match:call=>call.path===folder.path,nth:2,before:async()=>{await rename(folder.path,`${folder.path}-moved`);await mkdir(folder.path);}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopyFolderError);
    expect(await names()).toEqual([]);expect(world.faulty.calls.some(call=>call.op==='rename')).toBe(false);
    expect((await readdir(`${folder.path}-moved`)).sort()).toEqual(['clip.wav',owned.part!.name].sort());
  });
  it('stops before naming when its part was replaced after the check, and never renames',async()=>{
    const path=await source('clip.wav',9);
    world.faults.push({op:'lstat',match:isPart,nth:1,before:async call=>{const data=await readFile(call.path);await unlink(call.path);await writeFile(call.path,data);}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopyVerifyError);
    expect(world.faulty.calls.some(call=>call.op==='rename')).toBe(false);
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:['clip.wav'],kept:[owned.part!.name]});
  });
  it('stops when the final name is not its own file right after the rename, and never removes what is there',async()=>{
    const path=await source('clip.wav',9),final=join(folder.path,'clip.wav');
    world.faults.push({op:'lstat',match:call=>call.path===final,nth:1,before:async()=>{await unlink(final);await writeFile(final,'someone else');}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(ReservationLostError);
    expect(owned.final).toBeUndefined();
    expect(await removeOwnedCopyFiles(world.io,folder.path,owned)).toEqual({removed:[],kept:['clip.wav']});expect(await readFile(final,'utf8')).toBe('someone else');
  });
  it('stops when the original changes during the copy; cleaning removes only its own part and reservation',async()=>{
    const path=await source('clip.wav',9);world.faults.push({op:'read',match:call=>call.path===path,nth:2,before:()=>appendFile(path,'x')});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopySourceChangedError);
    expect((await removeOwnedCopyFiles(world.io,folder.path,owned)).removed.sort()).toEqual([owned.part!.name,'clip.wav'].sort());expect(await names()).toEqual([]);
  });
  it('stops when the original path is swapped for another file of the same size during the copy',async()=>{
    const path=await source('clip.wav',9);
    world.faults.push({op:'read',match:call=>call.path===path,nth:2,before:async()=>{await writeFile(`${path}.other`,wav(9,3));await rename(`${path}.other`,path);}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopySourceChangedError);
    await removeOwnedCopyFiles(world.io,folder.path,owned);expect(await names()).toEqual([]);
  });
  it('stops before creating anything when the original path points to another file right after opening',async()=>{
    const path=await source('clip.wav',9);
    world.faults.push({op:'stat',match:call=>call.path===path,nth:1,before:async()=>{await writeFile(`${path}.other`,wav(9,3));await rename(`${path}.other`,path);}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopySourceChangedError);
    expect(await names()).toEqual([]);expect(phases).toEqual([]);
  });
  it('refuses an original reached through a linked folder (not its real path) before creating anything',async()=>{
    await source('clip.wav',1);const linked=join(world.root,'sd-link');await symlink(world.sd,linked);
    await expect(copyOneItem(world.io,{path:join(linked,'clip.wav')},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopySourceChangedError);
    expect(await names()).toEqual([]);expect(phases).toEqual([]);
  });
  it('refuses an empty original before creating anything',async()=>{
    const path=join(world.sd,'empty.wav');await writeFile(path,'');
    await expect(copyOneItem(world.io,{path},{folder,name:'empty.wav'},hooks())).rejects.toBeInstanceOf(CopySourceChangedError);
    expect(await names()).toEqual([]);expect(phases).toEqual([]);
  });
  it('stops on a fingerprint that differs from the asset record',async()=>{
    const path=await source('clip.wav',9);
    await expect(copyOneItem(world.io,{path,expectedFingerprint:'f'.repeat(64)},{folder,name:'clip.wav'},hooks())).rejects.toThrow(new CopySourceChangedError('元の素材の中身が登録時と一致しません'));
    expect(phases.some(phase=>phase.startsWith('verifying'))).toBe(false);await removeOwnedCopyFiles(world.io,folder.path,owned);expect(await names()).toEqual([]);
  });
  it('says the content differs from the one chosen when the expectation comes from the screen (an added copy)',async()=>{
    const path=await source('clip.wav',9);
    await expect(copyOneItem(world.io,{path,expectedFingerprint:'f'.repeat(64),expectedFrom:'chosen'},{folder,name:'clip.wav'},hooks())).rejects.toThrow(new CopySourceChangedError('選んだ時の素材と中身が一致しません'));
    await removeOwnedCopyFiles(world.io,folder.path,owned);expect(await names()).toEqual([]);
  });
  it('stops when the re-read copy differs',async()=>{
    const path=await source('clip.wav',9);
    world.faults.push({op:'open',match:partReopen,before:async call=>{const handle=await open(call.path,'r+');try{await handle.write(Buffer.from([0xff]),0,1,100);}finally{await handle.close();}}});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toBeInstanceOf(CopyVerifyError);
    await removeOwnedCopyFiles(world.io,folder.path,owned);expect(await names()).toEqual([]);
  });
  it.each([['write','ENOSPC'],['sync','EIO'],['rename','EIO']] as const)('fails on %s (%s) without naming the copy',async(op,error)=>{
    const path=await source('clip.wav',9);world.faults.push({op,error,...(op==='rename'?{}:{match:isPart}),...(op==='write'?{nth:2}:{})});
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},hooks())).rejects.toMatchObject({code:error});
    await removeOwnedCopyFiles(world.io,folder.path,owned);expect(await names()).toEqual([]);
  });
  it('stops through the space monitor while writing when the destination fills up, and names nothing',async()=>{
    const path=await source('clip.wav',9),original=await keep(path),size=(await stat(path)).size,ssd=world.io.volumes.find(volume=>volume.uuid==='SSD')!,margin=safetyMargin(ssd.capacity);
    const reservations=new SpaceReservations(),mine=reservations.reserve('volume:SSD',size),monitor=new SpaceMonitor(world.io,folder.path,mine,reservations,margin);
    let written=0;const base=hooks();
    // 1本目の書き込みの後に他のアプリが書き込んで空きが減り、5 秒が経った（監視の測る時）
    const progress=async(bytes:number)=>{written+=bytes;ssd.free=margin+MiB;world.clock.advance(MONITOR_MS);await monitor.wrote(bytes,size-written);};
    await expect(copyOneItem(world.io,{path},{folder,name:'clip.wav'},{...base,progress})).rejects.toBeInstanceOf(SpaceStopError);
    expect(world.faulty.calls.filter(call=>call.op==='statfs'&&call.path===folder.path)).toHaveLength(1);expect(world.faulty.calls.filter(call=>call.op==='write'&&isPart(call)).reduce((sum,call)=>sum+(call.bytes??0),0)).toBe(4*MiB);
    expect(phases.some(phase=>phase.startsWith('verifying'))).toBe(false);
    await removeOwnedCopyFiles(world.io,folder.path,owned);expect(await names()).toEqual([]);await untouched(original);
  });
  it('refuses an original that is a link',async()=>{
    const path=await source('clip.wav',1),link=join(world.sd,'link.wav');await symlink(path,link);
    await expect(copyOneItem(world.io,{path:link},{folder,name:'clip.wav'},hooks())).rejects.toMatchObject({code:'ELOOP'});
    expect(await names()).toEqual([]);
  });

  describe('failures at each step',()=>{
    /** 失敗の試験の場: コピー先に他人のファイル（同じ名前・同じ大きさの別の中身、他人の .harness-part、メモ）がある。自分のコピーは「clip (2).wav」になる。 */
    interface Scene {src:string;foreign:string;final:string;theirs:Map<string,string>;original:{path:string;sha:string;mtimeMs:number}}
    async function crowded():Promise<Scene>{
      const src=await source('clip.wav',9),foreign=join(folder.path,'clip.wav');
      await writeFile(foreign,wav(9,7));await writeFile(join(folder.path,`clip.wav.0123456789abcdef${PART_SUFFIX}`),'not ours');await writeFile(join(folder.path,'notes.txt'),'memo');
      const theirs=new Map<string,string>();for(const name of await names())theirs.set(name,await sha(join(folder.path,name)));
      return {src,foreign,final:join(folder.path,'clip (2).wav'),theirs,original:await keep(src)};
    }
    /**
     * 合否: 残っているのは他人のファイルだけで中身も同じ、元のファイルの指紋・更新時刻が同じ、他人のファイルを書き込み・移動・削除の対象にしていない。
     * leftover: exFAT で自分のものと確かめられないまま止まった空の実体（印を書く前の予約・初めて書く前の .part。既知の窓）だけは残ってよい。
     */
    async function assertProtected(scene:Scene,leftover?:'reservation'|'part'){
      const left=(await names()).filter(name=>!scene.theirs.has(name));
      expect(left).toEqual(leftover==='reservation'?['clip (2).wav']:leftover==='part'?[expect.stringMatching(/^clip \(2\)\.wav\.[a-f0-9]{16}\.harness-part$/)]:[]);
      for(const name of left)expect((await stat(join(folder.path,name))).size).toBe(0);
      for(const [name,digest] of scene.theirs)expect(await sha(join(folder.path,name))).toBe(digest);
      await untouched(scene.original);
      const theirPaths=new Set([...scene.theirs.keys()].map(name=>join(folder.path,name)));
      expect(world.faulty.calls.filter(call=>(call.op==='unlink'||call.op==='rename')&&(theirPaths.has(call.path)||theirPaths.has(call.from??''))
        ||call.op==='open'&&theirPaths.has(call.path)&&call.flags!==READ_ONLY&&call.flags!==CREATE_EXCLUSIVE)).toEqual([]);
    }
    const atFolder=(call:IoCall)=>call.path===folder.path;
    /** [段, 注入する呼び出し, exFAT で自分のものと確かめられずに残るもの（既知の窓）] */
    const steps:Array<[string,(scene:Scene)=>Omit<IoFault,'error'|'crash'>,('reservation'|'part')?]>=[
      ['opening the original',scene=>({op:'open',match:call=>call.path===scene.src})],
      ['checking where the original is',scene=>({op:'stat',match:call=>call.path===scene.src,nth:1})],
      ['comparing the file that has the name',scene=>({op:'read',match:call=>call.path===scene.foreign})],
      ['reserving the name',scene=>({op:'open',match:call=>call.path===scene.final&&call.flags===CREATE_EXCLUSIVE})],
      ['writing the reservation mark (right after creating it)',scene=>({op:'write',match:call=>call.path===scene.final}),'reservation'],
      ['syncing the reservation mark',scene=>({op:'sync',match:call=>call.path===scene.final})],
      ['closing the reservation',scene=>({op:'close',match:call=>call.path===scene.final,nth:1})],
      ['checking the folder after reserving',()=>({op:'lstat',match:atFolder,nth:1})],
      ['creating the part',()=>({op:'open',match:call=>isPart(call)&&call.flags===CREATE_EXCLUSIVE})],
      ['reading the original',scene=>({op:'read',match:call=>call.path===scene.src,nth:2})],
      ['writing the first bytes of the part',()=>({op:'write',match:isPart,nth:1}),'part'],
      ['writing the rest of the first chunk (right after the first bytes)',()=>({op:'write',match:isPart,nth:2})],
      ['writing the part',()=>({op:'write',match:isPart,nth:3})],
      ['checking the original after reading',scene=>({op:'stat',match:call=>call.path===scene.src,nth:2})],
      ['syncing the part',()=>({op:'sync',match:isPart})],
      ['closing the part',()=>({op:'close',match:isPart,nth:1})],
      ['closing the original',scene=>({op:'close',match:call=>call.path===scene.src})],
      ['reopening the part to verify',()=>({op:'open',match:partReopen})],
      ['reading the part back',()=>({op:'read',match:isPart})],
      ['checking the folder before naming',()=>({op:'lstat',match:atFolder,nth:2})],
      ['opening the reservation to check its mark',scene=>({op:'open',match:call=>call.path===scene.final&&call.flags===READ_ONLY,nth:1})],
      ['reading the reservation mark',scene=>({op:'read',match:call=>call.path===scene.final})],
      ['checking the part before naming',()=>({op:'lstat',match:isPart})],
      ['renaming',()=>({op:'rename'})],
      ['checking the name after renaming',scene=>({op:'lstat',match:call=>call.path===scene.final,nth:1})],
      ['opening the folder to sync it',()=>({op:'open',match:call=>atFolder(call)&&call.flags===READ_ONLY})],
      ['syncing the folder',()=>({op:'sync',match:atFolder})],
      ['opening the named copy',scene=>({op:'open',match:call=>call.path===scene.final&&call.flags===READ_ONLY,nth:2})],
    ];
    describe.each([['an error','error'],['a crash','crash']] as const)('with %s',(_kind,kind)=>{
      it.each(steps)('when %s, removes only its own files by the record and leaves everything else as it was',async(_step,make,window)=>{
        const scene=await crowded();world.faults.push({...make(scene),...(kind==='crash'?{crash:true}:{error:'EIO'})});
        const failure=await copyOneItem(world.io,{path:scene.src},{folder,name:'clip.wav'},hooks()).then(()=>undefined,(error:unknown)=>error);
        if(kind==='crash')expect(isSimulatedCrash(failure)).toBe(true);else expect(errnoOf(failure)).toBe('EIO');
        // 片付け（強制終了なら次の起動の回収）は記録だけに従う
        world.faults.length=0;const cleaned=await removeOwnedCopyFiles(world.io,folder.path,owned);
        await assertProtected(scene,exfatEmptyInodes?window:undefined);
        // 消さずに残した自分の実体（exFAT の既知の窓の空の予約・空の .part）は、どれも記録から名前が分かり、残したものとして報告される
        expect(cleaned.kept.sort()).toEqual((await names()).filter(name=>!scene.theirs.has(name)).sort());
      });
    });
    // 他人のファイルが混ざった場面で記録を書く段は8つ（Task 16 で .part の名前の段が増えた）。全段を通す
    it.each([1,2,3,4,5,6,7,8])('when the record cannot be written at phase %i, stops and its own files can still be removed',async nth=>{
      const scene=await crowded();
      await expect(copyOneItem(world.io,{path:scene.src},{folder,name:'clip.wav'},hooks(undefined,nth))).rejects.toThrow('記録を書けません');
      expect(phases).toHaveLength(nth);await removeOwnedCopyFiles(world.io,folder.path,owned);await assertProtected(scene);
    });
    it.each(['copying','verifying'] as const)('stops when cancelled while %s and removes only its own files',async when=>{
      const scene=await crowded(),controller=new AbortController(),base=hooks(controller.signal);
      if(when==='verifying')world.faults.push({op:'open',match:partReopen,before:()=>controller.abort()});
      const progress=when==='copying'?async()=>{controller.abort();}:base.progress;
      await expect(copyOneItem(world.io,{path:scene.src},{folder,name:'clip.wav'},{...base,progress})).rejects.toMatchObject({name:'AbortError'});
      expect(world.faulty.calls.some(call=>call.op==='rename')).toBe(false);await removeOwnedCopyFiles(world.io,folder.path,owned);await assertProtected(scene);
    });
  });
});

describe('removeOwnedCopyFiles',()=>{
  useWorld();
  const make=async(name:string,data:string|Buffer)=>{const path=join(folder.path,name);await writeFile(path,data);const info=await stat(path);return {dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs};};
  const partName=`a.wav.0000000000000000${PART_SUFFIX}`,mark=Buffer.alloc(RESERVATION_MARK_BYTES,0x5a),token=mark.toString('hex');
  const reservation=async(name:string,data:string|Buffer=mark)=>{const {dev,ino}=await make(name,data);return {dev,ino,token};};
  it('removes its own part and its reservation (with its mark, or still empty)',async()=>{
    const {dev,ino}=await make(partName,'partial'),part={name:partName,dev,ino},reserved=await reservation('a.wav'),empty=await reservation('b.wav','');
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',reserved,part})).toEqual({removed:[partName,'a.wav'],kept:[]});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'b.wav',reserved:empty})).toEqual({removed:['b.wav'],kept:[]});expect(await names()).toEqual([]);
  });
  it('judges a reservation recorded before it was created (no inode) by its name, size and mark only',async()=>{
    await writeFile(join(folder.path,'a.wav'),mark);await writeFile(join(folder.path,'b.wav'),'');await writeFile(join(folder.path,'c.wav'),Buffer.alloc(RESERVATION_MARK_BYTES,0x41));
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',reserved:{token}})).toEqual({removed:['a.wav'],kept:[]});
    // 印を書く前の空のファイルは ino が無いと自分のものと確かめられない（exFAT の窓）。印の違うものも消さない
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'b.wav',reserved:{token}})).toEqual({removed:[],kept:['b.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'c.wav',reserved:{token}})).toEqual({removed:[],kept:['c.wav']});
    expect(await names()).toEqual(['b.wav','c.wav']);
  });
  it('keeps a reservation whose mark differs or that has more data, files with another inode, and links',async()=>{
    const reserved=await reservation('a.wav');await writeFile(join(folder.path,'a.wav'),Buffer.alloc(RESERVATION_MARK_BYTES,0x41));
    const longer=await reservation('c.wav');await appendFile(join(folder.path,'c.wav'),'more');
    const {dev,ino}=await make(partName,'partial');await unlink(join(folder.path,partName));await writeFile(join(folder.path,partName),'theirs');
    await writeFile(join(folder.path,'target.txt'),'x');const final=await make('b.wav','mine');await unlink(join(folder.path,'b.wav'));await symlink(join(folder.path,'target.txt'),join(folder.path,'b.wav'));
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',reserved,part:{name:partName,dev,ino}})).toEqual({removed:[],kept:[partName,'a.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'c.wav',reserved:longer})).toEqual({removed:[],kept:['c.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'b.wav',final})).toEqual({removed:[],kept:['b.wav']});
    expect(await readFile(join(folder.path,'a.wav'),'utf8')).toBe('A'.repeat(RESERVATION_MARK_BYTES));expect(await readFile(join(folder.path,partName),'utf8')).toBe('theirs');expect(await readFile(join(folder.path,'target.txt'),'utf8')).toBe('x');
  });
  it('keeps a final file whose size or modified time differs from the record (a reused number on exFAT)',async()=>{
    const final=await make('a.wav','done');
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final:{...final,size:final.size+1}})).toEqual({removed:[],kept:['a.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final:{...final,mtimeMs:final.mtimeMs-1000}})).toEqual({removed:[],kept:['a.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final})).toEqual({removed:['a.wav'],kept:[]});
  });
  it('never touches a reused or connected copy',async()=>{
    const final=await make('a.wav','done');
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final,reused:true})).toEqual({removed:[],kept:[]});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final,connected:true})).toEqual({removed:[],kept:[]});
    expect(await names()).toEqual(['a.wav']);expect(world.faulty.calls.some(call=>call.op==='unlink')).toBe(false);
  });
  it('removes its own verified part that was already renamed to the final name (stopped between the rename and the record)',async()=>{
    const reserved=await reservation('a.wav'),part={name:partName,...await make(partName,'copied')};await rename(join(folder.path,partName),join(folder.path,'a.wav'));
    // 読み直す前の .part（大きさ・時刻を記録していない）は rename されていないので、完成名の照合には使わない
    const {size:_size,mtimeMs:_mtime,...unverified}=part;
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',reserved,part:unverified})).toEqual({removed:[],kept:['a.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',reserved,part})).toEqual({removed:['a.wav'],kept:[]});expect(await names()).toEqual([]);
  });
  it('reads the recorded dev through devOf (the drive was mounted again)',async()=>{
    const final=await make('a.wav','done'),moved={...final,dev:final.dev+1000};
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final:moved})).toEqual({removed:[],kept:['a.wav']});
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'a.wav',final:moved},dev=>dev-1000)).toEqual({removed:['a.wav'],kept:[]});
  });
  it('refuses recorded names that leave the folder, and skips files that are gone',async()=>{
    const outside=join(folder.path,'..','x.wav');await writeFile(outside,'outside');const info=await stat(outside),final={dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs};
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'../x.wav',final})).toEqual({removed:[],kept:['../x.wav']});
    expect(await readFile(outside,'utf8')).toBe('outside');
    expect(await removeOwnedCopyFiles(world.io,folder.path,{finalName:'gone.wav',final,part:{name:partName,dev:info.dev,ino:1}})).toEqual({removed:[],kept:[]});
    expect(world.faulty.calls.some(call=>call.op==='unlink')).toBe(false);
  });
});
describe('names',()=>{
  useWorld();
  it('alternateName numbers the name before the extension',()=>{
    expect(alternateName('clip.wav',1)).toBe('clip.wav');expect(alternateName('clip.wav',2)).toBe('clip (2).wav');expect(alternateName('a.b.MP4',3)).toBe('a.b (3).MP4');expect(alternateName('clip',2)).toBe('clip (2)');
  });
  it('keeps a long name within 255 bytes in the part name',async()=>{
    const name=`${'あ'.repeat(82)}.wav`,path=await source(name,1);expect(Buffer.byteLength(name)).toBe(250);
    const copied=await copyOneItem(world.io,{path},{folder,name},hooks());expect(copied.path).toBe(join(folder.path,name));
    const created=world.faulty.calls.find(call=>call.op==='open'&&isPart(call)&&call.flags===CREATE_EXCLUSIVE)!;expect(Buffer.byteLength(created.path.slice(folder.path.length+1))).toBeLessThanOrEqual(255);
  });
});
describe('two processes',()=>{
  useWorld();
  it('race for the same final name: both finish under different names, nothing overwritten',async()=>{
    const a=await source('a.wav',16,1),b=await source('b.wav',16,2),script=fileURLToPath(new URL('./__fixtures__/copyRace.ts',import.meta.url)),cwd=fileURLToPath(new URL('../../../..',import.meta.url));
    interface Raced {path:string;fingerprint:string;reused:boolean;startedAt:number;endedAt:number}
    const runOne=(path:string)=>{
      let out='',err='',ready!:()=>void;const child=spawn(process.execPath,['--import','tsx',script,path,folder.path,String(folder.dev),String(folder.ino)],{cwd,stdio:['pipe','pipe','pipe']});
      const started=new Promise<void>(resolve=>{ready=resolve;});child.stdout.setEncoding('utf8').on('data',chunk=>{out+=chunk;if(out.startsWith('ready\n'))ready();});child.stderr.on('data',chunk=>{err+=chunk;});
      const done=new Promise<Raced>((resolve,reject)=>child.once('close',code=>{ready();code===0?resolve(JSON.parse(out.slice('ready\n'.length))):reject(new Error(err||`終了コード ${code}`));}));
      return {started,done,go:()=>child.stdin.end('go\n')};
    };
    const children=[runOne(a),runOne(b)];await Promise.all(children.map(child=>child.started));for(const child of children)child.go();
    const results=await Promise.all(children.map(child=>child.done));
    // 2つのコピーの期間が実際に重なっていた（取り合いが起きた）ことを先に確かめる
    expect(Math.max(...results.map(result=>result.startedAt))).toBeLessThan(Math.min(...results.map(result=>result.endedAt)));
    expect(results.map(result=>result.path).sort()).toEqual([join(folder.path,'clip (2).wav'),join(folder.path,'clip.wav')]);expect(results.every(result=>!result.reused)).toBe(true);
    for(const [index,path] of [a,b].entries())expect(await sha(results[index]!.path)).toBe(await sha(path));
    expect(await names()).toEqual(['clip (2).wav','clip.wav']);
  },30_000);
});
