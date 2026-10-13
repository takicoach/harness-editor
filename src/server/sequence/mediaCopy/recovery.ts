import {constants,type Stats} from 'node:fs';
import {lstat,open,readdir,unlink,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import {isSimulatedCrash,type CopyIo,type MountedVolume} from './io';
import {listVolumes,type VolumeIdentity} from './volumes';
import {removeOwnedCopyFiles} from './copyItem';
import {LedgerUnreadableError,copyJobsFolderIdentity,ledgerConnects,readCopyJobRecords,writeCopyJobRecord,type CopyJobItemRecord,type CopyJobRecord,type LedgerPorts} from './jobRecord';

/** recovered: 回収を終えた。waitingVolume: コピー先のドライブが未接続で、記録を残して次の接続を待つ。skipped: 持ち主が動いている・別のプロセスが回収中・回収できなかった（次の機会に行う）。 */
export interface RecoveryResult {recovered:string[];waitingVolume:string[];skipped:string[]}
const START_TOLERANCE_MS=2000;
/** 中身を読めない札（作った直後に落ちた空の札）を、置き去りとみなすまでの時間。 */
const GUARD_STALE_MS=60_000;
/** 待っているドライブの確認で、mount の表が同じでも一覧を読み直す間隔（同じ名前・同じディスク番号で別のドライブと入れ替わった時に、いつまでも気づかないことがないように）。 */
const ABSENT_REFRESH_MS=120_000;
const STOPPED_BY_EXIT='アプリの終了で止まりました。完了した素材はコピー先につなぎ替えたまま残っています';
const ITEM_STOPPED='アプリの終了で止まりました';
const LEDGER_UNREADABLE='接続の結果を確かめられません（参照台帳を読めません。次の起動で照合します）';
const NOT_CONNECTED='接続は変わっていませんでした（元の素材のままです）';
const MOVED_REASON='この案件の複製・移動の前に作られたコピーの記録のため、コピー先のファイルには触れずに止めました（元の案件が使っていることがあります）';
const MOVED_ITEM='案件の複製・移動の前の記録のため止めました';
const ENDED:readonly CopyJobItemRecord['phase'][]=['done','failed','cancelled'];
const GUARD_NAME=/^cp-[a-f0-9]{20}\.recovering$/;
const codeOf=(error:unknown)=>(error as {code?:unknown}|null)?.code;
/** 記録の持ち主がこのプロセスか（pid と開始時刻）。 */
export const ownedByThisProcess=(io:CopyIo,owner:{pid:number;startedAt:number})=>owner.pid===io.self.pid&&Math.abs(owner.startedAt-io.self.startedAt)<START_TOLERANCE_MS;
/** 作成したプロセスが終わっているか。pid が生きていても開始時刻が違えば別のプロセス（pid の再利用）。開始時刻を確かめられない（例外）時は終わっていない扱い（生きている別のエディターの実体を消さない）。 */
export async function ownerGone(io:CopyIo,owner:{pid:number;startedAt:number}):Promise<boolean>{
  if(ownedByThisProcess(io,owner))return false;if(!io.processAlive(owner.pid))return true;
  let started:number|undefined;try{started=await io.processStartedAt(owner.pid);}catch{return false;}
  return started===undefined||Math.abs(started-owner.startedAt)>=START_TOLERANCE_MS;
}
/** 記録に自分の実体（.part・自分が作って接続していない完成名・予約）が残っているか。 */
export const ownsFiles=(item:CopyJobItemRecord)=>!!item.part||(!item.reused&&!item.connected&&!!(item.final||item.reserved));
/** 消す候補の名前（removeOwnedCopyFiles が見る名前と同じ）。消さずに報告する時に使う。 */
const ownedNames=(item:CopyJobItemRecord)=>[...(item.part?[item.part.name]:[]),...(!item.reused&&!item.connected&&item.finalName&&(item.final||item.part||item.reserved)?[item.finalName]:[])];
/**
 * 台帳と照合してから扱う項目: 照合済みのコピーが完成名にありうるもの。接続を変更中・結果不明（unresolved）・確定した実体（final）がある・読み直す前の大きさと時刻を
 * 記録した .part がある（rename の後に止まりうる）・既存のファイルを再利用して名前を確定済み。段を問わず照合する（記録のフォルダーの fsync ができない FS や停電で、
 * 「名前を確定済み」「接続を変更中」の記録だけが失われ、前の段のまま残りうる）。
 */
const mayBeConnected=(item:CopyJobItemRecord)=>!!item.finalName&&!item.connected&&(item.phase==='connecting'||!!item.unresolved||(item.reused?item.phase==='named':!!item.final||(item.part?.size!==undefined&&item.part.mtimeMs!==undefined)));
/** 回収の対象になりうる記録（終わっていない・自分の実体が残っている）。 */
const candidate=(record:CopyJobRecord)=>record.state==='running'||record.state==='waiting-volume'||record.items.some(ownsFiles);
/** このプロセスが回収してよい記録か: 自分の記録は「ドライブの接続を待っている」ものだけ（走っている作業には触らない）、他の記録は持ち主が終わっているものだけ。 */
const mine=async(io:CopyIo,record:CopyJobRecord)=>ownedByThisProcess(io,record.owner)?record.state==='waiting-volume':ownerGone(io,record.owner);
/** 記録を作った時の記録先と、今の記録先が同じか（違えば、案件フォルダーを複製・復元・別のドライブへ移した先の記録）。 */
const samePlace=(record:CopyJobRecord,here:{dev:number;ino:number}|undefined)=>!!here&&record.recordFolder.dev===here.dev&&record.recordFolder.ino===here.ino;
/** 取り付け先が変わったボリュームの上のパスを、今の取り付け先へ読み替える（取り付け先の下にないパス〈内蔵のホームなど〉はそのまま）。 */
const rebase=(path:string,from:string,to:string)=>from!==to&&path.startsWith(`${from}/`)?`${to}${path.slice(from.length)}`:path;

/** 前回の一覧（mount の表・読んだ時刻・あった UUID）。プロセスに1つ。 */
let lastListing:{mounts:string;at:number;uuids:Set<string>}|undefined;
/**
 * 1回の回収の中で使うボリュームの探し方（UUID で探す。取り付け先の名前・dev は付け直しで変わりうる）。mount の表は1回だけ読む。
 * 15 秒ごとの見張りを軽くする: mount の表が前回と同じで、前回の一覧に無かった UUID は、diskutil を呼ばずに「まだ無い」と答える（ABSENT_REFRESH_MS ごとに読み直す）。
 * 「ある」と答える時は毎回その場で一覧を読み直す（別のドライブと取り違えない）。mount の表を読めない時は「無い」（何も消さずに待つ）。
 */
function volumeFinder(io:CopyIo):(uuid:string)=>Promise<VolumeIdentity|undefined>{
  let table:Promise<readonly MountedVolume[]|undefined>|undefined,listed:Promise<VolumeIdentity[]>|undefined;
  return async uuid=>{
    const mounts=await (table??=io.mounts().catch(error=>{if(isSimulatedCrash(error))throw error;console.error('[sme] ボリュームの一覧を読めません（コピーの回収を待ちます）:',error);return undefined;}));
    if(!mounts)return undefined;
    const key=JSON.stringify(mounts);
    if(!listed&&lastListing?.mounts===key&&io.now()-lastListing.at<ABSENT_REFRESH_MS&&!lastListing.uuids.has(uuid))return undefined;
    const volumes=await (listed??=listVolumes(io,mounts).then(list=>{lastListing={mounts:key,at:io.now(),uuids:new Set(list.map(item=>item.uuid))};return list;}));
    return volumes.find(item=>item.uuid===uuid&&!item.network);
  };
}

/** 札の中身（持ち主）。形が違う・読めない時は undefined。 */
async function readGuard(handle:FileHandle):Promise<{pid:number;startedAt:number}|undefined>{
  try{const value:unknown=JSON.parse(await handle.readFile('utf8'));
    if(typeof value==='object'&&value!==null&&Number.isSafeInteger((value as {pid?:unknown}).pid)&&typeof (value as {startedAt?:unknown}).startedAt==='number')return value as {pid:number;startedAt:number};}
  catch{/* 空・壊れた札 */}
  return undefined;
}
/**
 * 札の状態。free: 無い、または置き去り（持ち主が終わっている。中身を読めない札は作ってから GUARD_STALE_MS 経っている）で外した。self: このプロセスの札。
 * held: 別のプロセスが持っている（中身を読めない新しい札・調べられない札を含む）。odd: 通常のファイルでない（取れないが、別のプロセスの回収中でもない）。
 * 外す直前に、読んだ札と同じ実体かを確かめる（その間に別のプロセスが取り直した札を外さない）。
 */
async function inspectGuard(io:CopyIo,path:string):Promise<'free'|'self'|'held'|'odd'>{
  let handle:FileHandle;
  try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){return codeOf(error)==='ENOENT'?'free':codeOf(error)==='ELOOP'?'odd':'held';}
  let info:Stats,holder:{pid:number;startedAt:number}|undefined;
  try{info=await handle.stat();if(!info.isFile()||info.size>4096)return 'odd';holder=await readGuard(handle);}finally{await handle.close().catch(()=>undefined);}
  if(holder&&ownedByThisProcess(io,holder))return 'self';
  if(holder?!await ownerGone(io,holder):io.wallNow()-info.mtimeMs<GUARD_STALE_MS)return 'held';
  const now=await lstat(path).catch(()=>undefined);if(!now)return 'free';if(now.dev!==info.dev||now.ino!==info.ino)return 'held';
  await unlink(path).catch(()=>undefined);return 'free';
}
/**
 * 2つのプロセス（二重起動のエディター）が同じ記録を同時に回収しないための札（.harness/copy-jobs/<ジョブID>.recovering。中身は持ち主の pid と開始時刻）。
 * 取れなければ undefined。返す関数で外す（自分の札のままの時だけ）。回収の途中で落ちた札は、持ち主が終わっていれば次の回収が外して取り直す。
 * 札は短い間だけのもので、落ちても持ち主の確かめで外せるので、完全同期（F_FULLFSYNC）はしない。
 */
