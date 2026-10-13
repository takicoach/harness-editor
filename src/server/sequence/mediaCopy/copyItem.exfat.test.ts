// 使い捨ての exFAT イメージで1本のコピー（copyItem.ts）の実際の挙動を確かめる（重い任意実行: HARNESS_TEST_EXFAT=1。実在の SD カード・外付けは使わない）。
// exFAT の実測（Task 7 のレビュー）: 空のファイルは ino が共通の仮の値、初めて書いた時に先頭クラスタ番号になり rename では変わらない、付け直すとクラスタ番号が再び使われる、`._名前` の付随ファイルができる。
// mount・diskutil は自分が付けたイメージだけを対象にする（ownImagesIo）。イメージと元のファイルの置き場所は tmpdir()（実行時に TMPDIR で一時フォルダーへ向ける）。
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readdir,readFile,realpath,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {READ_ONLY,faultyIo,nodeCopyIo,type IoFault} from './io';
import {COPY_ROOT_NAME,ensureCopyFolder,listVolumes,type CopyFolder} from './volumes';
import {PART_SUFFIX,ReservationLostError,copyOneItem,removeOwnedCopyFiles,type CopyItemHooks,type OwnedCopyFiles} from './copyItem';
import {attachImage,createExfatImage,destroyExfatImage,detachImage,detachLeftoverImages,ownImagesIo,type ExfatImage} from './__fixtures__/exfatImage';
import {wav} from './__fixtures__/copyProject';

