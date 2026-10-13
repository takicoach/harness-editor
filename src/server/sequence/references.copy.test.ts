// コピーの作業が照合した実体（完成ファイル）を受け取って登録・つなぎ直しをする（設計 §5-6・7、裁定 #3・#8）。
// 全体を読み直さない。受け渡しは照合を省く旗ではない（copyOneItem が照合した組で、開いた実体の識別情報も同じ時だけ信じ、違えば全体を読む）。
// 別の操作のつなぎ直しを上書きしない。接続を変えた後の確認の失敗は「結果不明」として台帳で判定できる。
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,readdir,readFile,realpath,rename,stat,symlink,unlink,utimes,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {ReferenceConnectUnknown,ReferenceGenerationChanged,reconnectSequenceReference,reconnectSequenceReferenceVerified,referenceConnection,referenceTarget,referenceVerificationTesting,
  registerSequenceReference,registerSequenceReferenceVerified,sequenceReferenceStatus,type VerifiedCopy} from './references';
import {copyOneItem,type CopiedFile,type CopyItemHooks} from './mediaCopy/copyItem';
import {COPY_ROOT_NAME,ensureCopyFolder,listVolumes,type CopyFolder} from './mediaCopy/volumes';
import {copyWorld,type CopyWorld} from './mediaCopy/__fixtures__/copyWorld';
import {wav} from './mediaCopy/__fixtures__/copyProject';

/** 試験だけ: 名前（書き先）が合う unlink・link・symlink を code で失敗させる（times 回まで。省くとずっと）。確定の前後の失敗・入口のロックの競合を再現する。 */
/** afterLockLstat・afterLockStat: ロックの記録（.mutation-lock）の lstat の直後・開いた記録の1回目の stat の直後に1回だけ呼ぶ（読む間に持ち主が消す・差し替える競合を決定的に再現する）。 */
const fsFaults=vi.hoisted(()=>({list:[] as {op:'unlink'|'link'|'symlink';path:RegExp;code:string;times?:number}[],
  afterLockLstat:undefined as undefined|(()=>Promise<unknown>),afterLockStat:undefined as undefined|(()=>Promise<unknown>),afterLockStatUses:1}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();
  const faulted=(op:string,path:unknown)=>{const fault=fsFaults.list.find(item=>item.op===op&&item.path.test(String(path))&&(item.times===undefined||item.times>0));if(!fault)return undefined;
    if(fault.times!==undefined)fault.times--;return Promise.reject(Object.assign(new Error(`試験: ${op} できません`),{code:fault.code}));};
  return {...actual,unlink:(path:Parameters<typeof actual.unlink>[0])=>faulted('unlink',path)??actual.unlink(path),
    link:(from:Parameters<typeof actual.link>[0],to:Parameters<typeof actual.link>[1])=>faulted('link',to)??actual.link(from,to),
    symlink:(target:Parameters<typeof actual.symlink>[0],path:Parameters<typeof actual.symlink>[1])=>faulted('symlink',path)??actual.symlink(target,path),
    lstat:(async(...args:Parameters<typeof actual.lstat>)=>{const result=await actual.lstat(...args),hook=fsFaults.afterLockLstat;
      if(hook&&/\/\.mutation-lock$/.test(String(args[0]))){fsFaults.afterLockLstat=undefined;await hook();}return result;}) as typeof actual.lstat,
    open:(async(...args:Parameters<typeof actual.open>)=>{const handle=await actual.open(...args),hook=fsFaults.afterLockStat;
      if(hook&&/\/\.mutation-lock$/.test(String(args[0]))){if(--fsFaults.afterLockStatUses<=0)fsFaults.afterLockStat=undefined;const original=handle.stat.bind(handle) as (...options:unknown[])=>Promise<unknown>;let calls=0;
        Object.assign(handle,{stat:async(...options:unknown[])=>{const result=await original(...options);if(++calls===1)await hook();return result;}});}
      return handle;}) as typeof actual.open};});