async function takeGuard(io:CopyIo,root:string,jobId:string):Promise<(()=>Promise<void>)|undefined>{
  const path=join(root,'.harness','copy-jobs',`${jobId}.recovering`);
  for(let attempt=0;attempt<2;attempt++){
    let handle:FileHandle;
    try{handle=await open(path,'wx',0o600);}catch(error){if(codeOf(error)!=='EEXIST')throw error;if(await inspectGuard(io,path)!=='free')return undefined;continue;}
    let info:Stats;
    try{await handle.writeFile(JSON.stringify({pid:io.self.pid,startedAt:io.self.startedAt}));info=await handle.stat();}
    catch(error){await handle.close().catch(()=>undefined);await unlink(path).catch(()=>undefined);throw error;}
    await handle.close();
    return async()=>{const now=await lstat(path).catch(()=>undefined);if(now&&now.dev===info.dev&&now.ino===info.ino)await unlink(path).catch(()=>undefined);};
  }
  return undefined;
}
/**
 * 案件の回収の札を見回る: 置き去りの札（記録を書いた直後に落ちたものなど）を外し、別の生きているプロセスが持つ札があるかを返す。
 * 新しいコピーは、別のプロセスの回収中には始めない（回収が消そうとしている完成コピーを、新しい作業が既存のファイルとして再利用しないように。removeOwnedCopyFiles の既知の限界）。
 */
