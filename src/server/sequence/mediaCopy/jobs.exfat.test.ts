// 使い捨ての exFAT イメージをコピー先にして、コピーの作業（jobs.ts）を実機の挙動で確かめる（重い任意実行: HARNESS_TEST_EXFAT=1。実在の SD カード・外付けは使わない）。
// 元の素材・案件は tmpdir()（実行時に TMPDIR で一時フォルダーへ向ける）。mount・diskutil は自分が付けたイメージだけを対象にする（ownImagesIo）。
// 300MB のイメージは安全余裕（20GB）を割るので、空きの値だけをイメージの分について大きく見せる（ファイル操作はすべて本物の exFAT）。
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import {CREATE_EXCLUSIVE,faultyIo,nodeCopyIo,type CopyIo,type IoFault} from './io';
import {COPY_ROOT_NAME,listVolumes} from './volumes';
import {GiB,SpaceReservations,safetyMargin} from './space';
import {PART_SUFFIX} from './copyItem';
import {readCopyJobRecords} from './jobRecord';
import {MediaCopyJobs,referenceCopyPorts} from './jobs';
import type {ChosenDestination} from './destinations';
import {referenceTarget,referenceVerificationTesting,registerSequenceReference} from '../references';
import {createExfatImage,destroyExfatImage,detachLeftoverImages,ownImagesIo,type ExfatImage} from './__fixtures__/exfatImage';
import {wav} from './__fixtures__/copyProject';

const enabled=process.env.HARNESS_TEST_EXFAT==='1'&&process.platform==='darwin';
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
describe.skipIf(!enabled)('copy jobs onto an exFAT disk image (real macOS behaviour)',()=>{
  const faults:IoFault[]=[],notes:Record<string,unknown>={};let image:ExfatImage|undefined,local='',io:CopyIo&{calls:unknown[]},count=0;
  /** イメージの分だけ空きを大きく見せる（容量 1000GiB・空き 900GiB）。 */
  const roomy=(base:CopyIo):CopyIo=>({...base,statfs:async path=>image&&(path===image.mountPoint||path.startsWith(`${image.mountPoint}/`))
    ?{bsize:4096,bavail:Math.floor(900*GiB/4096),blocks:Math.floor(1000*GiB/4096)}:base.statfs(path)});
  beforeAll(async()=>{image=await createExfatImage();local=await mkdtemp(join(await realpath(tmpdir()),'copy-jobs-exfat-'));io=faultyIo(roomy(ownImagesIo(nodeCopyIo)),faults);},120_000);
  afterEach(async()=>{faults.length=0;expect(referenceVerificationTesting.claims()).toBe(0);await referenceVerificationTesting.idle();referenceVerificationTesting.forget();});
  afterAll(async()=>{
    const results=await Promise.allSettled([image?destroyExfatImage(image):undefined,rm(local,{recursive:true,force:true})]),sweep=await Promise.allSettled([detachLeftoverImages()]);
    console.log('[exfat-copy-jobs]',JSON.stringify(notes));const failed=[...results,...sweep].find(result=>result.status==='rejected');if(failed)throw failed.reason;
  },60_000);
  /** このMac（一時フォルダー）の上の案件に、同じ場所の WAV をリンク素材として登録する。コピー先はイメージの上の案件ごとのフォルダー。 */
  async function project(names:string[]){
    const root=join(local,`case-${++count}`),sources:string[]=[],assets:SequenceAsset[]=[];await mkdir(root);
    for(const [index,name] of names.entries()){const path=join(root,name);await writeFile(path,wav(8,index+count));sources.push(path);assets.push(await registerSequenceReference(root,path));}
    const volume=(await listVolumes(io)).find(item=>item.mountPoint===image!.mountPoint)!,segments=[COPY_ROOT_NAME,`case-${count}`];
    const destination:ChosenDestination={key:`volume:${volume.uuid}`,kind:'volume',label:volume.label,volume,base:image!.mountPoint,segments,margin:safetyMargin(1000*GiB)};
    return {root,sources,assets,destination,folder:join(image!.mountPoint,...segments)};
  }
  /** `._` の付随ファイルを含めた一覧と、含めない一覧。 */
  const listing=async(folder:string)=>{const all=(await readdir(folder).catch(()=>[] as string[])).sort();return {all,main:all.filter(name=>!name.startsWith('._'))};};
  const make=()=>new MediaCopyJobs(()=>io,referenceCopyPorts,new SpaceReservations());
  const start=(jobs:MediaCopyJobs,job:Awaited<ReturnType<typeof project>>)=>jobs.startReconnect({root:job.root,projectId:'case',destination:job.destination,assets:job.assets});

  it('copies two linked files onto the image, reconnects them, and records only real identities',async()=>{
    const job=await project(['clip-1.wav','clip-2.wav']),jobs=make();await start(jobs,job);await jobs.idle();
    for(const [index,asset] of job.assets.entries()){const copy=join(job.folder,`clip-${index+1}.wav`);
      expect(await referenceTarget(job.root,asset.file)).toBe(copy);expect(await sha(copy)).toBe(await sha(job.sources[index]!));}
    const record=(await readCopyJobRecords(job.root))[0]!;expect(record).toMatchObject({state:'finished',items:[{phase:'done',connected:true},{phase:'done',connected:true}]});
    expect(record.items.every(item=>item.final&&Number.isSafeInteger(item.final.ino)&&!item.part&&!item.reserved)).toBe(true);
    const {all,main}=await listing(job.folder);notes.afterJob=all;expect(main).toEqual(['clip-1.wav','clip-2.wav']);expect(all.some(name=>name.includes(PART_SUFFIX))).toBe(false);
  },120_000);
  it('stops on a write failure mid-copy, removes its own files (with their ._ files) and keeps the links',async()=>{
    const job=await project(['clip-1.wav','clip-2.wav']);faults.push({op:'write',match:call=>call.path.endsWith(PART_SUFFIX),nth:2,error:'EIO'});
    const jobs=make();await start(jobs,job);await jobs.idle();
    expect((await jobs.list(job.root))[0]).toMatchObject({state:'stopped',items:[{phase:'failed',error:expect.stringContaining('EIO')},{phase:'cancelled'}]});
    for(const [index,asset] of job.assets.entries())expect(await referenceTarget(job.root,asset.file)).toBe(job.sources[index]);
    const {all}=await listing(job.folder);notes.afterFailure=all;expect(all).toEqual([]);
  },120_000);
  it.each([
    ['creating the part',(call:{path:string;flags?:number})=>call.path.endsWith(PART_SUFFIX)&&call.flags===CREATE_EXCLUSIVE],   // exFAT は先頭を書くまで .part を記録で見分けられない
    ['writing the part',(call:{op?:string;path:string})=>call.path.endsWith(PART_SUFFIX)],
  ] as const)('"残りを中止" while %s leaves nothing behind on the image',async(label,match)=>{
    const job=await project(['clip-1.wav','clip-2.wav']),jobs=make();
    faults.push({op:label==='creating the part'?'open':'write',match,nth:label==='creating the part'?1:2,before:async()=>{jobs.cancel(job.root,(await readCopyJobRecords(job.root))[0]!.jobId);}});
    await start(jobs,job);await jobs.idle();
    expect((await jobs.list(job.root))[0]).toMatchObject({state:'stopped',items:[{phase:'cancelled'},{phase:'cancelled'}]});
    for(const [index,asset] of job.assets.entries())expect(await referenceTarget(job.root,asset.file)).toBe(job.sources[index]);
    const {all}=await listing(job.folder);notes[`afterCancel:${label}`]=all;expect(all).toEqual([]);
  },120_000);
});
