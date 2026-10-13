// リンク素材の照合を要求から切り離して裏で最後まで続ける。
// SD カードの遅い読み（1本 145〜439 秒）を、1回の読みごとの待ちで縮小して再現する。状態確認の打ち切り 15 秒 → 150ms。
import {afterEach,expect,it,vi} from 'vitest';
/** 参照先から読まれたバイト数・先頭からの読み始めの回数・読んだ順（パスごと）。slow のパスは1回の読みごとに delayMs 待つ。
 * stuck のパスの読みは release まで返らない（カードリーダーの不調・USB の再接続待ち）。fail のパスの読みは errno 付きで失敗する。 */
const reads=vi.hoisted(()=>({bytes:new Map<string,number>(),starts:new Map<string,number>(),order:[] as string[],slow:new Set<string>(),delayMs:0,
  stuck:new Set<string>(),parked:[] as (()=>void)[],fail:new Map<string,string>(),opened:[] as string[],release(){reads.stuck.clear();for(const resume of reads.parked.splice(0))resume();}}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{reads.opened.push(String(args[0]));const handle=await actual.open(...args),read=handle.read.bind(handle) as unknown as (...x:unknown[])=>Promise<{bytesRead:number}>,key=String(args[0]);
    Object.assign(handle,{read:async(...readArgs:unknown[])=>{
      if(readArgs[3]===0)reads.starts.set(key,(reads.starts.get(key)??0)+1);
      if(reads.slow.has(key))await new Promise(resolve=>setTimeout(resolve,reads.delayMs));
      if(reads.stuck.has(key))await new Promise<void>(resume=>reads.parked.push(resume));
      if(reads.fail.has(key))throw Object.assign(new Error('読み取りに失敗しました（試験）'),{code:reads.fail.get(key)});
      const result=await read(...readArgs);reads.bytes.set(key,(reads.bytes.get(key)??0)+result.bytesRead);reads.order.push(key);return result;}});return handle;}};});