const LEAF=/\/\.harness\/references\/[a-f0-9]{64}\.wav$/,LOCK=/\/\.mutation-lock$/;
let world:CopyWorld,folder:CopyFolder,project='';
beforeEach(async()=>{world=await copyWorld();project=join(world.root,'project');await mkdir(project);
  folder=await ensureCopyFolder(world.io,(await listVolumes(world.io)).find(volume=>volume.uuid==='SSD')!,world.ssd,[COPY_ROOT_NAME,'案件-12345678']);});
afterEach(async()=>{fsFaults.list=[];fsFaults.afterLockLstat=undefined;fsFaults.afterLockStat=undefined;fsFaults.afterLockStatUses=1;referenceVerificationTesting.afterConnect=undefined;await referenceVerificationTesting.idle();referenceVerificationTesting.forget();await world.cleanup();});
const hooks=():CopyItemHooks=>({signal:new AbortController().signal,phase:async()=>undefined,progress:async()=>undefined});
/** 作業（jobs.ts）と同じく、コピーの結果から受け渡しの値を新しく組む。 */
const handoff=(copied:CopiedFile):VerifiedCopy=>({path:copied.path,fingerprint:copied.fingerprint,identity:copied.identity});
/** 外から作った受け渡し（copyOneItem が照合していない値）。識別情報は本物でも、全体を読まずには信じない。 */
const handMade=async(path:string,fingerprint?:string):Promise<VerifiedCopy>=>{const info=await stat(path);
  return {path,fingerprint:fingerprint??createHash('sha256').update(await readFile(path)).digest('hex'),identity:{dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs}};};
const referenceFile=(fingerprint:string)=>`.harness/references/${fingerprint}.wav`;
/** SD の素材を登録し、開いた時のコピー（期待する指紋つき）で速いドライブへコピーする。 */
async function linkedCopy(){
  const source=join(world.sd,'clip.wav');await writeFile(source,wav(4));const asset=await registerSequenceReference(project,source);
  const copied=await copyOneItem(world.io,{path:source,expectedFingerprint:asset.fingerprint},{folder,name:'clip.wav'},hooks());
  return {source,asset,copy:handoff(copied)};
}

