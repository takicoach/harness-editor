// 起動時の回収（設計 §5）: 作成プロセスが終わったジョブについて、記録にある自分の実体だけを消し、「結果不明」は台帳と突き合わせる。
// コピー先が未接続なら記録を残して次の接続時に行う。名前（.harness-part）だけを根拠に消さない。
// 合否は「持ち主の違うファイル・接続済みのコピー・元のファイル・他のエディターのジョブのファイルが守られたか」で判定する（各段で落ちた記録を作って回収する）。
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {chmod,cp,link,mkdir,readFile,readdir,rename,stat,unlink,utimes,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {CREATE_EXCLUSIVE,READ_ONLY,SimulatedCrash,type CopyIo,type IoCall,type IoFault} from './io';
import type {FakeVolume} from './fakeIo';
import {COPY_ROOT_NAME,listVolumes} from './volumes';
import {SpaceReservations} from './space';
import {PART_SUFFIX} from './copyItem';
import {readCopyJobRecords,writeCopyJobRecord,type CopyJobRecord} from './jobRecord';
import {MediaCopyJobs,referenceCopyPorts,type CopyPorts} from './jobs';
import {recoverCopyJobs,type RecoveryResult} from './recovery';
import {resolveCopyDestination} from './destinations';
import {ReferenceConnectUnknown,referenceTarget,referenceVerificationTesting} from '../references';
import {copyProject,type CopyProject} from './__fixtures__/copyProject';

let p:CopyProject|undefined;
afterEach(async()=>{
  try{
    if(p){
      // 元の媒体（SD）には読み取り専用で開く・読む・閉じる・調べる以外をしていない（回収を含む）
      const onSource=(call:IoCall)=>[call.path,call.from].some(path=>path!==undefined&&(path===p!.sd||path.startsWith(`${p!.sd}/`)));
      expect(p.faulty.calls.filter(call=>onSource(call)&&!(call.op==='open'?call.flags===READ_ONLY:['read','close','stat','lstat','statfs','volumeDetails'].includes(call.op)))).toEqual([]);
      expect(referenceVerificationTesting.claims()).toBe(0);
    }
  }finally{await referenceVerificationTesting.idle();referenceVerificationTesting.forget();await p?.cleanup();p=undefined;}
});
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const folder=()=>join(p!.ssd,COPY_ROOT_NAME,'案件-12345678'),final=()=>join(folder(),'clip-1.wav');
/** コピー先の一覧（exFAT の `._` の付随ファイルは除く）。 */
const files=async(dir=folder())=>(await readdir(dir).catch(()=>[] as string[])).filter(name=>!name.startsWith('._')).sort();
const records=()=>readCopyJobRecords(p!.project);
const record=async()=>(await records())[0]!;
const byId=async(jobId:string)=>(await records()).find(item=>item.jobId===jobId)!;
const guards=async()=>(await readdir(join(p!.project,'.harness/copy-jobs'))).filter(name=>name.includes('.recovering'));
/** その記録の回収の札（.harness/copy-jobs/<ジョブID>.recovering）。 */
const guard=async()=>join(p!.project,'.harness','copy-jobs',`${(await record()).jobId}.recovering`);
const takeOut=()=>{const index=p!.io.volumes.findIndex(volume=>volume.uuid==='SSD');return {index,volume:p!.io.volumes.splice(index,1)[0]!};};
const isPart=(call:IoCall)=>call.path.endsWith(PART_SUFFIX);
const FOREIGN='foreign.wav.0123456789abcdef.harness-part';
/** 名前が自分の .part と同じ形の、持ち主の違うファイル（名前だけでは消さない）。 */
const placeForeign=async()=>{await mkdir(folder(),{recursive:true});await writeFile(join(folder(),FOREIGN),'not ours');};
const foreignIntact=async()=>expect(await readFile(join(folder(),FOREIGN),'utf8')).toBe('not ours');
/** 強制終了の後、別のプロセス（既定は pid 4242）として回収する。元のプロセスは終わっている（processAlive が false）。 */
const nextProcess=(extra:Partial<CopyIo>={})=>
  new MediaCopyJobs(()=>({...p!.io,self:{pid:4242,startedAt:1},processAlive:()=>false,...extra}),referenceCopyPorts,new SpaceReservations());
/** fault で強制終了するコピーの作業を1つ走らせる（self を変えると別のエディターの作業になる）。 */
async function crashAt(fault:IoFault|null,ports:CopyPorts=referenceCopyPorts,options:{assets?:CopyProject['assets'];self?:CopyIo['self']}={}){
  const jobs=new MediaCopyJobs(()=>options.self?{...p!.io,self:options.self}:p!.io,ports,new SpaceReservations());if(fault)p!.faults.push(fault);
  const view=await jobs.startReconnect({root:p!.project,projectId:'case',destination:p!.destination,assets:options.assets??p!.assets});await jobs.idle();p!.faults.length=0;return view.jobId;
}
const inFolder=(call:IoCall)=>call.path===final();
const linkedToCard=async(index=0)=>expect(await referenceTarget(p!.project,p!.assets[index]!.file)).toBe(p!.sources[index]);

describe('after a crash',()=>{
  it.each([
    ['the final name is reserved',{op:'open',match:(call:IoCall)=>isPart(call)&&call.flags===CREATE_EXCLUSIVE,crash:true}],
    ['copying',{op:'write',nth:2,crash:true}],
    ['verifying',{op:'open',match:(call:IoCall)=>isPart(call)&&call.flags===READ_ONLY,crash:true}],
    ['named, before connecting',{op:'open',match:(call:IoCall)=>inFolder(call)&&call.flags===READ_ONLY,nth:2,crash:true}],   // 1回目は rename の前の予約の印の確認
  ] as Array<[string,IoFault]>)('when %s, removes only its own files and keeps the link on the card',async(_label,fault)=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await placeForeign();await crashAt(fault);expect((await record()).state).toBe('running');
    expect((await files()).length).toBeGreaterThan(1);
    await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual([FOREIGN]);await foreignIntact();await linkedToCard();
    expect(await record()).toMatchObject({state:'stopped',owner:{pid:4242},stopReason:expect.stringContaining('アプリの終了'),items:[{phase:'cancelled',error:'アプリの終了で止まりました'}]});
    const item=(await record()).items[0]!;expect(item.part??item.reserved??item.final).toBeUndefined();expect((await record()).kept).toBeUndefined();
    expect(await guards()).toEqual([]);
  });
  it.each([[false,[] as string[]],[true,['clip-1.wav']]] as const)('while connecting, decides by the ledger (ledger changed=%s)',async(changed,left)=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});
    await crashAt(null,{...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{if(changed)await referenceCopyPorts.reconnect(root,asset,copy,generation);throw new SimulatedCrash('connect');}});
    expect((await record()).items[0]!.phase).toBe('connecting');
    const before=await sha(final());await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual([...left]);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(changed?final():p.sources[0]);
    expect(await record()).toMatchObject(changed?{state:'finished',items:[{phase:'done',connected:true}]}:{state:'stopped',items:[{phase:'cancelled'}]});
    if(changed)expect(await sha(final())).toBe(before);
  });
  it('keeps the copy that an earlier file of the job was connected to and cleans only the unfinished file',async()=>{
    p=await copyProject();await placeForeign();
    await crashAt({op:'write',match:call=>isPart(call)&&call.path.includes('/clip-2.wav.'),nth:2,crash:true});
    const before=await sha(final());await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual(['clip-1.wav',FOREIGN]);expect(await sha(final())).toBe(before);await foreignIntact();
    expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(final());await linkedToCard(1);
    expect(await record()).toMatchObject({state:'stopped',items:[{phase:'done',connected:true},{phase:'cancelled'}]});
  });
  // 記録のフォルダーの fsync ができない FS や停電で「接続を変更中」の記録だけが失われ、名前を確定済み・照合中のまま残っても、台帳がコピーを指していれば消さない
  it.each(['named','verifying'] as const)('keeps the copy and marks it done when the ledger already points at it although the record says %s',async phase=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});
    await crashAt(null,{...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{await referenceCopyPorts.reconnect(root,asset,copy,generation);throw new SimulatedCrash('connect');}});
    const lost=await record(),item=lost.items[0]!,made=item.final!;item.phase=phase;
    if(phase==='verifying'){item.part={name:'clip-1.wav.0123456789abcdef.harness-part',dev:made.dev,ino:made.ino,size:made.size,mtimeMs:made.mtimeMs};item.reserved={token:'0'.repeat(32)};delete item.final;}
    await writeCopyJobRecord(p.project,lost);const before=await sha(final());
    await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual(['clip-1.wav']);expect(await sha(final())).toBe(before);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(final());
    expect(await record()).toMatchObject({state:'finished',items:[{phase:'done',connected:true}]});
  });
});

