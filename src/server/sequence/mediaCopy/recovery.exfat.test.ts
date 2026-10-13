// 使い捨ての exFAT イメージをコピー先にして、起動時の回収（recovery.ts）を実機の挙動で確かめる（重い任意実行: HARNESS_TEST_EXFAT=1。実在の SD カード・外付けは使わない）。
// 元の素材・案件は tmpdir()（実行時に TMPDIR で一時フォルダーへ向ける）。mount・diskutil は自分が付けたイメージだけを対象にする（ownImagesIo）。
// 300MB のイメージは安全余裕（20GB）を割るので、空きの値だけをイメージの分について大きく見せる（ファイル操作はすべて本物の exFAT）。
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import {faultyIo,nodeCopyIo,type CopyIo,type IoCall,type IoFault} from './io';
import {COPY_ROOT_NAME,listVolumes} from './volumes';
import {GiB,SpaceReservations,safetyMargin} from './space';
import {PART_SUFFIX} from './copyItem';
import {readCopyJobRecords} from './jobRecord';
import {MediaCopyJobs,referenceCopyPorts} from './jobs';
import type {ChosenDestination} from './destinations';
import {referenceTarget,referenceVerificationTesting,registerSequenceReference} from '../references';
import {attachImage,createExfatImage,destroyExfatImage,detachImage,detachLeftoverImages,ownImagesIo,type ExfatImage} from './__fixtures__/exfatImage';
import {wav} from './__fixtures__/copyProject';