it('reconnects to the copy that copyOneItem verified without reading it again, and remembers it across a restart',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),reads=referenceVerificationTesting.fullReads;
  await reconnectSequenceReferenceVerified(project,asset,copy,generation);
  expect(await referenceTarget(project,asset.file)).toBe(copy.path);expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});
  expect(referenceVerificationTesting.fullReads).toBe(reads);
  // 再起動（メモリの記憶を消す）の後も、案件の照合記録で読み直さない
  referenceVerificationTesting.forget();expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});expect(referenceVerificationTesting.fullReads).toBe(0);
});
it('does not overwrite a reconnection made by another operation in between (generation)',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),other=join(world.root,'other.wav');await copyFile(copy.path,other);
  await reconnectSequenceReference(project,asset,other);
  await expect(reconnectSequenceReferenceVerified(project,asset,copy,generation)).rejects.toBeInstanceOf(ReferenceGenerationChanged);
  expect(await referenceTarget(project,asset.file)).toBe(other);
});
it('reads the whole copy again when it was touched after the copy verified it, and connects when the content still matches',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),reads=referenceVerificationTesting.fullReads;
  const later=new Date(Date.now()+5000);await utimes(copy.path,later,later);
  await reconnectSequenceReferenceVerified(project,asset,copy,generation);
  expect(referenceVerificationTesting.fullReads).toBe(reads+1);expect(await referenceTarget(project,asset.file)).toBe(copy.path);
  expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});expect(referenceVerificationTesting.fullReads).toBe(reads+1);
});
it('refuses a copy whose content changed after it was verified and keeps the old connection',async()=>{
  const {source,asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),reads=referenceVerificationTesting.fullReads;
  await writeFile(copy.path,wav(4,7));   // 同じ大きさで中身だけ違う
  await expect(reconnectSequenceReferenceVerified(project,asset,copy,generation)).rejects.toThrow('一致しません');
  expect(referenceVerificationTesting.fullReads).toBe(reads+1);expect(await referenceTarget(project,asset.file)).toBe(source);
});
it('never trusts a hand-made handoff: a false fingerprint is read and refused, a true one is read once before connecting',async()=>{
  const {source,asset}=await linkedCopy(),{generation}=await referenceConnection(project,asset);
  const imposter=join(world.ssd,'imposter.wav');await writeFile(imposter,wav(4,9));let reads=referenceVerificationTesting.fullReads;
  await expect(reconnectSequenceReferenceVerified(project,asset,await handMade(imposter,asset.fingerprint),generation)).rejects.toThrow('一致しません');
  expect(referenceVerificationTesting.fullReads).toBe(reads+1);expect(await referenceTarget(project,asset.file)).toBe(source);expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});
  const manual=join(world.ssd,'manual.wav');await copyFile(source,manual);reads=referenceVerificationTesting.fullReads;
  await reconnectSequenceReferenceVerified(project,asset,await handMade(manual),generation);
  expect(referenceVerificationTesting.fullReads).toBe(reads+1);expect(await referenceTarget(project,asset.file)).toBe(manual);
});
it('reports an unknown result when the last check fails after the ledger changed; the ledger points at the copy',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset);
  referenceVerificationTesting.afterConnect=()=>writeFile(copy.path,'tampered');
  await expect(reconnectSequenceReferenceVerified(project,asset,copy,generation)).rejects.toBeInstanceOf(ReferenceConnectUnknown);
  expect(await referenceTarget(project,asset.file)).toBe(copy.path);
});
it('reports an unknown result when another operation moved the ledger before the last check; the ledger tells it is not the copy',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),other=join(world.root,'other.wav');await copyFile(copy.path,other);
  referenceVerificationTesting.afterConnect=async()=>{await reconnectSequenceReference(project,asset,other);await writeFile(other,'tampered');};
  await expect(reconnectSequenceReferenceVerified(project,asset,copy,generation)).rejects.toBeInstanceOf(ReferenceConnectUnknown);
  expect(await referenceTarget(project,asset.file)).toBe(other);
});
it('reports an unknown result when a failure comes after the new connection is fixed (it is not rolled back); the ledger points at the copy after recovery',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset);
  fsFaults.list=[{op:'unlink',path:/\/\.previous-[^/]*$/,code:'EACCES'}];   // 確定の後、退避した元のリンクを消せない
  await expect(reconnectSequenceReferenceVerified(project,asset,copy,generation)).rejects.toBeInstanceOf(ReferenceConnectUnknown);
  fsFaults.list=[];expect(await referenceTarget(project,asset.file)).toBe(copy.path);
});
/** 台帳の記録を直接読む（ロックが残っていても読める）。 */
const recordedTarget=async(file:string)=>(JSON.parse(await readFile(join(project,'.harness','references',basename(file)+'.json'),'utf8')) as {target:string}).target;
it('reports an unknown result when restoring the old connection fails before the new one is fixed (incomplete); the ledger is restored by recovery',async()=>{
  const {source,asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset);
  fsFaults.list=[{op:'symlink',path:LEAF,code:'EACCES'}];   // 新しいリンクも、元へ戻すリンクも作れない
  await expect(reconnectSequenceReferenceVerified(project,asset,copy,generation)).rejects.toBeInstanceOf(ReferenceConnectUnknown);
  fsFaults.list=[];expect(await referenceTarget(project,asset.file)).toBe(source);
});
it('reports an unknown result when a failure that is not incomplete comes after the reconnection is fixed (the lock cannot be removed)',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset);
  fsFaults.list=[{op:'unlink',path:LOCK,code:'EACCES',times:1}];
  const failure=await reconnectSequenceReferenceVerified(project,asset,copy,generation).then(()=>undefined,(e:unknown)=>e);
  expect(failure).toBeInstanceOf(ReferenceConnectUnknown);expect(((failure as Error).cause as {incomplete?:boolean}).incomplete).toBeUndefined();
  expect(await recordedTarget(asset.file)).toBe(copy.path);
});
it('reports an unknown result when a failure that is not incomplete comes after a new registration is fixed (the lock cannot be removed)',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  fsFaults.list=[{op:'unlink',path:LOCK,code:'EACCES',times:1}];
  await expect(registerSequenceReferenceVerified(project,handoff(copied),'new.wav')).rejects.toBeInstanceOf(ReferenceConnectUnknown);
  expect(await recordedTarget(referenceFile(copied.fingerprint))).toBe(copied.path);
});
it('reports a plain failure (not unknown) when a new registration fails before it is fixed, and registers nothing',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  fsFaults.list=[{op:'symlink',path:LEAF,code:'EACCES',times:1}];
  const failure=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav').then(()=>undefined,(e:unknown)=>e);
  expect(failure).toBeInstanceOf(Error);expect(failure).not.toBeInstanceOf(ReferenceConnectUnknown);expect((failure as NodeJS.ErrnoException).code).toBe('EACCES');
  expect(await referenceTarget(project,referenceFile(copied.fingerprint))).toBeUndefined();
});
const lockFile=()=>join(project,'.harness','references','.mutation-lock');
const ownJournal=()=>JSON.stringify({format:'harness-reference-mutation',version:1,pid:process.pid,startedAt:Date.now(),token:randomUUID()})+'\n';
/** 同じプロセスの別の接続の変更を、ロックの記録で再現する（releaseMs 後に終わる。省くと終わらない＝試験の注入が消す。既定値は置かない: undefined を渡すと既定値になり、隠れたタイマーが後のロックを消す）。 */
async function holdLock(releaseMs?:number){
  const lock=lockFile(),state={released:false};await writeFile(lock,ownJournal());
  if(releaseMs!==undefined)setTimeout(()=>{state.released=true;void unlink(lock).catch(()=>undefined);},releaseMs);return state;
}
/** 持ち主が記録を読まれている間に変更を終える（ロックを消す）。 */
const finishChange=(fired:{count:number})=>async()=>{fired.count++;await unlink(lockFile());};
it('waits for a change running in this process to finish before reconnecting, then succeeds (an import in parallel does not fail the copy)',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),held=await holdLock(200);
  await reconnectSequenceReferenceVerified(project,asset,copy,generation);
  expect(held.released).toBe(true);expect(await referenceTarget(project,asset.file)).toBe(copy.path);
});
it('waits for a change running in this process to finish before registering, then succeeds',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  await mkdir(join(project,'.harness','references'),{recursive:true});const held=await holdLock(200);
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav');
  expect(held.released).toBe(true);expect(result.branch).toBe('registered');expect(await referenceTarget(project,result.asset.file)).toBe(copied.path);
});
it('retries when another change takes the lock between the check and taking it, then succeeds',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset);
  fsFaults.list=[{op:'link',path:LOCK,code:'EEXIST',times:1}];
  await reconnectSequenceReferenceVerified(project,asset,copy,generation);
  expect(fsFaults.list[0]!.times).toBe(0);expect(await referenceTarget(project,asset.file)).toBe(copy.path);
});
// 読む間の競合（全体実行で1回だけ落ちた原因）: 持ち主が記録を消すと、開いた記録の ctime も変わる（APFS で実測: nlink 1→0 で ctime が進む）。
// 2回の stat の間に消える・差し替わると「所有者記録が更新中です」、lstat の後・開く前に消えると ENOENT になり、待ってやり直す経路に乗らなかった。
it('registers when the change in this process finishes between the two reads of its record (the record is removed in between)',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  await mkdir(join(project,'.harness','references'),{recursive:true});await holdLock();const fired={count:0};fsFaults.afterLockStat=finishChange(fired);
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav');
  expect(fired.count).toBe(1);expect(result.branch).toBe('registered');expect(await referenceTarget(project,result.asset.file)).toBe(copied.path);
});
it('registers when the change in this process rewrites its record between the two reads, then finishes',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  await mkdir(join(project,'.harness','references'),{recursive:true});await holdLock();const state={rewritten:false,released:false};
  fsFaults.afterLockStat=async()=>{const temporary=lockFile()+'.rewrite';await writeFile(temporary,ownJournal());await rename(temporary,lockFile());state.rewritten=true;   // 持ち主が記録を書き換える（rename で差し替え）
    setTimeout(()=>{state.released=true;void unlink(lockFile()).catch(()=>undefined);},150);};
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav');
  expect(state).toEqual({rewritten:true,released:true});expect(result.branch).toBe('registered');
});
it('registers when the change in this process finishes between finding its record and opening it',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  await mkdir(join(project,'.harness','references'),{recursive:true});await holdLock();const fired={count:0};fsFaults.afterLockLstat=finishChange(fired);
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav');
  expect(fired.count).toBe(1);expect(result.branch).toBe('registered');
});
it('keeps waiting when the record keeps changing through every re-read (treated as busy), then registers after the change finishes',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  await mkdir(join(project,'.harness','references'),{recursive:true});await holdLock();const state={rewrites:0,released:false};
  fsFaults.afterLockStatUses=5;   // 読み直し5回のどれでも、読む間に持ち主が記録を書き換える。最後に書き換えた100ms後に変更を終える
  fsFaults.afterLockStat=async()=>{const temporary=lockFile()+'.rewrite';await writeFile(temporary,ownJournal());await rename(temporary,lockFile());
    if(++state.rewrites===5)setTimeout(()=>{state.released=true;void unlink(lockFile()).catch(()=>undefined);},100);};
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav');
  expect(state).toEqual({rewrites:5,released:true});expect(result.branch).toBe('registered');
});
it('the same race does not fail the usual paths either: a status check and a plain registration',async()=>{
  const {asset}=await linkedCopy();await holdLock();const fired={count:0};fsFaults.afterLockStat=finishChange(fired);
  expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});expect(fired.count).toBe(1);
  await holdLock();fsFaults.afterLockLstat=finishChange(fired);
  const other=join(world.sd,'other.wav');await writeFile(other,wav(4,5));const registered=await registerSequenceReference(project,other);
  expect(fired.count).toBe(2);expect(await referenceTarget(project,registered.file)).toBe(other);
});
it('refuses a handoff whose path goes through a link on the way, and keeps the old connection',async()=>{
  const {source,asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset),via=join(world.root,'via');await symlink(folder.path,via);
  await expect(reconnectSequenceReferenceVerified(project,asset,{...copy,path:join(via,basename(copy.path))},generation)).rejects.toThrow('場所が変わりました');
  expect(await referenceTarget(project,asset.file)).toBe(source);
});
it('accepts a handoff spelled in NFC when the folder is stored in NFD on disk, without reading it again',async()=>{
  const nfc='が案件-12345678'.normalize('NFC'),nfd=nfc.normalize('NFD'),root=join(world.ssd,COPY_ROOT_NAME);await mkdir(join(root,nfd));
  const nfcFolder=await ensureCopyFolder(world.io,(await listVolumes(world.io)).find(volume=>volume.uuid==='SSD')!,world.ssd,[COPY_ROOT_NAME,nfc]);
  // 存在検査: ファイルシステムは正規化を区別せず（NFC の名前で同じフォルダーに届く）、ディスク上は NFD のまま、実パスの解決は NFD を返す（誤って断る条件が実際にある）
  expect(nfcFolder.path).toBe(join(root,nfc));expect((await readdir(root)).filter(name=>name.startsWith('が'.normalize('NFD')))).toEqual([nfd]);
  expect(await realpath(nfcFolder.path)).toBe(join(root,nfd));
  const source=join(world.sd,'clip.wav');await writeFile(source,wav(4));const asset=await registerSequenceReference(project,source);
  const copied=await copyOneItem(world.io,{path:source,expectedFingerprint:asset.fingerprint},{folder:nfcFolder,name:'clip.wav'},hooks());
  expect(copied.path).toBe(join(root,nfc,'clip.wav'));
  const {generation}=await referenceConnection(project,asset),reads=referenceVerificationTesting.fullReads;
  await reconnectSequenceReferenceVerified(project,asset,handoff(copied),generation);
  const target=await referenceTarget(project,asset.file);expect(target).toBe(join(root,nfd,'clip.wav'));expect(target?.normalize('NFC')).toBe(copied.path);
  expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});expect(referenceVerificationTesting.fullReads).toBe(reads);
});
it('reads the ledger after a change running in this process finishes, not in the middle of it',async()=>{
  const {asset,copy}=await linkedCopy(),{generation}=await referenceConnection(project,asset);await reconnectSequenceReferenceVerified(project,asset,copy,generation);
  const lock=join(project,'.harness','references','.mutation-lock');
  await writeFile(lock,JSON.stringify({format:'harness-reference-mutation',version:1,pid:process.pid,startedAt:Date.now(),token:randomUUID()})+'\n');
  let released=false;setTimeout(()=>{released=true;void unlink(lock);},200);
  expect(await referenceTarget(project,asset.file)).toBe(copy.path);expect(released).toBe(true);
});
it('registers a verified copy as a new link without reading it again (only the headers are probed)',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));
  const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks()),reads=referenceVerificationTesting.fullReads;
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'new.wav');
  expect(result.branch).toBe('registered');expect(result.asset).toMatchObject({fingerprint:copied.fingerprint,name:'new.wav',kind:'media',file:referenceFile(copied.fingerprint)});
  expect(result.asset.streams.some(stream=>stream.kind==='audio')).toBe(true);expect(await referenceTarget(project,result.asset.file)).toBe(copied.path);
  expect(await sequenceReferenceStatus(project,result.asset)).toEqual({state:'ok'});expect(referenceVerificationTesting.fullReads).toBe(reads);
});
it('branches to a reconnection when the same fingerprint is already registered, so nothing keeps pointing at the card',async()=>{
  const source=join(world.sd,'clip.wav');await writeFile(source,wav(4));const asset=await registerSequenceReference(project,source);
  const copied=await copyOneItem(world.io,{path:source},{folder,name:'clip.wav'},hooks()),reads=referenceVerificationTesting.fullReads;
  const result=await registerSequenceReferenceVerified(project,handoff(copied),'clip.wav');
  expect(result).toMatchObject({branch:'reconnected',asset:{id:asset.id,file:asset.file}});expect(await referenceTarget(project,asset.file)).toBe(copied.path);
  expect(referenceVerificationTesting.fullReads).toBe(reads);
});
it('refuses to register a hand-made handoff whose fingerprint is not the file, and registers nothing',async()=>{
  const imposter=join(world.ssd,'imposter.wav');await writeFile(imposter,wav(4,9));
  const claimed=createHash('sha256').update(wav(4,5)).digest('hex'),reads=referenceVerificationTesting.fullReads;
  await expect(registerSequenceReferenceVerified(project,await handMade(imposter,claimed),'imposter.wav')).rejects.toThrow('一致しません');
  expect(referenceVerificationTesting.fullReads).toBe(reads+1);expect(await referenceTarget(project,referenceFile(claimed))).toBeUndefined();
});
it('reports an unknown result when the last check of a new registration fails; the registration stays and points at the copy',async()=>{
  const source=join(world.sd,'new.wav');await writeFile(source,wav(4,3));const copied=await copyOneItem(world.io,{path:source},{folder,name:'new.wav'},hooks());
  referenceVerificationTesting.afterConnect=()=>writeFile(copied.path,'tampered');
  await expect(registerSequenceReferenceVerified(project,handoff(copied),'new.wav')).rejects.toBeInstanceOf(ReferenceConnectUnknown);
  expect(await referenceTarget(project,referenceFile(copied.fingerprint))).toBe(copied.path);
});