// 案件フォルダーをコピーの途中で複製した（Finder の複製・Time Machine の復元・同期フォルダーも同じ形）: 複製の台帳は「つながっていない」と答えるが、そのコピーは元の案件が使っている
describe('a duplicate of the project made while a copy ran',()=>{
  it.each(['another process','the same process'] as const)('opened by %s, consults no ledger, removes nothing and reports the files',async who=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const duplicate=join(p.home,'Projects','case copy');
    const jobs=new MediaCopyJobs(()=>p!.io,{...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{
      await cp(p!.project,duplicate,{recursive:true});await referenceCopyPorts.reconnect(root,asset,copy,generation);}},new SpaceReservations());
    await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:p.assets});await jobs.idle();
    expect((await record()).state).toBe('finished');expect((await readCopyJobRecords(duplicate))[0]).toMatchObject({state:'running',items:[{phase:'connecting',final:expect.any(Object)}]});
    const before=await sha(final());
    if(who==='the same process')await jobs.list(duplicate);else await nextProcess().ensureRecovered(duplicate);
    expect(await files()).toEqual(['clip-1.wav']);expect(await sha(final())).toBe(before);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(final());
    expect((await readCopyJobRecords(duplicate))[0]).toMatchObject({state:'stopped',kept:['clip-1.wav'],stopReason:expect.stringContaining('複製'),items:[{phase:'cancelled'}]});
    expect(await referenceTarget(duplicate,p.assets[0]!.file)).toBe(p.sources[0]);
  });
});

