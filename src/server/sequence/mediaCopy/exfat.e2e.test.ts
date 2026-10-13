// 使い捨ての exFAT イメージ（元・コピー先の2枚。同じ名前の別カードと番号の再利用の確認では、もう1枚ずつ）で、コピーの作業（jobs.ts）から回収（recovery.ts）までを実機の挙動で確かめる: 名前の衝突・識別・rename・取り外し・回収（重い任意実行: HARNESS_TEST_EXFAT=1）。
// 実在の SD カード・外付け・実案件は使わない。案件とイメージの置き場所は tmpdir()（実行時に TMPDIR で一時フォルダーへ向ける）。mount・diskutil は自分が付けたイメージだけを対象にする（ownImagesIo）。
// 300MB のイメージは安全余裕（20GB）を割るので、空きの値だけをコピー先の分について大きく見せる（ファイル操作はすべて本物の exFAT）。
// exFAT の実測（Task 2・7）: 空のファイルの ino は共通の仮の値で、初めて書いた時に先頭クラスタ番号になり rename では変わらない。付け直すと消したファイルの番号が再び使われる。`._名前` の付随ファイルができる。
// 名前の大文字小文字と Unicode の正規化（NFC/NFD）は区別しない。一覧（readdir）は NFD で返り、実パスの解決（native）は作った時の形を返す（この試験の記録で確かめる）。一覧を比べる所は NFC にそろえ、`._*` を除く。
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import {SequenceStore} from '../store';
import {buildEmptyDocument} from '../createDocuments';
import {referenceTarget,referenceVerificationTesting,registerSequenceReference} from '../references';
import {WRITE_FLAGS,faultyIo,nodeCopyIo,type CopyIo,type FaultyIo,type IoCall,type IoFault} from './io';
import {COPY_ROOT_NAME,copyFolderName,listVolumes} from './volumes';
import {GiB,SpaceReservations} from './space';
import {PART_SUFFIX} from './copyItem';
import {resolveCopyDestination} from './destinations';
import {ledgerConnects,readCopyJobRecords} from './jobRecord';
import {MediaCopyJobs,copyJobsRoot,referenceCopyPorts} from './jobs';
import {wav} from './__fixtures__/copyProject';
import {attachImage,createExfatImage,destroyExfatImage,detachImage,detachLeftoverImages,ownImagesIo,type ExfatImage} from './__fixtures__/exfatImage';