export async function recoveryHeldElsewhere(io:CopyIo,root:string):Promise<boolean>{
  const dir=join(root,'.harness','copy-jobs');let names:string[];
  try{names=await readdir(dir);}catch(error){if(codeOf(error)==='ENOENT'||codeOf(error)==='ENOTDIR')return false;throw error;}
  let held=false;
  for(const name of names)if(GUARD_NAME.test(name)&&await inspectGuard(io,join(dir,name))==='held')held=true;
  return held;
}
/**
 * 起動時の回収（設計 §5）。対象は作成プロセスが終わったジョブと、このプロセスがドライブの接続を待っているジョブ（waiting-volume）。走っている作業・生きている別のエディターの作業には触らない。
 * 記録先の識別（recordFolder）が今の記録先と違う記録（案件フォルダーを複製・復元した先）は、持ち主を問わず台帳を見ず何も消さずに止め、ファイル名を報告する（コピーは元の案件が使っていることがある）。
 * コピー先のボリュームは札を取る前に UUID で探す。未接続なら記録を残し（waiting-volume・持ち主をこのプロセスに）、次に接続された時に行う（既に待っている記録は札も取らず書き換えない）。
 * 札を取った後に記録を読み直してから判断する（別のプロセスが先に回収を終えていれば、その結果に従う）。名前だけを根拠に消さない（消すのは removeOwnedCopyFiles が記録と照合したものだけ）。
 * 最後に置き去りの札を外す。
 */