describe('a result left unknown because the ledger could not be read (Task 10)',()=>{
  const lock=()=>join(p!.project,'.harness','references','.mutation-lock');
  /** 別のエディター（生きている別の pid）が台帳の変更を始めて読めない、を再現する。 */
  const holdLedger=()=>writeFile(lock(),JSON.stringify({format:'harness-reference-mutation',version:1,pid:process.ppid,startedAt:Date.now(),token:'0d4c5a4e-1b2c-4d3e-8f90-123456789abc'})+'\n');
  async function unresolvedJob(changed:boolean){
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});
    await crashAt(null,{...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{
      if(changed)await referenceCopyPorts.reconnect(root,asset,copy,generation);await holdLedger();throw new ReferenceConnectUnknown(new Error('試験'));}});
    expect(await record()).toMatchObject({state:'stopped',items:[{phase:'failed',unresolved:true,final:expect.any(Object)}]});expect(await files()).toEqual(['clip-1.wav']);
  }
  it.each([[true,['clip-1.wav']],[false,[]]] as const)('is decided by the ledger at the next start (ledger changed=%s)',async(changed,left)=>{
    await unresolvedJob(changed);await unlink(lock());
    await nextProcess().ensureRecovered(p!.project);
    expect(await files()).toEqual([...left]);expect(await referenceTarget(p!.project,p!.assets[0]!.file)).toBe(changed?final():p!.sources[0]);
    const item=(await record()).items[0]!;expect(item.unresolved).toBeUndefined();
    if(changed){expect(await record()).toMatchObject({state:'finished',items:[{phase:'done',connected:true}]});expect(item.error).toBeUndefined();}
    else{expect(item).toMatchObject({phase:'failed',error:expect.stringContaining('接続は変わっていません')});expect(item.final).toBeUndefined();}
  });
  it('is left for the next start, with the copy kept, while the ledger still cannot be read',async()=>{
    await unresolvedJob(true);
    await nextProcess().ensureRecovered(p!.project);
    expect(await files()).toEqual(['clip-1.wav']);
    expect((await record()).items[0]).toMatchObject({phase:'failed',unresolved:true,final:expect.any(Object),error:expect.stringContaining('次の起動')});expect((await record()).kept).toBeUndefined();
    await unlink(lock());await nextProcess({self:{pid:4343,startedAt:1}}).ensureRecovered(p!.project);
    expect(await files()).toEqual(['clip-1.wav']);expect(await record()).toMatchObject({state:'finished',owner:{pid:4343},items:[{phase:'done',connected:true}]});
  });
});