import {createHash} from 'node:crypto';
import {chmod,cp,lstat,mkdir,mkdtemp,readdir,readFile,realpath,rename,rm,stat,symlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {importSequenceAsset,openSequenceAsset,verifiedSequenceAssetPath} from './assets';
import {referenceVerificationTesting,registerSequenceReference,sequenceReferenceStatus} from './references';

const MiB=1024*1024,roots:string[]=[],STALL_MS=referenceVerificationTesting.stallMs;
afterEach(async()=>{reads.release();vi.useRealTimers();vi.restoreAllMocks();await referenceVerificationTesting.idle();referenceVerificationTesting.forget();referenceVerificationTesting.stallMs=STALL_MS;
  reads.slow.clear();reads.delayMs=0;reads.fail.clear();clear();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function clear(){reads.bytes.clear();reads.starts.clear();reads.order.length=0;reads.opened.length=0;}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** 16 ビット・モノラル・8kHz の WAV（mib MiB の標本）。 */
function wav(mib:number,seed=0){const samples=mib*MiB/2,b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE((i+seed)%100,i);return b;}
/** 案件と外付け相当の素材を作ってリンクで登録する。path は照合が開く実パス。folder は素材を置くフォルダ（カードの抜き差しの代わりにフォルダごと名前を変える）。 */
async function linked(mib:number,name='source.wav',options:{folder?:string;beforeRegister?:(project:string)=>Promise<void>}={}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'harness-reference-bg-'));roots.push(root);const project=join(root,'project'),folder=join(root,options.folder??''),source=join(folder,name);
  await mkdir(project);await mkdir(folder,{recursive:true});await writeFile(source,wav(mib));await options.beforeRegister?.(project);const asset=await registerSequenceReference(project,source);
  return {root,project,folder,source,asset,path:await realpath(source),size:(await stat(source)).size};
}
/** 中身は同じまま識別情報（mtime）だけ変える: メモリとディスクの照合記録が外れ、全体を読み直す必要がある状態（再起動後の SD カードと同じ）。 */
async function touch(path:string,seconds=5){const later=new Date(Date.now()+seconds*1000);await utimes(path,later,later);}

it('reproduction: a status check cut off before the slow read finishes no longer throws the read away — the file is read in full once and later checks answer without reading again',async()=>{
  const f=await linked(8);await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=40;   // 全体読み 9 回 × 40ms ≒ 360ms
  for(let i=0;i<4;i++)await sequenceReferenceStatus(f.project,f.asset,AbortSignal.timeout(150)).catch(()=>undefined);   // 画面の確認が毎回打ち切られる
  await sleep(800);   // 全体読み1回分より長く待つ（その間、誰も確認していない）
  const started=Date.now(),status=await sequenceReferenceStatus(f.project,f.asset),took=Date.now()-started;
  expect({state:status.state,restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({state:'ok',restarts:1,bytes:f.size});
  expect(took).toBeLessThan(200);
},20000);

it('reproduction: a preview read that joins the check and is then cancelled does not stop the check',async()=>{
  const f=await linked(4);await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=40;   // 5 回 × 40ms
  const status=sequenceReferenceStatus(f.project,f.asset,AbortSignal.timeout(100)).catch(()=>undefined);
  const preview=new AbortController(),lease=openSequenceAsset(f.project,f.asset,preview.signal);setTimeout(()=>preview.abort(new Error('再生をやめました')),120);
  await expect(lease).rejects.toThrow('再生をやめました');await status;
  await sleep(600);
  const again=await openSequenceAsset(f.project,f.asset);await again.close();
  expect({restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({restarts:1,bytes:f.size});
},20000);

/** 照合済みになるまで状態確認を繰り返す（画面の 2 秒間隔の確認の縮小版）。 */
async function settle(f:{project:string;asset:SequenceAsset},limit=40){
  let status=await sequenceReferenceStatus(f.project,f.asset);
  for(let i=0;i<limit&&status.state==='checking';i++){await sleep(100);status=await sequenceReferenceStatus(f.project,f.asset);}
  return status;
}
const recordOf=async(project:string,path:string)=>join(await realpath(project),'.harness/cache/reference-verified',createHash('sha256').update(path).digest('hex')+'.json');

it('(a) answers checking at once while a long check runs, then ok when the check behind it completes',async()=>{
  const f=await linked(2);await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=500;   // 4 回の読み × 500ms ≒ 2 秒（待つのは最大 1 秒）
  const started=Date.now(),first=await sequenceReferenceStatus(f.project,f.asset,AbortSignal.timeout(15000));
  expect(first.state).toBe('checking');expect(Date.now()-started).toBeLessThan(1500);
  expect(await settle(f)).toEqual({state:'ok'});
  expect({restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({restarts:1,bytes:f.size});
},20000);

it('(a) a small file is answered ok on the first check (no flash of checking)',async()=>{
  const f=await linked(1);await touch(f.path);clear();
  expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});expect(reads.bytes.get(f.path)).toBe(f.size);
});

it('(c) after a restart the saved record answers ok with no read — both the record left by registration and by a background check',async()=>{
  const f=await linked(2),record=await recordOf(f.project,f.path),info=await stat(f.path);
  expect(JSON.parse(await readFile(record,'utf8'))).toMatchObject({format:'harness-reference-verified',version:1,path:f.path,fingerprint:f.asset.fingerprint,
    identity:{dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs},verifiedAt:expect.any(String)});
  referenceVerificationTesting.forget();clear();
  expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});
  const lease=await openSequenceAsset(f.project,f.asset);await lease.close();
  expect(reads.bytes.get(f.path)??0).toBe(0);
  // 裏の照合が書いた記録
  await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=400;
  expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('checking');await referenceVerificationTesting.idle();
  expect(reads.bytes.get(f.path)).toBe(f.size);
  referenceVerificationTesting.forget();clear();
  expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});expect(reads.bytes.get(f.path)??0).toBe(0);
  expect((await readdir(dirname(record))).filter(name=>name.endsWith('.tmp'))).toEqual([]);
},20000);

it('(d) a saved record is used only for the exact path, fingerprint and file identity: a changed mtime, an edited record, a link or an oversized record are checked again',async()=>{
  const f=await linked(1),record=await recordOf(f.project,f.path),saved=JSON.parse(await readFile(record,'utf8'));
  const fresh=async()=>{referenceVerificationTesting.forget();clear();expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});return reads.bytes.get(f.path)??0;};
  await touch(f.path);expect(await fresh()).toBe(f.size);   // 識別情報が変わった（記録は新しい識別情報で書き直される）
  expect(await fresh()).toBe(0);
  const current=JSON.parse(await readFile(record,'utf8'));expect(current.identity.mtimeMs).not.toBe(saved.identity.mtimeMs);
  for(const edit of [{fingerprint:'0'.repeat(64)},{path:f.path+'x'},{identity:{...current.identity,ctimeMs:current.identity.ctimeMs+1}},{identity:{...current.identity,dev:current.identity.dev+1}},{extra:true}]){
    await writeFile(record,JSON.stringify({...current,...edit}));expect(await fresh(),JSON.stringify(edit)).toBe(f.size);
  }
  const elsewhere=join(f.root,'copied-record.json');await writeFile(elsewhere,await readFile(record));await rm(record);await symlink(elsewhere,record);
  expect(await fresh()).toBe(f.size);   // リンクはたどらない（書き直しはリンクを置き換える）
  expect((await lstat(record)).isSymbolicLink()).toBe(false);expect(await fresh()).toBe(0);
  await writeFile(record,JSON.stringify({...JSON.parse(await readFile(record,'utf8')),verifiedAt:'x'.repeat(70*1024)}));expect(await fresh()).toBe(f.size);
});