export async function recoverCopyJobs(io:CopyIo,root:string,ports:LedgerPorts):Promise<RecoveryResult>{
  const result:RecoveryResult={recovered:[],waitingVolume:[],skipped:[]},find=volumeFinder(io),here=await copyJobsFolderIdentity(root);
  for(const seen of await readCopyJobRecords(root)){
    if(!candidate(seen))continue;
    let volume:VolumeIdentity|undefined;
    if(samePlace(seen,here)){
      if(!await mine(io,seen)){result.skipped.push(seen.jobId);continue;}
      volume=await find(seen.destination.volume.uuid);
      if(!volume&&seen.state==='waiting-volume'&&ownedByThisProcess(io,seen.owner)){result.waitingVolume.push(seen.jobId);continue;}
    }
    // 札を作れない（記録先の権限など）時も、その記録だけを次の機会に回す（残りの記録の回収は続ける）
    const release=await takeGuard(io,root,seen.jobId).catch(error=>{console.error('[sme] コピーの回収の札を取れません（次の機会に行います）:',seen.jobId,error);return undefined;});
    if(!release){result.skipped.push(seen.jobId);continue;}
    let crashed=false;
    try{
      const record=(await readCopyJobRecords(root)).find(item=>item.jobId===seen.jobId);
      if(!record||!candidate(record))continue;
      if(!samePlace(record,here)){settleMovedRecord(io,record);await writeCopyJobRecord(root,record);result.recovered.push(record.jobId);continue;}
      if(!await mine(io,record)){result.skipped.push(record.jobId);continue;}
      volume??=await find(record.destination.volume.uuid);
      if(!volume){
        if(record.state!=='waiting-volume'||!ownedByThisProcess(io,record.owner)){
          record.owner={pid:io.self.pid,startedAt:io.self.startedAt};record.state='waiting-volume';record.stopReason??=STOPPED_BY_EXIT;await writeCopyJobRecord(root,record);
        }
        result.waitingVolume.push(record.jobId);continue;
      }
      await recoverRecord(io,root,record,volume,ports);result.recovered.push(record.jobId);
    }catch(error){
      if(isSimulatedCrash(error)){crashed=true;throw error;}   // 試験: 回収の途中でプロセスが落ちた（札は残る）
      console.error('[sme] コピーの作業を回収できません（次の機会に行います）:',seen.jobId,error);result.skipped.push(seen.jobId);
    }finally{if(!crashed)await release();}
  }
  await recoveryHeldElsewhere(io,root).catch(error=>{console.error('[sme] コピーの回収の札を見回れません:',error);});
  return result;
}
/** 複製・復元・移動した案件の記録: 台帳を見ず、コピー先に触れずに止め、記録にあったファイル名を報告する（kept）。 */
function settleMovedRecord(io:CopyIo,record:CopyJobRecord):void{
  const kept=new Set(record.kept??[]);record.owner={pid:io.self.pid,startedAt:io.self.startedAt};
  for(const item of record.items){
    for(const name of ownedNames(item))kept.add(name);
    const pending=!!item.unresolved||!ENDED.includes(item.phase);
    delete item.part;delete item.reserved;delete item.unresolved;if(!item.reused&&!item.connected)delete item.final;
    if(pending){if(!ENDED.includes(item.phase))item.phase='cancelled';item.error=MOVED_ITEM;}
  }
  if(record.items.every(item=>item.phase==='done')){record.state='finished';delete record.stopReason;}else{record.state='stopped';record.stopReason=MOVED_REASON;}
  if(kept.size)record.kept=[...kept].slice(0,200);
}
/**
 * 1つの記録の回収。dev は再接続で変わるので、記録した dev（そのボリュームの dev）を今の dev に、取り付け先を今の取り付け先に読み替える。
 * 台帳の照合は記録のパス（接続を変えた時のパス）で行う。台帳を読めない項目は判定せず、完成ファイルを消さずに unresolved で残す（次の回収で照合し直す）。
 * フォルダーが記録と違う（無い・置き換わった）時は消さずに名前を報告する（kept）。フォルダーを調べられない（EIO など）時は何も変えずに次の機会に回す。
 */