describe('whose process may still be alive',()=>{
  it('leaves a job alone while its process is alive with the same start time or its start time cannot be read, and recovers it when the pid was reused',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});const owner=(await record()).owner;
    await nextProcess({processAlive:()=>true,processStartedAt:async()=>owner.startedAt}).ensureRecovered(p.project);
    expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);expect((await record()).owner).toEqual(owner);
    await nextProcess({processAlive:()=>true,processStartedAt:async()=>{throw new Error('ps が失敗しました（試験）');}}).ensureRecovered(p.project);
    expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);expect((await record()).state).toBe('running');
    await nextProcess({processAlive:()=>true,processStartedAt:async()=>owner.startedAt+60_000}).ensureRecovered(p.project);
    expect(await files()).toEqual([]);
  });
  it('cleans the files of an ended job but not those of a job another running editor owns in the same folder',async()=>{
    p=await copyProject();await placeForeign();
    const ended=await crashAt({op:'write',match:isPart,nth:2,crash:true},referenceCopyPorts,{assets:[p.assets[0]!]});
    const other=await crashAt({op:'write',match:isPart,nth:2,crash:true},referenceCopyPorts,{assets:[p.assets[1]!],self:{pid:5555,startedAt:5}});
    const theirs=(await files()).filter(name=>name.startsWith('clip-2.wav')),saved=await byId(other);expect(theirs).toHaveLength(2);   // 予約と .part
    await nextProcess({processAlive:pid=>pid===5555,processStartedAt:async pid=>pid===5555?5:undefined}).ensureRecovered(p.project);
    expect(await files()).toEqual([...theirs,FOREIGN].sort());await foreignIntact();
    expect(await byId(other)).toEqual(saved);expect(await byId(ended)).toMatchObject({state:'stopped',owner:{pid:4242}});
  });
  it('never touches a job that this process is still running, and lists it as its own',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const jobs=new MediaCopyJobs(()=>p!.io,referenceCopyPorts,new SpaceReservations());let seen:RecoveryResult|undefined,during:string[]=[];
    let listed:Awaited<ReturnType<MediaCopyJobs['list']>>=[];
    p.faults.push({op:'write',match:isPart,nth:2,before:async()=>{seen=await recoverCopyJobs(p!.io,p!.project,referenceCopyPorts);await jobs.retryWaiting();listed=await jobs.list(p!.project);during=await files();}});
    await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:p.assets});await jobs.idle();
    expect(listed[0]).toMatchObject({state:'running'});expect(listed[0]!.notThisProcess).toBeUndefined();
    expect(seen).toEqual({recovered:[],waitingVolume:[],skipped:[(await record()).jobId]});expect(during.some(name=>name.endsWith(PART_SUFFIX))).toBe(true);
    expect(await record()).toMatchObject({state:'finished',items:[{phase:'done'}]});expect(await files()).toEqual(['clip-1.wav']);
  });
});

describe('a job this process does not run (another editor, or a skipped recovery)',()=>{
  it('is listed as not this process\'s (no progress, no cancelling) and recovered by the 15-second watch once its process has ended',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});const owner=(await record()).owner;let alive=true;
    const next=new MediaCopyJobs(()=>({...p!.io,self:{pid:4242,startedAt:1},processAlive:()=>alive,processStartedAt:async()=>owner.startedAt}),referenceCopyPorts,new SpaceReservations(),{retryMs:20});
    const jobId=(await record()).jobId;
    expect((await next.list(p.project))[0]).toMatchObject({state:'running',notThisProcess:true});expect(()=>next.cancel(p!.project,jobId)).toThrow('見つかりません');
    alive=false;
    await vi.waitFor(async()=>expect((await record()).state).toBe('stopped'),{timeout:5000,interval:20});
    expect(await files()).toEqual([]);expect((await next.list(p.project))[0]!.notThisProcess).toBeUndefined();
  });
  it('refuses to start a copy while another live process holds a recovery guard of the project, and starts once that process has ended',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const dir=join(p.project,'.harness','copy-jobs');await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'cp-00000000000000000001.recovering'),JSON.stringify({pid:7777,startedAt:7}));let alive=true;
    const jobs=new MediaCopyJobs(()=>({...p!.io,processAlive:pid=>pid===7777&&alive,processStartedAt:async()=>7}),referenceCopyPorts,new SpaceReservations());
    const start=()=>jobs.startReconnect({root:p!.project,projectId:'case',destination:p!.destination,assets:p!.assets});
    await expect(start()).rejects.toMatchObject({status:409,message:expect.stringContaining('片付け')});expect(await readCopyJobRecords(p.project)).toEqual([]);
    alive=false;await start();await jobs.idle();expect((await record()).state).toBe('finished');expect(await guards()).toEqual([]);
  });
  it('re-reads the record after taking the guard and follows a recovery another process finished first',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    const as=(pid:number):CopyIo=>({...p!.io,self:{pid,startedAt:1},processAlive:()=>false});
    // 4242 が記録を読んで札を取る前（ドライブを確かめている間）に、4343 が回収を終える
    p.faults.push({op:'mounts',nth:1,before:async()=>{await recoverCopyJobs(as(4343),p!.project,referenceCopyPorts);}});
    const result=await recoverCopyJobs(as(4242),p.project,referenceCopyPorts);p.faults.length=0;
    expect(result).toEqual({recovered:[],waitingVolume:[],skipped:[]});expect(await record()).toMatchObject({state:'stopped',owner:{pid:4343}});expect(await files()).toEqual([]);
  });
  it('removes a guard left behind by a process that ended right after writing the record, and keeps one a live process holds',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});await nextProcess().ensureRecovered(p.project);
    expect((await record()).state).toBe('stopped');await writeFile(await guard(),JSON.stringify({pid:7777,startedAt:7}));
    await nextProcess({self:{pid:4343,startedAt:1},processAlive:pid=>pid===7777,processStartedAt:async()=>7}).ensureRecovered(p.project);expect(await guards()).toHaveLength(1);
    await nextProcess({self:{pid:4343,startedAt:1}}).ensureRecovered(p.project);expect(await guards()).toEqual([]);
  });
});