const enabled=process.env.HARNESS_TEST_EXFAT==='1'&&process.platform==='darwin';
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
describe.skipIf(!enabled)('copyOneItem on an exFAT disk image (real macOS behaviour)',()=>{
  const faults:IoFault[]=[],io=faultyIo(ownImagesIo(nodeCopyIo),faults),notes:Record<string,unknown>={};let image:ExfatImage|undefined,local='',count=0;
  beforeAll(async()=>{image=await createExfatImage();local=await mkdtemp(join(await realpath(tmpdir()),'copy-item-exfat-'));},120_000);
  afterAll(async()=>{
    const results=await Promise.allSettled([image?destroyExfatImage(image):undefined,rm(local,{recursive:true,force:true})]),sweep=await Promise.allSettled([detachLeftoverImages()]);
    console.log('[exfat-copy-item]',JSON.stringify(notes));const failed=[...results,...sweep].find(result=>result.status==='rejected');if(failed)throw failed.reason;
  },60_000);
  /** イメージの上に案件ごとのコピー先フォルダーを作る（ensureCopyFolder: ボリュームの識別を確かめて1段ずつ）。 */
  const imageFolder=async():Promise<CopyFolder>=>{const volume=(await listVolumes(io)).find(item=>item.mountPoint===image!.mountPoint)!;return ensureCopyFolder(io,volume,image!.mountPoint,[COPY_ROOT_NAME,`case-${++count}`]);};
  const localSource=async(name:string,mib:number,seed=0)=>{const path=join(local,`${++count}-${name}`);await writeFile(path,wav(mib,seed));return path;};
  /** 作業の記録の代わり（copyItem.test.ts と同じ）。記録した ino がどれも安全な整数かも覚える。 */
  const recorder=(signal=new AbortController().signal)=>{
    const owned:OwnedCopyFiles={},phases:string[]=[],unidentified:string[]=[];
    const hooks:CopyItemHooks={signal,progress:async()=>undefined,phase:async(phase,patch)=>{
      phases.push(`${phase}:${Object.keys(patch).sort().join(',')}`);
      for(const key of ['reserved','part','final'] as const){const value=patch[key];if(value&&value.ino!==undefined&&!Number.isSafeInteger(value.ino))unidentified.push(`${phase}:${key}:${value.ino}`);}
      for(const [key,value] of Object.entries(patch)){if(value===undefined)delete (owned as Record<string,unknown>)[key];else (owned as Record<string,unknown>)[key]=value;}}};
    return {owned,phases,unidentified,hooks};
  };
  /** `._` の付随ファイルを含めた一覧と、含めない一覧。 */
  const listing=async(folder:string)=>{const all=(await readdir(folder)).sort();return {all,main:all.filter(name=>!name.startsWith('._'))};};

  it('copies onto the image, records only real identities, and leaves only the named copy',async()=>{
    const folder=await imageFolder(),path=await localSource('clip.wav',8),run=recorder();
    const copied=await copyOneItem(io,{path},{folder,name:'clip.wav'},run.hooks);
    expect(copied).toMatchObject({path:join(folder.path,'clip.wav'),reused:false,fingerprint:await sha(path)});expect(await sha(copied.path)).toBe(await sha(path));
    const named=await lstat(copied.path);expect(run.owned.final).toEqual({dev:named.dev,ino:named.ino,size:named.size,mtimeMs:named.mtimeMs});
    expect(Number.isSafeInteger(copied.identity.ino)).toBe(true);expect(run.unidentified).toEqual([]);
    expect(run.phases).toEqual(['copying:finalName,reserved,reused,sourceIdentity','copying:reserved','copying:part','copying:part','verifying:fingerprint,part','named:final,part,reserved']);
    const {all,main}=await listing(folder.path);notes.afterCopy=all;expect(main).toEqual(['clip.wav']);expect(all.some(name=>name.includes(PART_SUFFIX))).toBe(false);
  },60_000);
  it('stops when the reservation is replaced by another empty file, and leaves that file (P0)',async()=>{
    const folder=await imageFolder(),path=await localSource('clip.wav',8),run=recorder(),final=join(folder.path,'clip.wav');
    // 空のファイル同士は ino が同じ仮の値になる。印の中身で自分の予約かを見分ける
    faults.push({op:'open',match:call=>call.path.endsWith(PART_SUFFIX)&&call.flags===READ_ONLY,before:async()=>{await unlink(final);await writeFile(final,'');}});
    try{await expect(copyOneItem(io,{path},{folder,name:'clip.wav'},run.hooks)).rejects.toBeInstanceOf(ReservationLostError);}finally{faults.length=0;}
    expect(io.calls.some(call=>call.op==='rename'&&call.path===final)).toBe(false);
    const cleaned=await removeOwnedCopyFiles(io,folder.path,run.owned);expect(cleaned).toEqual({removed:[run.owned.part!.name],kept:['clip.wav']});
    expect((await lstat(final)).size).toBe(0);expect((await listing(folder.path)).main).toEqual(['clip.wav']);expect(run.unidentified).toEqual([]);
  },60_000);
  it('when cancelled, removes only its own files and leaves nothing behind (including ._ files)',async()=>{
    const folder=await imageFolder(),path=await localSource('clip.wav',12),controller=new AbortController(),run=recorder(controller.signal);let writes=0;
    await expect(copyOneItem(io,{path},{folder,name:'clip.wav'},{...run.hooks,progress:async()=>{if(++writes===2)controller.abort();}})).rejects.toMatchObject({name:'AbortError'});
    notes.afterCancel=(await listing(folder.path)).all;
    const cleaned=await removeOwnedCopyFiles(io,folder.path,run.owned);expect(cleaned.kept).toEqual([]);expect(cleaned.removed.sort()).toEqual([run.owned.part!.name,'clip.wav'].sort());
    expect((await listing(folder.path)).all).toEqual([]);expect(run.unidentified).toEqual([]);
  },60_000);
  it('when adding, reuses an identical file and leaves no part behind',async()=>{
    const folder=await imageFolder(),path=await localSource('clip.wav',8),run=recorder();await writeFile(join(folder.path,'clip.wav'),await readFile(path));
    const copied=await copyOneItem(io,{path},{folder,name:'clip.wav'},run.hooks);
    expect(copied).toMatchObject({path:join(folder.path,'clip.wav'),reused:true});expect(run.owned).toMatchObject({finalName:'clip.wav',reused:true});
    const {all,main}=await listing(folder.path);notes.afterReuse=all;expect(main).toEqual(['clip.wav']);expect(all.some(name=>name.includes(PART_SUFFIX)||name==='clip (2).wav')).toBe(false);
  },60_000);
  it('copies from the image to a folder on this Mac',async()=>{
    const folder=await imageFolder(),source=join(folder.path,'card.wav');await writeFile(source,wav(8,5));
    const target=join(local,`to-mac-${++count}`);await mkdir(target);const info=await lstat(target),run=recorder();
    const copied=await copyOneItem(io,{path:source},{folder:{path:target,dev:info.dev,ino:info.ino},name:'card.wav'},run.hooks);
    expect(copied).toMatchObject({path:join(target,'card.wav'),reused:false});expect(await sha(copied.path)).toBe(await sha(source));
  },60_000);
  it('after detaching and attaching, the record still proves its own files (named copy, reservation and part)',async()=>{
    const named=await imageFolder(),staged=await imageFolder(),path=await localSource('clip.wav',8);
    // 1本は名前を確定した後（開き直しで）、もう1本は読み直しの途中で止める
    const first=recorder(),second=recorder();
    faults.push({op:'open',match:call=>call.path===join(named.path,'clip.wav')&&call.flags===READ_ONLY,nth:2,error:'EIO'});   // 1回目は rename の前の予約の印の確認
    try{await expect(copyOneItem(io,{path},{folder:named,name:'clip.wav'},first.hooks)).rejects.toMatchObject({code:'EIO'});}finally{faults.length=0;}
    faults.push({op:'read',match:call=>call.path.endsWith(PART_SUFFIX),error:'EIO'});
    try{await expect(copyOneItem(io,{path},{folder:staged,name:'clip.wav'},second.hooks)).rejects.toMatchObject({code:'EIO'});}finally{faults.length=0;}
    expect(first.owned.final).toBeDefined();expect(second.owned).toMatchObject({reserved:expect.any(Object),part:expect.any(Object)});
    const before=(await lstat(image!.mountPoint)).dev,mount=image!.mountPoint;
    await detachImage(mount);image!.mountPoint=await attachImage(image!.dmg);
    const after=(await lstat(image!.mountPoint)).dev,devOf=(dev:number)=>dev===before?after:dev,moved=(folder:CopyFolder)=>join(image!.mountPoint,folder.path.slice(mount.length));
    notes.remount={mountBefore:mount,mountAfter:image!.mountPoint,devBefore:before,devAfter:after,named:(await listing(moved(named))).all,staged:(await listing(moved(staged))).all};
    expect(await removeOwnedCopyFiles(io,moved(named),first.owned,devOf)).toEqual({removed:['clip.wav'],kept:[]});
    const cleaned=await removeOwnedCopyFiles(io,moved(staged),second.owned,devOf);expect(cleaned.kept).toEqual([]);expect(cleaned.removed.sort()).toEqual([second.owned.part!.name,'clip.wav'].sort());
    expect((await listing(moved(named))).all).toEqual([]);expect((await listing(moved(staged))).all).toEqual([]);
  },120_000);
});