async function recoverRecord(io:CopyIo,root:string,record:CopyJobRecord,volume:VolumeIdentity,ports:LedgerPorts):Promise<void>{
  const recorded=record.destination,devOf=(dev:number)=>dev===recorded.volume.dev?volume.dev:dev;
  const folderPath=rebase(recorded.folder.path,recorded.volume.mountPoint,volume.mountPoint);
  let folderOk=false;
  try{const info=await io.lstat(folderPath);folderOk=!info.isSymbolicLink()&&info.isDirectory()&&info.dev===devOf(recorded.folder.dev)&&info.ino===recorded.folder.ino;}
  catch(error){if(codeOf(error)!=='ENOENT'&&codeOf(error)!=='ENOTDIR')throw error;}
  const wasActive=record.state==='running'||record.state==='waiting-volume',kept=new Set(record.kept??[]);
  record.owner={pid:io.self.pid,startedAt:io.self.startedAt};
  for(const item of record.items){
    if(mayBeConnected(item)){
      let found:{connected:boolean;asset?:SequenceAsset};
      try{found=await ledgerConnects(ports,root,item,`${recorded.folder.path}/${item.finalName}`);}
      catch(error){if(!(error instanceof LedgerUnreadableError))throw error;item.unresolved=true;item.phase='failed';item.error=LEDGER_UNREADABLE;continue;}
      if(found.connected){item.phase='done';item.connected=true;delete item.error;if(found.asset&&item.target.kind==='add')item.assetId=found.asset.id;}
      else if(item.unresolved){item.phase='failed';item.error=NOT_CONNECTED;}
      delete item.unresolved;
    }
    if(ownsFiles(item)){
      if(folderOk){const cleaned=await removeOwnedCopyFiles(io,folderPath,item,devOf);for(const name of cleaned.kept)kept.add(name);}
      else for(const name of ownedNames(item))kept.add(name);   // フォルダーが記録と違う: 消さずに報告する
      delete item.part;delete item.reserved;if(!item.reused&&!item.connected)delete item.final;
    }
    if(!ENDED.includes(item.phase)){item.phase='cancelled';item.error=ITEM_STOPPED;}
  }
  if(record.items.every(item=>item.phase==='done')){record.state='finished';delete record.stopReason;}
  else if(wasActive){record.state='stopped';record.stopReason??=STOPPED_BY_EXIT;}
  if(kept.size)record.kept=[...kept].slice(0,200);
  await writeCopyJobRecord(root,record);
}