it('(e) different content answers mismatch and is not read again for the same file identity; a new identity is checked again',async()=>{
  const f=await linked(2);await writeFile(f.path,wav(2,1));clear();   // 大きさは同じ・中身が違う（識別情報も変わる）
  expect((await settle(f)).state).toBe('mismatch');expect(reads.bytes.get(f.path)).toBe(f.size);
  for(let i=0;i<3;i++)expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('mismatch');
  await expect(openSequenceAsset(f.project,f.asset)).rejects.toThrow('参照素材の内容が保存時と一致しません');
  expect({restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({restarts:1,bytes:f.size});
  await touch(f.path,9);expect((await settle(f)).state).toBe('mismatch');expect(reads.bytes.get(f.path)).toBe(2*f.size);
  await writeFile(f.path,wav(2));expect(await settle(f)).toEqual({state:'ok'});
  // 大きさが違うファイルは全体を読まずに断る
  await writeFile(f.path,wav(1));clear();expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('mismatch');expect(reads.bytes.get(f.path)??0).toBe(0);
},20000);

it('(f) runs one background check at a time: two unchecked files are read one after the other, the queued one answers checking without waiting',async()=>{
  const a=await linked(2,'a.wav'),b=await linked(2,'b.wav');await touch(a.path);await touch(b.path);clear();
  for(const f of [a,b])reads.slow.add(f.path);reads.delayMs=100;
  const [first,second]=await Promise.all([sequenceReferenceStatus(a.project,a.asset),(async()=>{await sleep(20);const started=Date.now();const status=await sequenceReferenceStatus(b.project,b.asset);return {...status,took:Date.now()-started};})()]);
  expect(first.state).toBe('ok');expect(second).toMatchObject({state:'checking'});expect(second.took).toBeLessThan(300);
  await referenceVerificationTesting.idle();
  const order=reads.order.filter(path=>path===a.path||path===b.path).filter((path,i,all)=>i===0||all[i-1]!==path);
  expect(order).toEqual([a.path,b.path]);
  expect(await sequenceReferenceStatus(b.project,b.asset)).toEqual({state:'ok'});expect(reads.bytes.get(b.path)).toBe(b.size);
},20000);

it('(g) other read paths join the running check; cancelling them does not stop it, and a waiting read path moves its file to the front of the queue',async()=>{
  const a=await linked(2,'a.wav'),b=await linked(2,'b.wav'),c=await linked(2,'c.wav');for(const f of [a,b,c]){await touch(f.path);reads.slow.add(f.path);}clear();reads.delayMs=80;
  const joinedBefore=referenceVerificationTesting.joined;
  expect((await sequenceReferenceStatus(a.project,a.asset,AbortSignal.timeout(50)).catch(error=>error.name))).toBe('TimeoutError');   // a が走る
  expect((await sequenceReferenceStatus(b.project,b.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(c.project,c.asset)).state).toBe('checking');   // b, c の順に待つ
  const cancelled=new AbortController(),dropped=openSequenceAsset(a.project,a.asset,cancelled.signal);
  const waiting=Promise.all([openSequenceAsset(a.project,a.asset),openSequenceAsset(c.project,c.asset)]);   // 再生が待つ c は b より先に照合される
  cancelled.abort(new Error('再生をやめました'));await expect(dropped).rejects.toThrow('再生をやめました');
  for(const lease of await waiting)await lease.close();
  expect(referenceVerificationTesting.joined-joinedBefore).toBeGreaterThanOrEqual(3);
  await referenceVerificationTesting.idle();
  const order=reads.order.filter(path=>[a.path,b.path,c.path].includes(path)).filter((path,i,all)=>i===0||all[i-1]!==path);
  expect(order).toEqual([a.path,c.path,b.path]);
  for(const f of [a,b,c])expect({restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({restarts:1,bytes:f.size});
},20000);

it('the test-only digest delay slows only when set',async()=>{
  const f=await linked(2);await touch(f.path);vi.stubEnv('HARNESS_TEST_DIGEST_DELAY_MS','150');
  try{const started=Date.now();expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('ok');expect(Date.now()-started).toBeGreaterThanOrEqual(300);}
  finally{vi.unstubAllEnvs();}
});

/** 時計だけ進める（失敗の記憶・最後に問われた時刻）。読みの待ちと見張りのタイマーは本物のまま。 */
function advanceClock(ms:number){if(!vi.isFakeTimers())vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+ms);}
const withTimeout=<T,>(work:Promise<T>,ms:number)=>Promise.race([work,sleep(ms).then(()=>'timed out' as const)]);

it('(I-1) a read that stops making progress is given up after the stall limit as a temporary failure: the queue moves on, and the file is checked again later',async()=>{
  referenceVerificationTesting.stallMs=300;
  const a=await linked(2,'a.wav'),b=await linked(1,'b.wav');await touch(a.path);await touch(b.path);clear();reads.stuck.add(a.path);
  const first=sequenceReferenceStatus(a.project,a.asset);await sleep(30);   // a の読みが止まる
  expect((await sequenceReferenceStatus(b.project,b.asset)).state).toBe('checking');   // b は a の後ろで待つ
  const preview=openSequenceAsset(b.project,b.asset);   // b の再生が待つ
  const lease=await withTimeout(preview,5000);expect(lease).not.toBe('timed out');if(lease!=='timed out')await lease.close();   // a が止まったままでも b は照合される
  expect((await first).state).toBe('invalid');
  const later=await sequenceReferenceStatus(a.project,a.asset);   // 一時的な失敗として覚えていて、読み直さない
  expect(later).toMatchObject({state:'invalid',message:expect.stringContaining('読み取れません')});expect(reads.starts.get(a.path)).toBe(1);
  reads.release();advanceClock(31_000);   // 30 秒たてば照合し直す
  expect(await settle(a)).toEqual({state:'ok'});expect(reads.starts.get(a.path)).toBe(2);
},20000);

it('(M1) never reads or writes verification records through a linked .harness/cache or reference-verified folder',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  for(const linkAt of ['.harness/cache','.harness/cache/reference-verified']){
    const f=await linked(1),place=join(await realpath(f.project),linkAt),outside=join(f.root,'outside');
    await cp(place,outside,{recursive:true});await rm(place,{recursive:true});await symlink(outside,place);   // 外のフォルダには今の識別情報で正しい記録がある
    const snapshot=async()=>{const files=await readdir(outside,{recursive:true});return Promise.all(files.sort().map(async name=>[name,(await lstat(join(outside,name))).isFile()?await readFile(join(outside,name),'utf8'):'dir']));};
    const before=await snapshot();referenceVerificationTesting.forget();clear();warn.mockClear();
    expect(await sequenceReferenceStatus(f.project,f.asset),linkAt).toEqual({state:'ok'});
    expect(reads.bytes.get(f.path),linkAt).toBe(f.size);   // 記録を信じず読み直した
    expect(await snapshot(),linkAt).toEqual(before);expect(warn,linkAt).toHaveBeenCalled();   // 外へは書かず、書けなかったことを知らせた
  }
},20000);

it('(M3) a file that went missing during the queue wait is not remembered as a failure: once the card is back, the next check starts the check',async()=>{
  const b=await linked(2,'b.wav'),a=await linked(1,'a.wav',{folder:'card'});await touch(a.path);await touch(b.path);clear();reads.slow.add(b.path);reads.delayMs=150;
  const running=sequenceReferenceStatus(b.project,b.asset);await sleep(30);
  expect((await sequenceReferenceStatus(a.project,a.asset)).state).toBe('checking');   // b の後ろで待つ
  const away=a.folder+'-away';await rename(a.folder,away);   // カードを抜く（ファイルの識別情報は変わらない）
  await running;await referenceVerificationTesting.idle();   // a の照合は「ファイルが無い」で失敗した
  expect((await sequenceReferenceStatus(a.project,a.asset)).state).toBe('missing');
  await rename(away,a.folder);   // 挿し直す
  expect(await sequenceReferenceStatus(a.project,a.asset)).toEqual({state:'ok'});expect(reads.bytes.get(a.path)).toBe(a.size);
},20000);

it('(M4) a read error is remembered for 30 seconds only, then the file is checked again',async()=>{
  const f=await linked(1);await touch(f.path);clear();reads.fail.set(f.path,'EIO');
  expect(await sequenceReferenceStatus(f.project,f.asset)).toMatchObject({state:'invalid',message:expect.stringContaining('読み取れません')});
  reads.fail.clear();expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('invalid');expect(reads.starts.get(f.path)).toBe(1);
  advanceClock(29_000);expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('invalid');expect(reads.starts.get(f.path)).toBe(1);
  vi.setSystemTime(Date.now()+2_000);expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});expect(reads.starts.get(f.path)).toBe(2);
});

it('(m-1) drops a queued check nobody has asked about for 3 minutes (a closed project), but keeps one a read path is waiting for',async()=>{
  const a=await linked(2,'a.wav'),b=await linked(1,'b.wav'),c=await linked(1,'c.wav'),d=await linked(1,'d.wav');
  for(const f of [a,b,c,d])await touch(f.path);clear();reads.slow.add(a.path);reads.delayMs=200;
  const running=sequenceReferenceStatus(a.project,a.asset);await sleep(30);
  expect((await sequenceReferenceStatus(b.project,b.asset)).state).toBe('checking');   // 前の案件で問われたきり
  const preview=openSequenceAsset(d.project,d.asset);await sleep(100);   // 再生が待ち続けている（照合の組ができてから時計を進める）
  advanceClock(181_000);
  expect((await sequenceReferenceStatus(c.project,c.asset)).state).toBe('checking');   // 今の案件
  await running;(await preview).close();await referenceVerificationTesting.idle();
  const order=reads.order.filter(path=>[a.path,b.path,c.path,d.path].includes(path)).filter((path,i,all)=>i===0||all[i-1]!==path);
  expect(order).toEqual([a.path,d.path,c.path]);expect(reads.bytes.get(b.path)??0).toBe(0);
  expect(await sequenceReferenceStatus(b.project,b.asset)).toEqual({state:'ok'});expect(reads.bytes.get(b.path)).toBe(b.size);   // また問われれば照合する
},20000);

it('(m-5) a record that could not be written is written on a later check',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  const f=await linked(1,'source.wav',{beforeRegister:async project=>{await mkdir(join(project,'.harness'));await writeFile(join(project,'.harness/cache'),'not a folder');}});
  expect(warn).toHaveBeenCalled();const record=await recordOf(f.project,f.path);
  await rm(join(f.project,'.harness/cache'));advanceClock(61_000);   // 書き直しは 60 秒に1回
  expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});
  expect(JSON.parse(await readFile(record,'utf8'))).toMatchObject({path:f.path,fingerprint:f.asset.fingerprint});
});