const enabled=process.env.HARNESS_TEST_EXFAT==='1'&&process.platform==='darwin';
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const nfc=(value:string)=>value.normalize('NFC');
const formOf=(value:string)=>value===value.normalize('NFC')?(value===value.normalize('NFD')?'same':'NFC'):value===value.normalize('NFD')?'NFD':'mixed';
describe.skipIf(!enabled)('copy jobs end to end on disposable exFAT images (real macOS behaviour)',()=>{
  const faults:IoFault[]=[],notes:Record<string,unknown>={};
  let source:ExfatImage|undefined,target:ExfatImage|undefined,twin:ExfatImage|undefined,home='',io:FaultyIo,count=0,clock=0;
  /** コピー先（同じ取り付け先に付いた同じ名前のカードも）の空きだけ大きく見せる（容量 1000GiB・空き 900GiB）。io.now は試験が進められる（回収の見張りの読み直しの間隔をまたぐ）。 */
  const roomy=(base:CopyIo):CopyIo=>({...base,home:()=>home,now:()=>base.now()+clock,statfs:async path=>target&&(path===target.mountPoint||path.startsWith(`${target.mountPoint}/`))
    ?{bsize:4096,bavail:Math.floor(900*GiB/4096),blocks:Math.floor(1000*GiB/4096)}:base.statfs(path)});
  beforeAll(async()=>{source=await createExfatImage();target=await createExfatImage();home=await mkdtemp(join(await realpath(tmpdir()),'exfat-e2e-'));io=faultyIo(roomy(ownImagesIo(nodeCopyIo)),faults);},180_000);
  afterEach(async()=>{faults.length=0;expect(referenceVerificationTesting.claims()).toBe(0);await referenceVerificationTesting.idle();referenceVerificationTesting.forget();});
  afterAll(async()=>{
    const results=await Promise.allSettled([source?destroyExfatImage(source):undefined,target?destroyExfatImage(target):undefined,twin?destroyExfatImage(twin):undefined,home?rm(home,{recursive:true,force:true}):undefined]);
    const sweep=await Promise.allSettled([detachLeftoverImages()]);
    console.log('[exfat-e2e]',JSON.stringify(notes));const failed=[...results,...sweep].find(result=>result.status==='rejected');if(failed)throw failed.reason;
  },120_000);

  interface Case {root:string;name:string;id:string;segments:string[];sources:string}
  /** このMac（一時フォルダー）の上の案件（窓口と同じく OS の実パスを鍵にする）。元の素材はイメージ（元）の上の案件ごとのフォルダー。コピー先はイメージ（コピー先）の上の「Harness 素材/<案件名>-<ID8>」。 */
  async function project(name='案件',folder='case'):Promise<Case>{
    const n=++count,dir=join(home,`${folder}-${n}`),id=`${n.toString(16).padStart(8,'0')}-aaaa-bbbb-cccc-000000000000`;await mkdir(dir);
    new SequenceStore(dir).save({document:buildEmptyDocument(name,()=>id),expectedSavedRevision:null,executionId:'seed'});
    const sources=join(source!.mountPoint,`case-${n}`);await mkdir(sources);
    return {root:copyJobsRoot(dir),name,id,segments:[COPY_ROOT_NAME,copyFolderName(name,id)],sources};
  }
  const folderOf=(job:Case)=>join(target!.mountPoint,...job.segments);
  async function linked(job:Case,name:string,mib:number,seed:number):Promise<{path:string;asset:SequenceAsset}>{
    const path=join(job.sources,name);await writeFile(path,wav(mib,seed));return {path,asset:await registerSequenceReference(job.root,path)};
  }
  const jobs=(retryMs?:number)=>new MediaCopyJobs(()=>io,referenceCopyPorts,new SpaceReservations(),retryMs?{retryMs}:{});
  /** 強制終了の後の別のプロセス（pid 4242。元のプロセスは終わっている）。 */
  const nextProcess=()=>new MediaCopyJobs(()=>({...io,self:{pid:4242,startedAt:1},processAlive:()=>false}),referenceCopyPorts,new SpaceReservations());
  /** 画面と同じ手順で始める: 候補を作り直して選んだコピー先（UUID・dev）を確かめ、開いた時のコピーを始めて終わるまで待つ。 */
  async function start(runner:MediaCopyJobs,job:Case,items:Array<{path:string;asset:SequenceAsset}>){
    const volume=(await listVolumes(io)).find(item=>item.mountPoint===target!.mountPoint)!;
    const destination=await resolveCopyDestination(io,{project:{name:job.name,id:job.id,root:job.root},sources:await Promise.all(items.map(async item=>({path:item.path,sizeBytes:(await stat(item.path)).size})))},
      {key:`volume:${volume.uuid}`,uuid:volume.uuid,dev:volume.dev},new SpaceReservations());
    expect(destination).toMatchObject({kind:'volume',base:target!.mountPoint,segments:job.segments});
    await runner.startReconnect({root:job.root,projectId:'case',destination,assets:items.map(item=>item.asset)});await runner.idle();
  }
  /** `._` の付随ファイルを含めた一覧と、含めない一覧（どちらも NFC にそろえる。exFAT の一覧は NFD で返る）。 */
  const listing=async(folder:string)=>{const all=(await readdir(folder).catch(()=>[] as string[])).map(nfc).sort();return {all,main:all.filter(name=>!name.startsWith('._'))};};
  const isPart=(call:IoCall)=>call.path.endsWith(PART_SUFFIX);
  /** 作るか書き換える呼び出し（mkdir・rename・unlink・書き込み・作成を含む開き方）。 */
  const writes=(calls:IoCall[])=>calls.filter(call=>['mkdir','rename','unlink','write'].includes(call.op)||(call.op==='open'&&((call.flags??0)&WRITE_FLAGS)!==0));
  /** 中身・名前を変える呼び出し（既にあるフォルダーの mkdir と、既にある名前への排他作成は EEXIST で何も変えないので除く）。 */
  const changes=(calls:IoCall[])=>calls.filter(call=>['rename','unlink','write'].includes(call.op));

  it('copies onto exFAT, reconnects, records the drive UUID, keeps the inode through the rename, and never writes to the original',async()=>{
    const job=await project(),clip=await linked(job,'clip.wav',8,1),before=await sha(clip.path),mtime=(await stat(clip.path)).mtimeMs,mark=io.calls.length,seen:Array<Record<string,unknown>>=[];
    // 段ごとに、記録した実体と、ディスク上の .part の ino（Number の stat）を見る
    const look=(at:string)=>async(call:IoCall)=>{const item=(await readCopyJobRecords(job.root))[0]!.items[0]!;seen.push({at,reservedIno:item.reserved?.ino,partIno:item.part?.ino,onDisk:(await lstat(call.from??call.path)).ino});};
    faults.push({op:'write',match:isPart,nth:1,before:look('first write')},{op:'write',match:isPart,nth:2,before:look('second write')},{op:'rename',before:look('rename')});
    await start(jobs(),job,[clip]);
    const copy=join(folderOf(job),'clip.wav'),record=(await readCopyJobRecords(job.root))[0]!,item=record.items[0]!,named=await stat(copy);
    expect(record).toMatchObject({state:'finished',items:[{phase:'done',connected:true,finalName:'clip.wav'}]});
    expect(await referenceTarget(job.root,clip.asset.file)).toBe(copy);expect(await sha(copy)).toBe(before);
    expect(await sha(clip.path)).toBe(before);expect((await stat(clip.path)).mtimeMs).toBe(mtime);
    // 元の媒体には読む操作だけ（元のファイルを開いたのは読み取り専用だけで、少なくとも1回は開いた）
    const onSource=io.calls.slice(mark).filter(call=>call.path.startsWith(`${source!.mountPoint}/`)||call.from?.startsWith(`${source!.mountPoint}/`));
    expect(onSource.filter(call=>call.op==='open'&&call.path===clip.path).length).toBeGreaterThan(0);expect(writes(onSource)).toEqual([]);
    // 空の .part の ino は記録しない（共通の仮の値）。初めて書いた後に記録し、rename の後も同じ ino（確定した実体の記録も同じ）
    expect(seen).toHaveLength(3);
    expect(Number.isSafeInteger(seen[0]!.onDisk)).toBe(false);expect(seen[0]!.partIno).toBeUndefined();expect(Number.isSafeInteger(seen[0]!.reservedIno)).toBe(true);
    expect(Number.isSafeInteger(seen[1]!.partIno)).toBe(true);expect(seen[1]!.onDisk).toBe(seen[1]!.partIno);expect(seen[2]!.partIno).toBe(seen[1]!.partIno);
    expect(item.final!.ino).toBe(seen[1]!.partIno);expect(named.ino).toBe(item.final!.ino);
    expect(record.destination.volume.uuid).toBe((await io.volumeDetails(target!.mountPoint)).uuid);
    expect((await listing(folderOf(job))).main).toEqual(['clip.wav']);
    notes.copied={state:record.state,uuid:record.destination.volume.uuid,dev:record.destination.volume.dev,inodes:seen,final:item.final,listing:(await listing(folderOf(job))).all};
  },120_000);

  it('takes the next name when a differently-cased name already exists, and leaves that file alone',async()=>{
    const job=await project(),clip=await linked(job,'clip.wav',4,2);await mkdir(folderOf(job),{recursive:true});
    const foreign=join(folderOf(job),'CLIP.WAV');await writeFile(foreign,wav(4,9));const theirs=await sha(foreign);
    await start(jobs(),job,[clip]);
    expect(await referenceTarget(job.root,clip.asset.file)).toBe(join(folderOf(job),'clip (2).wav'));expect(await sha(join(folderOf(job),'clip (2).wav'))).toBe(await sha(clip.path));
    expect(await sha(foreign)).toBe(theirs);expect((await listing(folderOf(job))).main).toEqual(['CLIP.WAV','clip (2).wav']);
  },120_000);

  it('uses a file with the same content under its on-disk spelling instead of copying again',async()=>{
    const job=await project(),clip=await linked(job,'clip.wav',4,3);await mkdir(folderOf(job),{recursive:true});
    const existing=join(folderOf(job),'CLIP.WAV');await writeFile(existing,wav(4,3));const mark=io.calls.length;
    await start(jobs(),job,[clip]);
    expect((await readCopyJobRecords(job.root))[0]).toMatchObject({state:'finished',items:[{phase:'done',connected:true,reused:true,finalName:'CLIP.WAV'}]});
    expect(await referenceTarget(job.root,clip.asset.file)).toBe(existing);expect((await listing(folderOf(job))).main).toEqual(['CLIP.WAV']);
    expect(changes(io.calls.slice(mark).filter(call=>call.path.startsWith(`${target!.mountPoint}/`)))).toEqual([]);   // コピー先に何も書いていない（予約の排他作成は EEXIST）
  },120_000);

  it.each(['NFC','NFD'] as const)('names with voiced marks spelled in %s: copies into the existing copy folder, reconnects, and recovers a crashed second copy',async spelling=>{
    const as=(value:string)=>value.normalize(spelling),job=await project(as('ドライバー練習'),as('ドライバー練習'));
    expect(formOf(as('ドライバー練習'))).toBe(spelling);   // 前提: その形で書いている（NFC と NFD で実際に違う文字列）
    // コピー先のフォルダーを、その形で先に作っておく（以前に作られたもの・Finder で作ったもの）。製品は案件名を NFC にそろえた名前で探す
    await mkdir(join(target!.mountPoint,COPY_ROOT_NAME),{recursive:true});await mkdir(join(target!.mountPoint,COPY_ROOT_NAME,as(job.segments[1]!)));
    const grip=await linked(job,as('グリップ.wav'),2,11),swing=await linked(job,as('スイング.wav'),2,12),swingBefore=await referenceTarget(job.root,swing.asset.file);
    faults.push({op:'write',match:call=>isPart(call)&&nfc(basename(call.path)).startsWith(nfc('スイング.wav.')),nth:2,crash:true});
    await start(jobs(),job,[grip,swing]);faults.length=0;
    const crashed=(await readCopyJobRecords(job.root))[0]!,folder=folderOf(job),before=await listing(folder);
    expect(crashed.state).toBe('running');expect(crashed.items[1]!.part).toMatchObject({ino:expect.any(Number)});
    expect(before.main).toEqual([nfc('グリップ.wav'),nfc('スイング.wav'),nfc(crashed.items[1]!.part!.name)].sort());
    await nextProcess().ensureRecovered(job.root);
    const after=(await readCopyJobRecords(job.root))[0]!,left=await listing(folder);
    expect(after).toMatchObject({state:'stopped',items:[{phase:'done',connected:true},{phase:'cancelled'}]});expect(after.kept).toBeUndefined();expect(left.main).toEqual([nfc('グリップ.wav')]);
    // 既存のフォルダーに入った（同じ名前に見える2つ目のフォルダーを作っていない）
    expect((await readdir(join(target!.mountPoint,COPY_ROOT_NAME))).filter(name=>nfc(name)===job.segments[1])).toHaveLength(1);
    // 台帳の接続先はディスク上の形（実パスの解決 native の結果）。受け渡しの path とは正規化だけ違ってよい
    const copy=join(folder,as('グリップ.wav')),connected=(await referenceTarget(job.root,grip.asset.file))!;
    expect(connected).toBe(await realpath(copy));expect(nfc(connected)).toBe(nfc(copy));expect(await sha(copy)).toBe(await sha(grip.path));
    expect(await referenceTarget(job.root,swing.asset.file)).toBe(swingBefore);
    const recorded=join(after.destination.folder.path,after.items[0]!.finalName!);
    for(const path of [recorded.normalize('NFC'),recorded.normalize('NFD')])expect(await ledgerConnects(referenceCopyPorts,job.root,after.items[0]!,path)).toEqual({connected:true});
    notes[`names:${spelling}`]={projectRoot:formOf(basename(job.root)),ledgerSource:formOf(basename(swingBefore!)),recordedFolder:formOf(after.destination.folder.path),finalName:formOf(after.items[0]!.finalName!),
      ledgerTarget:formOf(connected),readdirFolder:(await readdir(join(target!.mountPoint,COPY_ROOT_NAME))).filter(name=>nfc(name)===job.segments[1]).map(formOf),
      readdirFiles:(await readdir(folder)).filter(name=>!name.startsWith('._')).map(formOf),crashedPart:crashed.items[1]!.part,left:left.all};
  },120_000);

  it.each([['NFD','NFC'],['NFC','NFD']] as const)('a file spelled in %s is the same name as the copy spelled in %s: takes the next name and leaves that file alone',async(theirs,ours)=>{
    const job=await project(),name='グリップ.wav',clip=await linked(job,name.normalize(ours),2,21);await mkdir(folderOf(job),{recursive:true});
    const foreign=join(folderOf(job),name.normalize(theirs));await writeFile(foreign,wav(2,22));const before=await sha(foreign);
    await start(jobs(),job,[clip]);
    const connected=(await referenceTarget(job.root,clip.asset.file))!;
    expect((await readCopyJobRecords(job.root))[0]).toMatchObject({state:'finished',items:[{phase:'done',connected:true}]});
    expect(nfc(connected)).toBe(nfc(join(folderOf(job),'グリップ (2).wav')));expect(connected).toBe(await realpath(connected));expect(await sha(connected)).toBe(await sha(clip.path));
    expect(await sha(foreign)).toBe(before);expect((await listing(folderOf(job))).main).toEqual([nfc('グリップ (2).wav'),nfc(name)]);
  },120_000);

  it('uses a file with the same content spelled in the other form (NFC on disk, NFD in the source name) without copying again',async()=>{
    const job=await project(),name='グリップ.wav',clip=await linked(job,name.normalize('NFD'),2,23);await mkdir(folderOf(job),{recursive:true});
    const existing=join(folderOf(job),name.normalize('NFC'));await writeFile(existing,wav(2,23));const mark=io.calls.length;
    await start(jobs(),job,[clip]);
    const connected=(await referenceTarget(job.root,clip.asset.file))!;
    expect((await readCopyJobRecords(job.root))[0]).toMatchObject({state:'finished',items:[{phase:'done',connected:true,reused:true}]});
    expect(connected).toBe(await realpath(existing));expect((await listing(folderOf(job))).main).toEqual([nfc(name)]);
    expect(changes(io.calls.slice(mark).filter(call=>call.path.startsWith(`${target!.mountPoint}/`)))).toEqual([]);
    notes.reuseAcrossForms={finalName:formOf((await readCopyJobRecords(job.root))[0]!.items[0]!.finalName!),ledgerTarget:formOf(connected)};
  },120_000);

  it('stops when the copy drive is removed mid-copy, writes nowhere else, leaves a same-named card alone, and cleans up its own files when the drive returns',async()=>{
    const job=await project(),long=await linked(job,'long.wav',8,3),next=await linked(job,'next.wav',2,4),runner=jobs(3_600_000);
    const originals=[await referenceTarget(job.root,long.asset.file),await referenceTarget(job.root,next.asset.file)],uuid=(await io.volumeDetails(target!.mountPoint)).uuid;
    let detachedAt=0;faults.push({op:'write',match:isPart,nth:3,before:async()=>{detachedAt=io.calls.length;await detachImage(target!.mountPoint);}});
    await start(runner,job,[long,next]);faults.length=0;
    const record=(await readCopyJobRecords(job.root))[0]!,item=record.items[0]!,errno=/（([A-Z]+)）$/.exec(item.error??'')?.[1];
    notes.detach={state:record.state,errno,error:item.error,stopReason:record.stopReason,reserved:item.reserved,part:item.part,final:item.final,next:record.items[1]};
    expect(detachedAt).toBeGreaterThan(0);
    // 書き込みの失敗の errno で作業全体が止まり（2本目は始めない）、片付けられない実体を記録に残してドライブを待つ
    expect(record).toMatchObject({state:'waiting-volume',items:[{phase:'failed'},{phase:'cancelled',error:expect.stringContaining('コピーを止めました')}]});
    expect(item.reserved).toMatchObject({ino:expect.any(Number)});expect(item.part).toMatchObject({ino:expect.any(Number)});
    for(const [index,asset] of [long.asset,next.asset].entries())expect(await referenceTarget(job.root,asset.file)).toBe(originals[index]);
    // 消えた取り付け先を作り直していない・ほかの場所に書いていない
    expect(existsSync(target!.mountPoint)).toBe(false);expect(writes(io.calls.slice(detachedAt)).filter(call=>call.op!=='write'||!isPart(call))).toEqual([]);
    const mountBefore=record.destination.volume.mountPoint,devBefore=record.destination.volume.dev,folderName=job.segments;
    // 同じ名前の別のカード: 同じ取り付け先・同じ dev に付き、UUID だけが違う。同じ場所に同じ名前・同じ印のファイルを置いても、回収は触らない
    twin=await createExfatImage({label:target!.label});
    const twinVolume=(await listVolumes(io)).find(volume=>volume.mountPoint===twin!.mountPoint);
    expect(twin.mountPoint).toBe(mountBefore);expect(twinVolume).toMatchObject({dev:devBefore});expect(twinVolume!.uuid).not.toBe(uuid);
    const twinFolder=join(twin.mountPoint,...folderName);await mkdir(twinFolder,{recursive:true});
    await writeFile(join(twinFolder,'long.wav'),Buffer.from(item.reserved!.token,'hex'));await writeFile(join(twinFolder,item.part!.name),wav(1,5));
    const twinBefore=await listing(twinFolder),twinHashes=await Promise.all(twinBefore.main.map(name=>sha(join(twinFolder,name)))),tableWithTwin=JSON.stringify(await io.mounts());
    const twinInodes={long:(await stat(join(twinFolder,'long.wav'))).ino,part:(await stat(join(twinFolder,item.part!.name))).ino};
    await runner.retryWaiting();
    expect((await readCopyJobRecords(job.root))[0]).toMatchObject({state:'waiting-volume'});
    expect(await listing(twinFolder)).toEqual(twinBefore);expect(await Promise.all(twinBefore.main.map(name=>sha(join(twinFolder,name))))).toEqual(twinHashes);
    await destroyExfatImage(twin);twin=undefined;
    // このドライブを付け直す。記録した実体の ino が付け直しの前後で同じかを見てから回収する
    target!.mountPoint=await attachImage(target!.dmg);const folder=folderOf(job),tableAfter=JSON.stringify(await io.mounts());
    const inodesAfter={reserved:(await stat(join(folder,'long.wav')).catch(()=>undefined))?.ino,part:(await stat(join(folder,item.part!.name)).catch(()=>undefined))?.ino};
    const present=await listing(folder);
    // 回収の見張りは、mount の表が前回と同じ間は前回の一覧に無かった UUID を ABSENT_REFRESH_MS（2分）まで「まだ無い」と答える（同じ名前のカードと入れ替わった直後は表が同じ）
    await runner.retryWaiting();const immediate=(await readCopyJobRecords(job.root))[0]!.state,sameTable=tableAfter===tableWithTwin;
    expect(immediate).toBe(sameTable?'waiting-volume':'stopped');
    if(sameTable){clock+=121_000;await runner.retryWaiting();}
    const after=(await readCopyJobRecords(job.root))[0]!,left=await listing(folder);
    notes.recovered={mountBefore,mountAfter:target!.mountPoint,devBefore,devAfter:(await stat(target!.mountPoint)).dev,recordedInodes:{reserved:item.reserved!.ino,part:item.part!.ino},inodesAfter,
      present:present.all,left:left.all,kept:after.kept??[],state:after.state,sameTable,immediate,twin:{uuid:twinVolume!.uuid,dev:twinVolume!.dev,inodes:twinInodes,listing:twinBefore.all}};
    expect(after).toMatchObject({state:'stopped',items:[{phase:'failed'},{phase:'cancelled'}]});expect(after.kept).toBeUndefined();expect(left.all).toEqual([]);
    for(const [index,asset] of [long.asset,next.asset].entries())expect(await referenceTarget(job.root,asset.file)).toBe(originals[index]);
  },300_000);

  it.each(['removed','crashed'] as const)('a copy %s before the first bytes of its part were written (the known exFAT window) leaves only what it reports',async how=>{
    const job=await project(),long=await linked(job,'long.wav',8,6),original=await referenceTarget(job.root,long.asset.file),runner=jobs(3_600_000);
    faults.push(how==='removed'?{op:'write',match:isPart,nth:1,before:async()=>{await detachImage(target!.mountPoint);}}:{op:'write',match:isPart,nth:1,crash:true});
    await start(runner,job,[long]);faults.length=0;
    // .part は名前だけが記録されている（空の .part の ino は仮の値なので記録しない）。予約は印を書いて ino を記録済み
    const record=(await readCopyJobRecords(job.root))[0]!,partName=record.items[0]!.part?.name;
    expect(record.items[0]!.part).toEqual({name:expect.stringMatching(/^long\.wav\.[a-f0-9]{16}\.harness-part$/)});expect(record.items[0]!.reserved).toMatchObject({ino:expect.any(Number)});
    expect(record.state).toBe(how==='removed'?'waiting-volume':'running');
    if(how==='removed'){expect(existsSync(target!.mountPoint)).toBe(false);target!.mountPoint=await attachImage(target!.dmg);}
    const folder=folderOf(job),present=await listing(folder),partOnDisk=present.main.filter(name=>name.endsWith(PART_SUFFIX));
    const partSizes=await Promise.all(partOnDisk.map(async name=>(await stat(join(folder,name))).size));
    expect(partOnDisk).toEqual([partName]);expect(partSizes).toEqual([0]);   // 前提: 窓の実体（空の .part）が実際にディスクに残っている
    if(how==='removed')await runner.retryWaiting();else await nextProcess().ensureRecovered(job.root);
    const after=(await readCopyJobRecords(job.root))[0]!,left=await listing(folder);
    notes[`window:${how}`]={error:record.items[0]!.error,reserved:record.items[0]!.reserved,present:present.all,partSizes,left:left.all,kept:after.kept??[],state:after.state};
    expect(after.state).toBe('stopped');expect(left.main).not.toContain('long.wav');   // 印を書いて記録した予約は消せる
    for(const name of left.main)expect(after.kept??[]).toContain(name);   // 残ったのは「自分のものと確かめられず報告した」ファイルだけ
    expect(left.main).toEqual([partName]);expect(after.kept).toEqual([partName]);
    expect(await referenceTarget(job.root,long.asset.file)).toBe(original);
  },180_000);

  it('keeps and reports a file that took over the name and the cluster number of its reservation after the drive came back',async()=>{
    // 番号の再利用を確かめるため、この試験だけ新しいイメージをコピー先にする（前の試験で空いた小さい番号が先に使われないように）
    const main=target!,fresh=await createExfatImage();target=fresh;
    try{
      const job=await project(),long=await linked(job,'long.wav',8,7),runner=jobs(3_600_000);
      faults.push({op:'write',match:isPart,nth:3,before:async()=>{await detachImage(fresh.mountPoint);}});
      await start(runner,job,[long]);faults.length=0;
      const record=(await readCopyJobRecords(job.root))[0]!,item=record.items[0]!;expect(record.state).toBe('waiting-volume');expect(item.reserved).toMatchObject({ino:expect.any(Number)});
      fresh.mountPoint=await attachImage(fresh.dmg);const folder=folderOf(job);
      // 付け直した後に、誰かが予約と .part を消して、同じ名前・同じ大きさ（16 バイト）の別のファイルを作った
      await unlink(join(folder,'long.wav'));await unlink(join(folder,item.part!.name));
      const stranger=randomBytes(16);await writeFile(join(folder,'long.wav'),stranger);const strangerIno=(await stat(join(folder,'long.wav'))).ino;
      expect(strangerIno).toBe(item.reserved!.ino);   // 前提: 消した予約の番号（先頭クラスタ）が、同じ名前の別のファイルに再び使われた
      await runner.retryWaiting();const immediate=(await readCopyJobRecords(job.root))[0]!.state;if(immediate==='waiting-volume'){clock+=121_000;await runner.retryWaiting();}
      const after=(await readCopyJobRecords(job.root))[0]!;
      notes.clusterReuse={recordedReservedIno:item.reserved!.ino,recordedPartIno:item.part!.ino,strangerIno,immediate,kept:after.kept??[],left:(await listing(folder)).all};
      // 名前・大きさ・dev・ino が予約と同じでも、印の中身が違うので自分の予約ではない: 消さずに残して報告する
      expect(after.state).toBe('stopped');expect(after.kept).toEqual(['long.wav']);expect(await readFile(join(folder,'long.wav'))).toEqual(stranger);
    }finally{target=main;await destroyExfatImage(fresh);}
  },240_000);
});