describe('the copy drive',()=>{
  it('checks for the drive before taking the guard: a job waiting for it stays waiting while another process holds its guard',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const jobId=await crashAt({op:'write',nth:2,crash:true});takeOut();
    await nextProcess().ensureRecovered(p.project);expect((await record()).state).toBe('waiting-volume');
    await writeFile(await guard(),JSON.stringify({pid:7777,startedAt:7}));
    const io:CopyIo={...p.io,self:{pid:4242,startedAt:1},processAlive:pid=>pid===7777,processStartedAt:async()=>7};
    expect(await recoverCopyJobs(io,p.project,referenceCopyPorts)).toEqual({recovered:[],waitingVolume:[jobId],skipped:[]});
  });
  it('does not ask diskutil again while the mount table is unchanged, and notices the drive once it is back',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});const {index,volume}=takeOut(),next=nextProcess();
    await next.ensureRecovered(p.project);expect((await record()).state).toBe('waiting-volume');
    const details=()=>p!.faulty.calls.filter(call=>call.op==='volumeDetails').length,seen=details();
    await next.retryWaiting();await next.retryWaiting();expect(details()).toBe(seen);expect((await record()).state).toBe('waiting-volume');
    p.io.volumes.splice(index,0,volume);await next.retryWaiting();expect(details()).toBeGreaterThan(seen);expect(await files()).toEqual([]);expect((await record()).state).toBe('stopped');
  });
  it('keeps watching for the drive after a recovery that ended in an error',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});let taken:ReturnType<typeof takeOut>|undefined;
    p.faults.push({op:'write',nth:2,error:'EIO',before:()=>{taken=takeOut();}});
    const jobs=new MediaCopyJobs(()=>p!.io,referenceCopyPorts,new SpaceReservations(),{retryMs:20});
    await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:p.assets});await jobs.idle();p.faults.length=0;
    expect((await record()).state).toBe('waiting-volume');
    // 記録を読めない間の見張りは例外で終わる（何度か）。その後もやめずに続け、ドライブが戻ったら片付ける
    const dir=join(p.project,'.harness','copy-jobs');await chmod(dir,0o000);try{await sleep(150);}finally{await chmod(dir,0o700);}
    p.io.volumes.splice(taken!.index,0,taken!.volume);
    await vi.waitFor(async()=>expect((await record()).state).toBe('stopped'),{timeout:5000,interval:20});expect(await files()).toEqual([]);
  });
  it('waits for the drive even when it came back under the same dev before the job ended, and cleans up within the session',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});let taken:ReturnType<typeof takeOut>|undefined;
    const putBack=()=>{if(taken){p!.io.volumes.splice(taken.index,0,taken.volume);taken=undefined;}};
    // 3回目の mount は、取り外しを確かめた（2回目）後。そこで同じ dev のまま付け直す
    p.faults.push({op:'write',nth:2,error:'EIO',before:()=>{taken=takeOut();}},{op:'mounts',nth:3,before:putBack});
    const jobs=new MediaCopyJobs(()=>p!.io,referenceCopyPorts,new SpaceReservations());
    await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:p.assets});await jobs.idle();p.faults.length=0;putBack();
    expect((await record()).state).toBe('waiting-volume');expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);
    await jobs.retryWaiting();expect(await files()).toEqual([]);expect((await record()).state).toBe('stopped');
  });
  it('waits for the copy drive to come back before touching anything, then recovers',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    const {index,volume}=takeOut(),next=nextProcess();await next.ensureRecovered(p.project);
    expect(await record()).toMatchObject({state:'waiting-volume',owner:{pid:4242},items:[{phase:'copying'}]});expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);
    expect((await next.list(p.project))[0]!.state).toBe('waiting-volume');
    // 別のエディターは、待っているプロセス（4242）が生きている間は触らない
    await nextProcess({self:{pid:4343,startedAt:1},processAlive:pid=>pid===4242,processStartedAt:async()=>1}).ensureRecovered(p.project);
    expect((await record()).owner.pid).toBe(4242);
    await next.retryWaiting();expect((await record()).state).toBe('waiting-volume');   // まだ外れている
    p.io.volumes.splice(index,0,volume);await next.retryWaiting();
    expect(await files()).toEqual([]);expect((await record()).state).toBe('stopped');await linkedToCard();
    expect((await next.list(p.project))[0]!.state).toBe('stopped');
  });
  it('finds the drive by its UUID when it comes back under another mount point, and leaves the drive now at the old mount point alone',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    const ours=await files(),{volume}=takeOut(),next=nextProcess();await next.ensureRecovered(p.project);expect((await record()).state).toBe('waiting-volume');
    // 同じ名前の別のドライブが元の取り付け先に付き、このドライブは「ssd 1」に付いた
    const moved=`${p.ssd} 1`;await rename(p.ssd,moved);await mkdir(folder(),{recursive:true});
    for(const name of ours)await writeFile(join(folder(),name),'another drive');
    p.io.volumes.push({...volume,mountPoint:moved},{...volume,uuid:'OTHER',mountPoint:p.ssd} satisfies FakeVolume);
    await next.retryWaiting();
    expect(await files(join(moved,COPY_ROOT_NAME,'案件-12345678'))).toEqual([]);expect(await files()).toEqual(ours);
    for(const name of ours)expect(await readFile(join(folder(),name),'utf8')).toBe('another drive');
    expect(await record()).toMatchObject({state:'stopped'});expect((await record()).kept).toBeUndefined();
  });
  it('when the copy drive disappears during a copy, waits for it within the same session and then cleans up',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});let taken:ReturnType<typeof takeOut>|undefined;
    p.faults.push({op:'write',nth:2,error:'EIO',before:()=>{taken=takeOut();}});
    const jobs=new MediaCopyJobs(()=>p!.io,referenceCopyPorts,new SpaceReservations());
    await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:p.assets});await jobs.idle();p.faults.length=0;
    expect((await record()).state).toBe('waiting-volume');expect((await jobs.list(p.project))[0]!.state).toBe('waiting-volume');
    expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);
    await expect(jobs.dismiss(p.project,(await record()).jobId)).rejects.toMatchObject({status:409});
    p.io.volumes.splice(taken!.index,0,taken!.volume);await jobs.retryWaiting();
    expect(await files()).toEqual([]);expect(await record()).toMatchObject({state:'stopped',stopReason:expect.stringContaining('EIO')});
    expect((await jobs.list(p.project))[0]).toMatchObject({state:'stopped',items:[{phase:'failed'}]});
    await linkedToCard();
  });
  it('recovers a waiting job before a new copy starts once the drive is back',async()=>{
    p=await copyProject();let taken:ReturnType<typeof takeOut>|undefined;
    p.faults.push({op:'write',nth:2,error:'EIO',before:()=>{taken=takeOut();}});
    const jobs=new MediaCopyJobs(()=>p!.io,referenceCopyPorts,new SpaceReservations());
    const first=(await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:[p.assets[0]!]})).jobId;await jobs.idle();p.faults.length=0;
    expect((await byId(first)).state).toBe('waiting-volume');p.io.volumes.splice(taken!.index,0,taken!.volume);
    let before:string[]|undefined;p.faults.push({op:'open',match:call=>isPart(call)&&call.flags===CREATE_EXCLUSIVE,before:async()=>{before??=await files();}});
    await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:[p.assets[1]!]});await jobs.idle();
    expect(before).toEqual(['clip-2.wav']);expect((await byId(first)).state).toBe('stopped');expect(await files()).toEqual(['clip-2.wav']);
  });
  it('does not recover a waiting job while another copy of the same project is running in this process',async()=>{
    p=await copyProject();let taken:ReturnType<typeof takeOut>|undefined;
    p.faults.push({op:'write',nth:2,error:'EIO',before:()=>{taken=takeOut();}});
    const jobs=new MediaCopyJobs(()=>p!.io,referenceCopyPorts,new SpaceReservations());
    const first=(await jobs.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:[p.assets[0]!]})).jobId;await jobs.idle();p.faults.length=0;
    const boot=(await listVolumes(p.io)).find(volume=>volume.uuid==='BOOT')!;
    const internal=await resolveCopyDestination(p.io,{project:{name:'案件',id:'12345678-aaaa',root:p.project},sources:[{path:p.sources[1]!,sizeBytes:(await stat(p.sources[1]!)).size}]},
      {key:'internal',uuid:'BOOT',dev:boot.dev},new SpaceReservations());
    let during:CopyJobRecord['state']|undefined;
    p.faults.push({op:'write',match:isPart,nth:2,before:async()=>{p!.io.volumes.splice(taken!.index,0,taken!.volume);await jobs.retryWaiting();during=(await byId(first)).state;}});
    await jobs.startReconnect({root:p.project,projectId:'case',destination:internal,assets:[p.assets[1]!]});await jobs.idle();p.faults.length=0;
    expect(during).toBe('waiting-volume');expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);
    await jobs.retryWaiting();expect((await byId(first)).state).toBe('stopped');expect(await files()).toEqual([]);
  });
});