const enabled=process.env.HARNESS_TEST_EXFAT==='1'&&process.platform==='darwin';
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const FOREIGN='foreign.wav.0123456789abcdef.harness-part';
describe.skipIf(!enabled)('recovering copy jobs on an exFAT disk image (real macOS behaviour)',()=>{
  const faults:IoFault[]=[],notes:Record<string,unknown>={};let image:ExfatImage|undefined,other:ExfatImage|undefined,local='',io:CopyIo&{calls:IoCall[]},count=0;
  /** イメージの分だけ空きを大きく見せる（容量 1000GiB・空き 900GiB）。 */
  const roomy=(base:CopyIo):CopyIo=>({...base,statfs:async path=>image&&(path===image.mountPoint||path.startsWith(`${image.mountPoint}/`))
    ?{bsize:4096,bavail:Math.floor(900*GiB/4096),blocks:Math.floor(1000*GiB/4096)}:base.statfs(path)});
  beforeAll(async()=>{image=await createExfatImage();local=await mkdtemp(join(await realpath(tmpdir()),'copy-recovery-exfat-'));io=faultyIo(roomy(ownImagesIo(nodeCopyIo)),faults);},120_000);
  afterEach(async()=>{faults.length=0;expect(referenceVerificationTesting.claims()).toBe(0);await referenceVerificationTesting.idle();referenceVerificationTesting.forget();});
  afterAll(async()=>{
    const results=await Promise.allSettled([image?destroyExfatImage(image):undefined,other?destroyExfatImage(other):undefined,rm(local,{recursive:true,force:true})]);
    const sweep=await Promise.allSettled([detachLeftoverImages()]);
    console.log('[exfat-recovery]',JSON.stringify(notes));const failed=[...results,...sweep].find(result=>result.status==='rejected');if(failed)throw failed.reason;
  },60_000);
  /** このMac（一時フォルダー）の上の案件に、同じ場所の WAV をリンク素材として登録する。コピー先はイメージの上の案件ごとのフォルダー。 */
  async function project(names:string[]){
    const root=join(local,`case-${++count}`),sources:string[]=[],assets:SequenceAsset[]=[];await mkdir(root);
    for(const [index,name] of names.entries()){const path=join(root,name);await writeFile(path,wav(8,index+count));sources.push(path);assets.push(await registerSequenceReference(root,path));}
    const volume=(await listVolumes(io)).find(item=>item.mountPoint===image!.mountPoint)!,segments=[COPY_ROOT_NAME,`case-${count}`];
    const destination:ChosenDestination={key:`volume:${volume.uuid}`,kind:'volume',label:volume.label,volume,base:image!.mountPoint,segments,margin:safetyMargin(1000*GiB)};
    return {root,sources,assets,destination,segments};
  }
  /** `._` の付随ファイルを含めた一覧と、含めない一覧。 */
  const listing=async(folder:string)=>{const all=(await readdir(folder).catch(()=>[] as string[])).sort();return {all,main:all.filter(name=>!name.startsWith('._'))};};
  /** 強制終了するコピーの作業を1つ走らせる（元のプロセス＝この試験のプロセス）。 */
  async function crash(job:Awaited<ReturnType<typeof project>>,fault:IoFault){
    faults.push(fault);const jobs=new MediaCopyJobs(()=>io,referenceCopyPorts,new SpaceReservations());
    await jobs.startReconnect({root:job.root,projectId:'case',destination:job.destination,assets:job.assets});await jobs.idle();faults.length=0;
    const record=(await readCopyJobRecords(job.root))[0]!;expect(record.state).toBe('running');return record;
  }
  /** 強制終了の後の別のプロセス（pid 4242。元のプロセスは終わっている）。 */
  const nextProcess=()=>new MediaCopyJobs(()=>({...io,self:{pid:4242,startedAt:1},processAlive:()=>false}),referenceCopyPorts,new SpaceReservations());

  it('waits while the drive is out, then finds it by UUID under a new dev and removes only its own files, keeping the copy it connected',async()=>{
    const job=await project(['clip-1.wav','clip-2.wav']),folder=join(image!.mountPoint,...job.segments);
    await mkdir(folder,{recursive:true});await writeFile(join(folder,FOREIGN),'not ours');
    const crashed=await crash(job,{op:'write',match:call=>call.path.endsWith(PART_SUFFIX)&&call.path.includes('/clip-2.wav.'),nth:2,crash:true});
    const mountBefore=image!.mountPoint,devBefore=crashed.destination.volume.dev,before=await listing(folder);
    expect(before.main).toEqual(['clip-1.wav','clip-2.wav',crashed.items[1]!.part!.name,FOREIGN].sort());
    // ドライブを外す → 別のイメージが空いたディスク番号に付く → このドライブを付け直す（dev が変わる。Task 2 の実測）
    await detachImage(image!.mountPoint);
    const next=nextProcess();await next.ensureRecovered(job.root);
    expect((await readCopyJobRecords(job.root))[0]).toMatchObject({state:'waiting-volume',owner:{pid:4242}});
    other=await createExfatImage();image!.mountPoint=await attachImage(image!.dmg);
    const devAfter=(await stat(image!.mountPoint)).dev,now=join(image!.mountPoint,...job.segments);
    await next.retryWaiting();
    const after=(await readCopyJobRecords(job.root))[0]!,left=await listing(now);
    notes.reattach={mountBefore,mountAfter:image!.mountPoint,devBefore,devAfter,before:before.all,after:left.all,state:after.state,kept:after.kept??[]};
    expect(devAfter).not.toBe(devBefore);   // 付け直しで dev が実際に変わったこと（読み替えを試せていること）
    expect(after).toMatchObject({state:'stopped',items:[{phase:'done',connected:true},{phase:'cancelled'}]});expect(after.kept).toBeUndefined();
    expect(left.main).toEqual(['clip-1.wav',FOREIGN].sort());expect(await readFile(join(now,FOREIGN),'utf8')).toBe('not ours');
    expect(await sha(join(now,'clip-1.wav'))).toBe(await sha(job.sources[0]!));expect(await referenceTarget(job.root,job.assets[0]!.file)).toBe(join(mountBefore,...job.segments,'clip-1.wav'));
    expect(await referenceTarget(job.root,job.assets[1]!.file)).toBe(job.sources[1]);
  },180_000);
  it.each([
    ['after its mark was written, removes it by the mark (no inode in the record)','sync',[] as string[]],
    ['before its mark was written (the known exFAT window), keeps the empty file and reports it','write',['clip-1.wav']],
  ] as const)('a reservation %s',async(label,op,left)=>{
    const job=await project(['clip-1.wav']),folder=join(image!.mountPoint,...job.segments);
    const crashed=await crash(job,{op,match:call=>call.path===join(folder,'clip-1.wav'),nth:1,crash:true});
    expect(crashed.items[0]!.reserved).toMatchObject({token:expect.stringMatching(/^[a-f0-9]{32}$/)});expect(crashed.items[0]!.reserved!.ino).toBeUndefined();
    const before=await listing(folder);await nextProcess().ensureRecovered(job.root);
    const after=(await readCopyJobRecords(job.root))[0]!,rest=await listing(folder);notes[`reservation:${op}`]={before:before.all,after:rest.all,kept:after.kept??[]};
    expect(rest.main).toEqual(left);expect(after.kept).toEqual(left.length?left:undefined);expect(after.state).toBe('stopped');
    expect(await referenceTarget(job.root,job.assets[0]!.file)).toBe(job.sources[0]);void label;
  },120_000);
});