it('(m-A) a project that cannot store records is retried at most once a minute, and warned about once',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined),folder=(project:string)=>join(project,'.harness/cache/reference-verified');
  const f=await linked(1,'source.wav',{beforeRegister:async project=>{await mkdir(folder(project),{recursive:true});await chmod(folder(project),0o500);}});   // 書き込めないフォルダ
  const attempts=()=>reads.opened.filter(path=>path.startsWith(folder(f.project))&&path.endsWith('.tmp')).length;
  try{
    expect(attempts()).toBe(1);expect(warn).toHaveBeenCalledTimes(1);
    for(let i=0;i<3;i++)expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});
    expect(attempts()).toBe(1);expect(warn).toHaveBeenCalledTimes(1);
    advanceClock(61_000);expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});
    expect(attempts()).toBe(2);expect(warn).toHaveBeenCalledTimes(1);
    await chmod(folder(f.project),0o700);advanceClock(61_000);expect(await sequenceReferenceStatus(f.project,f.asset)).toEqual({state:'ok'});
    expect(attempts()).toBe(3);expect(await readdir(folder(f.project))).toHaveLength(1);
  }finally{await chmod(folder(f.project),0o700);}
});

it('(I-A) retrying a file whose earlier read is still stuck does not start another read: only one stuck read at a time',async()=>{
  referenceVerificationTesting.stallMs=200;
  const f=await linked(1);await touch(f.path);clear();reads.stuck.add(f.path);
  for(let round=0;round<4;round++){
    expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('invalid');   // 見張りが切り上げる（2周目からは読みを始めずに）
    advanceClock(31_000);
  }
  expect(reads.parked).toHaveLength(1);expect(reads.starts.get(f.path)).toBe(1);
  reads.release();await sleep(50);advanceClock(31_000);   // 止まっていた読みが戻れば照合できる
  expect(await settle(f)).toEqual({state:'ok'});expect(reads.starts.get(f.path)).toBe(2);
},20000);