describe('files it cannot prove are its own',()=>{
  it('does not delete a file that took the place of its own part, and reports it',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    const part=(await record()).items[0]!.part!.name;await unlink(join(folder(),part));await writeFile(join(folder(),part),'someone else');
    await nextProcess().ensureRecovered(p.project);
    expect(await readFile(join(folder(),part),'utf8')).toBe('someone else');expect((await record()).kept).toEqual([part]);
    expect((await nextProcess().list(p.project))[0]!.kept).toEqual([part]);
  });
  it('touches nothing when the copy folder was replaced, and reports its file names',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    const ours=await files(),moved=`${folder()}-moved`;await rename(folder(),moved);await mkdir(folder());
    for(const name of ours)await writeFile(join(folder(),name),'a new folder');
    await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual(ours);for(const name of ours)expect(await readFile(join(folder(),name),'utf8')).toBe('a new folder');
    expect(await files(moved)).toEqual(ours);
    expect([...(await record()).kept!].sort()).toEqual(ours);expect((await record()).items[0]!.part).toBeUndefined();
  });
  // exFAT は付け直しで番号が別のファイルに再び使われる: 記録の実体と同じ識別（dev・ino・大きさ・時刻）のファイルが、置き換わったフォルダーにあっても消さない（ハードリンクで再現）
  it('does not remove a file in a replaced folder even when it carries the identity of its own copy',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'open',match:call=>inFolder(call)&&call.flags===READ_ONLY,nth:2,crash:true});
    expect((await record()).items[0]!.final).toBeDefined();const moved=`${folder()}-moved`;await rename(folder(),moved);await mkdir(folder());await link(join(moved,'clip-1.wav'),final());
    await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual(['clip-1.wav']);expect(await files(moved)).toEqual(['clip-1.wav']);expect((await record()).kept).toEqual(['clip-1.wav']);
  });
  // exFAT: 空のファイルの ino は共通の仮の値。予約は作る前に印だけで記録する（dev・ino なし）
  it.each([
    ['after its mark was written, removes it by the mark',{op:'sync',nth:1,crash:true},[] as string[]],
    ['before its mark was written (the known exFAT window), keeps the empty file and reports it',{op:'write',nth:1,crash:true},['clip-1.wav']],
  ] as Array<[string,IoFault,string[]]>)('a reservation on exFAT %s',async(_label,fault,left)=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}],exfatEmptyInodes:true});await placeForeign();await crashAt(fault);
    const reserved=(await record()).items[0]!.reserved!;expect(reserved.token).toMatch(/^[a-f0-9]{32}$/);expect(reserved.ino).toBeUndefined();
    await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual([...left,FOREIGN].sort());await foreignIntact();expect((await record()).kept).toEqual(left.length?left:undefined);
  });
  // exFAT: 空の .part の ino も共通の仮の値。.part の名前は作る前に記録する（dev・ino なし）ので、先頭を書く前に落ちても残したものとして報告できる（名前だけでは消さない）
  it('a part on exFAT before its first bytes were written (the known exFAT window) is kept and reported, and the marked reservation is removed',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}],exfatEmptyInodes:true});await placeForeign();await crashAt({op:'write',match:isPart,nth:1,crash:true});
    const item=(await record()).items[0]!;expect(item.part).toEqual({name:expect.stringMatching(/^clip-1\.wav\.[a-f0-9]{16}\.harness-part$/)});
    const part=item.part!.name;expect(await files()).toEqual(['clip-1.wav',part,FOREIGN].sort());
    await nextProcess().ensureRecovered(p.project);
    expect(await files()).toEqual([part,FOREIGN].sort());expect((await stat(join(folder(),part))).size).toBe(0);await foreignIntact();
    expect(await record()).toMatchObject({state:'stopped',kept:[part]});await linkedToCard();
  });
});

describe('two processes recovering at once',()=>{
  it('skips a job another live process is recovering, and takes over once that process has ended',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    await writeFile(await guard(),JSON.stringify({pid:7777,startedAt:7}));
    await nextProcess({processAlive:pid=>pid===7777,processStartedAt:async pid=>pid===7777?7:undefined}).ensureRecovered(p.project);
    expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);expect((await record()).state).toBe('running');
    await nextProcess().ensureRecovered(p.project);expect(await files()).toEqual([]);expect(await guards()).toEqual([]);
  });
  it('takes over from a process that crashed while recovering',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});
    p.faults.push({op:'unlink',crash:true});await nextProcess().ensureRecovered(p.project);p.faults.length=0;
    expect(await guards()).toHaveLength(1);expect((await record()).state).toBe('running');
    await nextProcess({self:{pid:4343,startedAt:1}}).ensureRecovered(p.project);
    expect(await files()).toEqual([]);expect(await guards()).toEqual([]);expect(await record()).toMatchObject({state:'stopped',owner:{pid:4343}});
  });
  it('skips a job, touching nothing, when its guard cannot be made, and recovers it later',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});const made=await files(),dir=join(p.project,'.harness','copy-jobs');
    const io:CopyIo={...p.io,self:{pid:4242,startedAt:1},processAlive:()=>false};
    await chmod(dir,0o500);
    try{expect(await recoverCopyJobs(io,p.project,referenceCopyPorts)).toEqual({recovered:[],waitingVolume:[],skipped:[(await record()).jobId]});}finally{await chmod(dir,0o700);}
    expect(await files()).toEqual(made);expect((await record()).state).toBe('running');
    expect((await recoverCopyJobs(io,p.project,referenceCopyPorts)).recovered).toHaveLength(1);expect(await files()).toEqual([]);
  });
  it('treats an unreadable guard as held while it is new, and as left behind once it is old',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await crashAt({op:'write',nth:2,crash:true});const path=await guard();await writeFile(path,'');
    await nextProcess().ensureRecovered(p.project);expect((await record()).state).toBe('running');
    const old=new Date(Date.now()-10*60_000);await utimes(path,old,old);
    await nextProcess().ensureRecovered(p.project);expect(await files()).toEqual([]);expect(await guards()).toEqual([]);
  });
});

it.each([[true,['clip-1.wav']],[false,[]]] as const)('an add job that crashed while registering is decided by the ledger (ledger changed=%s)',async(changed,left)=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});
  const jobs=new MediaCopyJobs(()=>p!.io,{...referenceCopyPorts,register:async(root,copy,name)=>{if(changed)await referenceCopyPorts.register(root,copy,name);throw new SimulatedCrash('register');}},new SpaceReservations());
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:()=>undefined,stopped:()=>undefined},
    items:[{batchId:'imp-0123456789abcdef0123',batchItemId:'i0',source:p.sources[0]!,name:'clip-1.wav'}]});await jobs.idle();
  expect((await record()).items[0]!.phase).toBe('connecting');
  await nextProcess().ensureRecovered(p.project);
  expect(await files()).toEqual([...left]);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(changed?final():p.sources[0]);
  expect((await record()).items[0]).toMatchObject(changed?{phase:'done',connected:true,assetId:p.assets[0]!.id}:{phase:'cancelled'});
});