it('(W2) a check longer than the stall limit in total is not given up while each read keeps making progress',async()=>{
  referenceVerificationTesting.stallMs=300;
  const f=await linked(4);await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=100;   // 6 回 × 100ms ≒ 600ms（見張り 300ms の 2 倍）
  expect(await settle(f)).toEqual({state:'ok'});expect({restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({restarts:1,bytes:f.size});
},20000);

it('(D3) a queued check that keeps being asked about is not dropped, however long it waits in total',async()=>{
  const a=await linked(2,'a.wav'),b=await linked(1,'b.wav');for(const f of [a,b])await touch(f.path);clear();reads.slow.add(a.path);reads.delayMs=200;
  const running=sequenceReferenceStatus(a.project,a.asset);await sleep(30);
  expect((await sequenceReferenceStatus(b.project,b.asset)).state).toBe('checking');
  advanceClock(120_000);expect((await sequenceReferenceStatus(b.project,b.asset)).state).toBe('checking');   // 3 分未満の間隔で問い続ける
  advanceClock(120_000);   // 作られてから 4 分・最後に問われてから 2 分
  await running;await referenceVerificationTesting.idle();
  expect(reads.order.filter(path=>path===a.path||path===b.path).filter((path,i,all)=>i===0||all[i-1]!==path)).toEqual([a.path,b.path]);
  expect(await sequenceReferenceStatus(b.project,b.asset)).toEqual({state:'ok'});
},20000);

it('(m-6) the test-only digest delay is ignored outside the test runner',async()=>{
  const f=await linked(2);await touch(f.path);vi.stubEnv('HARNESS_TEST_DIGEST_DELAY_MS','2000');vi.stubEnv('VITEST','');
  try{const started=Date.now();expect((await sequenceReferenceStatus(f.project,f.asset)).state).toBe('ok');expect(Date.now()-started).toBeLessThan(1500);}
  finally{vi.unstubAllEnvs();}
});

/** 別の案件の管理素材をリンクで参照する（同じ実ファイルを、管理素材の照合と参照の照合の両方が読む）。 */
async function managedAndLinked(mib:number){
  const root=await mkdtemp(join(await realpath(tmpdir()),'harness-reference-bg-'));roots.push(root);const managed=join(root,'managed'),project=join(root,'project'),source=join(root,'in.wav');
  await mkdir(managed);await mkdir(project);await writeFile(source,wav(mib));
  const asset=await importSequenceAsset(managed,source,'in.wav'),path=await realpath(join(managed,asset.file));
  return {managed,asset,project,linked:await registerSequenceReference(project,path),path,size:(await stat(path)).size};
}
it('(P2) joins a healthy read of the same file another path is already making, and its progress keeps the watchdog quiet: one read, ok',async()=>{
  referenceVerificationTesting.stallMs=300;
  const f=await managedAndLinked(4);await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=100;   // 6 回 × 100ms（見張り 300ms より長い）
  const managedCheck=verifiedSequenceAssetPath(f.managed,f.asset);await sleep(50);   // 管理素材の照合が読み進めている
  expect(await settle({project:f.project,asset:f.linked})).toEqual({state:'ok'});await managedCheck;
  expect({restarts:reads.starts.get(f.path),bytes:reads.bytes.get(f.path)}).toEqual({restarts:1,bytes:f.size});
},20000);
it('(P2) a read its own caller cancelled moments ago is not taken for a stuck read: the check reads afresh and is ok',async()=>{
  const f=await managedAndLinked(4);await touch(f.path);clear();reads.slow.add(f.path);reads.delayMs=100;
  const cancel=new AbortController(),managedCheck=verifiedSequenceAssetPath(f.managed,f.asset,cancel.signal).catch(error=>error);await sleep(150);
  cancel.abort(new Error('やめました'));expect(await managedCheck).toEqual(new Error('やめました'));   // 待ち手が去った読みは次の 1MiB で終わる
  expect(await settle({project:f.project,asset:f.linked})).toEqual({state:'ok'});expect(reads.starts.get(f.path)).toBe(2);
},20000);
