import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {constants,type Stats} from 'node:fs';
import {link,lstat,mkdir,open,readdir,readlink,realpath,rename,stat,symlink,unlink,type FileHandle} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import type {SequenceAsset} from '../../core/sequence/model';
import {validateSequenceDocument} from '../../core/sequence/validate';
import {pinnedSequenceAsset,probePinnedSequenceAsset} from './media';
import type {ImportHooks,RegisteredSequenceAsset} from './assets';
import {assertStillResolved,SOURCE_MOVED_MESSAGE,type ImportSourceOptions} from './sourceCheck';
import {HttpError} from '../http';
import {FileChangedError,sharedFileDigest,stuckDigestRead} from './sharedDigest';
import {UnresponsiveFileError,watchedFs,type ReadLimit} from './fsWatch';
import {copiedAndVerified,copyItemTesting,sourceReadAndVerified} from './mediaCopy/copyItem';

const filePattern=/^\.harness\/references\/([a-f0-9]{64})\.(mp4|mov|m4v|mkv|webm|avi|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif|avif|bmp)$/;
const recordSchema=z.object({format:z.literal('harness-reference'),version:z.literal(1),asset:z.unknown(),target:z.string().min(1),
 generation:z.string().uuid(),sizeBytes:z.number().int().nonnegative().safe()}).strict();
type ReferenceRecord=Omit<z.infer<typeof recordSchema>,'asset'>&{asset:SequenceAsset};
export interface SequenceReferenceLease {path:string;handle:FileHandle;verify():Promise<void>;close():Promise<void>}
/** checking: 中身の照合（全体 SHA-256）を裏で続けている。
 * copying: 速いドライブへコピーしている（再生はコピーの照合結果を待つ。設計 §5）。どちらもエラーではない。 */
export interface SequenceReferenceStatus {state:'ok'|'checking'|'copying'|'missing'|'mismatch'|'invalid';message?:string}
type FileInfo=Pick<Stats,'dev'|'ino'|'size'|'mtimeMs'|'ctimeMs'>;
const identity=(s:FileInfo)=>JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);
/** 識別情報（dev・ino・大きさ・更新時刻・変更時刻）。コピーの作業との受け渡しに使う。 */
export type ReferenceFileInfo=FileInfo;
/**
 * コピーの作業が照合した実体（完成ファイル）: fingerprint は書き先を読み直して確かめた全体 SHA-256、identity は確定名で開き直した識別情報（設計 §5-6）。
 * 照合を省く旗ではない: 登録・つなぎ直しは、copyOneItem がこのプロセスで照合した組で、開いた実体も同じ識別情報の時だけ読み直さない（違えば全体を読む）。
 */
export interface VerifiedCopy {path:string;fingerprint:string;identity:FileInfo}
export class ReferenceGenerationChanged extends Error{constructor(){super('別の操作で素材の接続先が変わったため、つなぎ直しを中止しました');this.name='ReferenceGenerationChanged';}}
/** 接続を確定した後（または確定したか分からない失敗の後）の失敗（結果不明）。呼び手は台帳の接続先を読んで「変わっていない／新しい場所に変わった」を判定する（設計 §5-7）。 */
export class ReferenceConnectUnknown extends Error{constructor(cause:unknown){super('接続を変えた後の確認に失敗しました（結果を台帳で確かめます）',{cause});this.name='ReferenceConnectUnknown';}}
type Inode=Pick<Stats,'dev'|'ino'>;
const sameInode=(a:Inode,b:Inode)=>a.dev===b.dev&&a.ino===b.ino;
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const error=(message:string)=>new Error(message);
export function isSequenceReferenceFile(file:string):boolean{return filePattern.test(file);}
export function expectedReferenceFingerprint(value:unknown):string|undefined {
 if(value===undefined)return undefined;
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new HttpError(400,'素材の指紋は全体SHA-256で指定してください');
 return value;
}

async function directory(project:string,create=false):Promise<string>{
 let dir=await realpath(project);
 for(const part of ['.harness','references']){
  dir=join(dir,part);
  if(create)await mkdir(dir,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())throw error('参照台帳のディレクトリが不正です');
 }
 return dir;
}
async function unlocked(dir:string){await recoverMutation(dir);}
function assetIdentity(a:SequenceAsset){return [a.id,a.file,a.kind,a.fingerprint,a.streams];}
function validateAsset(a:SequenceAsset){
 if(!a||!['media','image'].includes(a.kind)||!isSequenceReferenceFile(a.file)||filePattern.exec(a.file)?.[1]!==a.fingerprint)
  throw error('参照素材の登録情報が不正です');
 validateSequenceDocument({schemaVersion:2,id:'reference',name:'参照',revision:0,fps:{num:1,den:1},resolution:{width:1,height:1},
  sequenceEndFrame:0,background:'#000',assets:[a],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}});
}
async function readRecord(dir:string,file:string,recordPath=join(dir,basename(file)+'.json')):Promise<{record:ReferenceRecord;bytes:string;info:Stats}>{
 if(!isSequenceReferenceFile(file))throw error('参照素材の保存先が不正です');
 const handle=await open(recordPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await handle.stat();if(!info.isFile()||info.size>128*1024)throw error('参照台帳が通常のファイルではありません');
  const bytes=await handle.readFile('utf8'),parsed=recordSchema.parse(JSON.parse(bytes)),asset=parsed.asset as SequenceAsset;
  validateAsset(asset);if(asset.file!==file||!isAbsolute(parsed.target))throw error('参照台帳の接続先が不正です');
  if(identity(info)!==identity(await handle.stat()))throw error('読み取り中に参照台帳が変更されました');
  return {record:{...parsed,asset},bytes,info};
 }finally{await handle.close();}
}
async function hashHandle(handle:FileHandle,signal?:AbortSignal){
 referenceVerificationTesting.fullReads++;const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;
 while(true){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
 return hash.digest('hex');
}

// ---- 照合（全体 SHA-256）は要求から切り離して裏で最後まで続ける ----
// SD カード上の数 GB は全体読みに数分かかる。要求（状態確認・再生）に照合を持たせると、要求が切れるたびに読み捨てて先頭から読み直し、永遠に終わらない。

// A cached digest is valid only for the exact file/stat identity, never for its name alone.
const verified=new Map<string,string>();
/**
 * 全体読みして一致した結果だけを、同じ同一性（dev/ino/size/mtime/ctime）に限って確認済みとして覚える。読みは、登録では開いた fd、
 * 照合では同一性を確かめた共有の読み（sharedDigest）。鍵は照合の記憶と同じ形にする（登録の後の照合が読み直さない。importReadRoutes.test.ts）。
 */
function rememberVerified(path:string,expected:string,info:FileInfo){verified.set(path,JSON.stringify([expected,identity(info)]));while(verified.size>128)verified.delete(verified.keys().next().value!);}

/** 照合に成功した組をディスクに残す（.harness/cache/reference-verified/<実パスの sha256>.json）。再起動の後も、識別情報が同じなら読み直さない。信頼の範囲はメモリの記憶と同じ。 */
const VERIFIED_RECORD_MAX_BYTES=64*1024;
const verifiedRecordSchema=z.object({format:z.literal('harness-reference-verified'),version:z.literal(1),path:z.string().min(1),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
 identity:z.object({dev:z.number(),ino:z.number(),size:z.number(),mtimeMs:z.number(),ctimeMs:z.number()}).strict(),verifiedAt:z.string()}).strict();
const verifiedRecordName=(path:string)=>createHash('sha256').update(path).digest('hex')+'.json';
async function verifiedRecordFolder(root:string,create:boolean):Promise<string|undefined>{
 let folder=root;
 for(const part of ['.harness','cache','reference-verified']){
  folder=join(folder,part);
  if(create)await mkdir(folder).catch(e=>{if(e.code!=='EEXIST')throw e;});
  let info:Stats;try{info=await lstat(folder);}catch(e){if(!create&&absent(e))return undefined;throw e;}
  if(!info.isDirectory()||info.isSymbolicLink())throw error('照合記録の保存先が不正です');
 }
 return folder;
}
/** path・fingerprint・識別情報が完全に一致する記録がある時だけ true。リンクはたどらない。読めない・形が違う記録は無いものとして扱う（照合し直す）。 */
async function readVerifiedRecord(root:string,path:string,expected:string,info:FileInfo):Promise<boolean>{
 try{
  const folder=await verifiedRecordFolder(root,false);if(!folder)return false;
  const handle=await open(join(folder,verifiedRecordName(path)),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const stats=await handle.stat();if(!stats.isFile()||stats.size>VERIFIED_RECORD_MAX_BYTES)return false;
   const parsed=verifiedRecordSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
   return parsed.success&&parsed.data.path===path&&parsed.data.fingerprint===expected&&identity(parsed.data.identity)===identity(info);
  }finally{await handle.close();}
 }catch{return false;}
}
async function writeVerifiedRecord(root:string,path:string,expected:string,info:FileInfo){
 const folder=(await verifiedRecordFolder(root,true))!,target=join(folder,verifiedRecordName(path)),temporary=`${target}.${randomUUID()}.tmp`;
 const record={format:'harness-reference-verified',version:1,path,fingerprint:expected,
  identity:{dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs},verifiedAt:new Date().toISOString()};
 const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(record)+'\n');}finally{await handle.close();}
 try{await rename(temporary,target);}catch(e){await unlink(temporary).catch(()=>undefined);throw e;}
}
/** 案件ごとに1回だけ書く（書けなくても照合の結果と動作は変えない）。書けなかった組は 60 秒に1回だけ書き直し、警告は組ごとに1回。 */
const persisted=new Set<string>(),persistFailures=new Map<string,number>();
const PERSIST_RETRY_MS=60_000;
const persistedKey=(root:string,path:string,expected:string,info:FileInfo)=>JSON.stringify([root,path,expected,identity(info)]);
function markPersisted(key:string){persisted.add(key);while(persisted.size>512)persisted.delete(persisted.values().next().value!);}
async function persistVerified(root:string,path:string,expected:string,info:FileInfo){
 const key=persistedKey(root,path,expected,info);if(persisted.has(key))return;
 const failedAt=persistFailures.get(key);if(failedAt!==undefined&&Date.now()-failedAt<PERSIST_RETRY_MS)return;
 markPersisted(key);
 try{await writeVerifiedRecord(root,path,expected,info);persistFailures.delete(key);}
 catch(e){persisted.delete(key);   // 次に照合済みと答える時に書き直す（60 秒たってから）
  const first=failedAt===undefined;persistFailures.set(key,Date.now());while(persistFailures.size>512)persistFailures.delete(persistFailures.keys().next().value!);
  if(first)console.warn('[sme] 参照素材の照合記録を保存できませんでした（照合の結果は使えます。1分ごとに書き直します）:',e instanceof Error?e.message:String(e));}
}
/** メモリ、なければディスクの記録で照合済みかを答える（全体は読まない）。 */
async function knownVerified(root:string,path:string,expected:string,info:FileInfo):Promise<boolean>{
 if(verified.get(path)===JSON.stringify([expected,identity(info)])){await persistVerified(root,path,expected,info);return true;}
 if(!await readVerifiedRecord(root,path,expected,info))return false;
 rememberVerified(path,expected,info);markPersisted(persistedKey(root,path,expected,info));return true;
}

/**
 * 裏の照合が実際に読んだ量と時間（実パスごと。測った時の大きさと更新時刻を添える）。開いた時の案内の見込みに使う（設計 §1）。
 * 測り始めは照合が順番を得て読み始める時（待ち行列の時間は含めない）。経過は単調時計。この量を読むまでは「まだ測れていない」。
 * 大きさと更新時刻が同じ間だけ使う（dev・ino・ctime は見ない: 同じカードの挿し直しでは残す）。見張りで切り上げた読みの速さは捨てる。
 */
export const READ_SPEED_SAMPLE_BYTES=16*1024*1024;
type SpeedFile=Pick<FileInfo,'size'|'mtimeMs'>;
const readSpeeds=new Map<string,{bytes:number;ms:number;size:number;mtimeMs:number}>();
function noteReadSpeed(path:string,info:SpeedFile,bytes:number,ms:number){readSpeeds.delete(path);readSpeeds.set(path,{bytes,ms,size:info.size,mtimeMs:info.mtimeMs});while(readSpeeds.size>256)readSpeeds.delete(readSpeeds.keys().next().value!);}
function measuredSpeed(path:string,info?:SpeedFile):number|undefined{
 const speed=readSpeeds.get(path);if(!speed||info&&(speed.size!==info.size||speed.mtimeMs!==info.mtimeMs))return undefined;
 return speed.bytes>=READ_SPEED_SAMPLE_BYTES&&speed.ms>0?speed.bytes*1000/speed.ms:undefined;
}
/** バイト/秒（そのパスで最後に測った速さ。大きさ・更新時刻は問わない）。測れていなければ undefined。 */
export function referenceReadSpeed(path:string):number|undefined{return measuredSpeed(path);}

/** 照合の組（実パス・期待する指紋・識別情報）ごとに裏の作業を1本だけ持つ。要求の signal には依存しない。
 * askedAt は最後に問われた（作られた・合流された）時刻、waiters は今完了を待っている呼び手の数。path・dev はコピーとの調停に使う。
 * held はコピーのために待ち行列から外している照合。stop は照合を止める（コピーの対象になった時の意図的な中止と、見張りの切り上げ。最初の理由だけが効く）。 */
interface Verification {key:string;path:string;dev:number;roots:Set<string>;started:boolean;held:boolean;askedAt:number;waiters:number;begin(run:boolean):void;stop(reason:unknown):void;done:Promise<void>}
const verifications=new Map<string,Verification>(),verificationQueue:Verification[]=[];
let verifying:Verification|undefined;
/** 失敗の記憶。中身が違う・読み取り中に変わった等は同じ組の間ずっと（識別情報が変われば別の組）。errno 付きの読み取りエラーは一時的なことがあるので30秒だけ。 */
const failures=new Map<string,{error:Error;until:number}>();
const FAILURE_RETRY_MS=30_000;
/** 誰も待っておらず、この長さ問われていない未開始の照合は捨てる（閉じた案件の照合で、今の案件を待たせない）。開いている案件は 2 秒ごとに問うが、
 * 隠れた窓ではタイマーが間引かれて間隔が延びるので余裕を持たせる。 */
const ABANDONED_MS=180_000;
/** 読みがこの長さ進まなければ一時的な失敗（30 秒覚える）として切り上げ、次の照合へ進む（カードリーダーの不調・USB の再接続待ちで全体を止めない）。 */
const STALL_MS=60_000;
const stalled=()=>Object.assign(error('参照素材の読み取りが進みません'),{code:'ETIMEDOUT'});
const dropped=()=>Object.assign(error('参照素材の照合を取りやめました'),{dropped:true});
const verificationKey=(path:string,expected:string,info:FileInfo)=>JSON.stringify([path,expected,identity(info)]);
function rememberedFailure(key:string):Error|undefined{
 const failure=failures.get(key);if(!failure)return undefined;
 if(failure.until<=Date.now()){failures.delete(key);return undefined;}
 return failure.error;
}
/** 同時に走る裏の照合は1本（SD カードの読み取りを取り合わせない）。コピーが読んでいる媒体（dev）の照合は、コピーが終わるまで始めない（先へ飛ばして順番は保つ）。 */
function pumpVerifications(){
 if(verifying)return;
 const busy=new Set([...copyClaims.values()].map(claim=>claim.dev));
 for(let i=0;i<verificationQueue.length;){
  const job=verificationQueue[i]!;
  if(!job.waiters&&Date.now()-job.askedAt>=ABANDONED_MS){verificationQueue.splice(i,1);verifications.delete(job.key);job.begin(false);continue;}   // 次に問われたら新しく並ぶ
  if(busy.has(job.dev)){i++;continue;}
  verificationQueue.splice(i,1);verifying=job;job.started=true;job.begin(true);return;
 }
}
/** urgent: 読み取り経路（再生・波形など）が待つ組。待ち行列の先頭へ繰り上げる（走っている照合は止めない）。 */
function verification(root:string,path:string,expected:string,info:FileInfo,urgent:boolean):Verification{
 const key=verificationKey(path,expected,info),existing=verifications.get(key);
 if(existing){
  existing.roots.add(root);existing.askedAt=Date.now();referenceVerificationTesting.joined++;
  if(urgent&&!existing.started&&!existing.held){verificationQueue.splice(verificationQueue.indexOf(existing),1);verificationQueue.unshift(existing);}
  return existing;
 }
 let begin!:(run:boolean)=>void;const turn=new Promise<boolean>(resolve=>{begin=resolve;});
 // 照合を止める合図は作った時から持つ（順番を得た直後、読み始める前にコピーの対象になっても止められる）。
 const watchdog=new AbortController();
 const job:Verification={key,path,dev:info.dev,roots:new Set([root]),started:false,held:false,askedAt:Date.now(),waiters:0,begin,stop:reason=>watchdog.abort(reason),done:turn.then(async run=>{
  if(!run)throw dropped();
  watchdog.signal.throwIfAborted();
  // コピーが同じ組を読み切って照合し終えていれば読まない（コピーの間に外して、後で戻した照合）。案件の照合記録だけ残す。
  if(verified.get(path)===JSON.stringify([expected,identity(info)])){for(const root of job.roots)await persistVerified(root,path,expected,info);return;}
  // 前に見張りで切り上げた読みがまだ戻っていなければ、開かずに同じ失敗にする（止まった読みを積み重ねて作業用スレッドを使い切らない）。
  // 中止されていない進行中の読み（別の案件の管理素材として照合中など）には、下の sharedFileDigest で合流する。
  if(stuckDigestRead(path,identity(info)))throw stalled();
  // 見張り: 1MiB 読むごとに時計を戻す。止まった読み自体は取り消せない（OS の読み待ち）が、この照合はそこで切り上げる。
  const stall=setTimeout(()=>watchdog.abort(stalled()),referenceVerificationTesting.stallMs);
  let digest:string;
  // 読みの速さを測る（照合が順番を得てからの経過。読みが進むごとに、実際に読めたバイト数で書き換える）。
  const readStarted=performance.now();let readBytes=0;referenceVerificationTesting.fullReads++;
  try{digest=await sharedFileDigest(path,identity(info),watchdog.signal,bytes=>{stall.refresh();readBytes+=bytes;noteReadSpeed(path,info,readBytes,performance.now()-readStarted);});}
  catch(e){
   // 見張りで切り上げた（読みが止まった）媒体の速さは捨てる（止まる前の速さで「速い」と見せない）。
   if(watchdog.signal.aborted&&(watchdog.signal.reason as NodeJS.ErrnoException|undefined)?.code==='ETIMEDOUT')readSpeeds.delete(path);
   if(e instanceof FileChangedError)throw error('読み取り中に参照素材が変更されました');throw e;
  }
  finally{clearTimeout(stall);}
  if(digest!==expected)throw error('参照素材の内容が保存時と一致しません');
  rememberVerified(path,expected,info);
  for(const root of job.roots)await persistVerified(root,path,expected,info);
 })};
 const settle=(failed:boolean,reason?:unknown)=>{
  if(!failed)failures.delete(key);
  else if(!absent(reason)&&!(reason as {dropped?:boolean}).dropped){   // ファイルが無いのは状態確認がすぐ「未接続」と答える。覚えると挿し直した後も塞いでしまう。
   const cause=reason instanceof Error?reason:error(String(reason));
   failures.set(key,{error:cause,until:(cause as NodeJS.ErrnoException).code?Date.now()+FAILURE_RETRY_MS:Infinity});
   while(failures.size>128)failures.delete(failures.keys().next().value!);
  }
  if(verifications.get(key)===job)verifications.delete(key);if(verifying===job)verifying=undefined;pumpVerifications();
 };
 job.done.then(()=>settle(false),reason=>settle(true,reason));
 verifications.set(key,job);
 const claim=copyClaims.get(path);
 if(claim){job.held=true;claim.held.push(job);}else if(urgent)verificationQueue.unshift(job);else verificationQueue.push(job);
 pumpVerifications();
 return job;
}
/** 照合の完了を待つ。自分の中止は自分の待ちをやめるだけで、照合は止めない。within を過ぎたら false（照合は続く）。 */
function awaitVerification(job:Verification,signal?:AbortSignal,within?:number):Promise<boolean>{
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason);return;}
  let timer:ReturnType<typeof setTimeout>|undefined,waiting=true;job.waiters++;
  const finish=(action:()=>void)=>{if(waiting){waiting=false;job.waiters--;}clearTimeout(timer);signal?.removeEventListener('abort',abort);action();};
  const abort=()=>finish(()=>reject(signal!.reason??error('照合の待ちを中止しました')));
  signal?.addEventListener('abort',abort,{once:true});
  if(within!==undefined)timer=setTimeout(()=>finish(()=>resolve(false)),within);
  job.done.then(()=>finish(()=>resolve(true)),reason=>finish(()=>reject(reason)));
 });
}
// ---- コピーとの読み取りの調停（設計 §5、裁定 #10） ----
interface CopyClaim {path:string;dev:number;gate:Promise<void>;open():void;held:Verification[]}
const copyClaims=new Map<string,CopyClaim>();
export const COPYING_MESSAGE='速いドライブへコピーしています。終わるまでは元の素材で再生します';
export const COPYING_EXPORT_MESSAGE='速いドライブへコピーしています。コピーが終わってから書き出してください';
/** コピーのために意図的に止めた照合の理由。dropped なので失敗として覚えない（30 秒の一時失敗にも入れない）。code を持たないので見張りの切り上げ（ETIMEDOUT）とも区別される。 */
const copying=()=>Object.assign(error('素材を速いドライブへコピーしています'),{dropped:true,copying:true});
const isCopying=(e:unknown)=>!!(e as {copying?:boolean}|undefined)?.copying;
/** コピーの1項目の予約。どちらも2回目以降は何もしない。 */
export interface ReferenceCopyClaim {
 /** コピーの終わり。verified は元を照合済みにする組（指紋と元の識別情報。copyOneItem の CopiedFile の fingerprint・sourceIdentity）。外した照合は待ち行列の先頭に戻す。
  * 取り消し・失敗は release() だけ。 */
 release(verified?:{fingerprint:string;info:ReferenceFileInfo}):void;
 /** 元の照合が要らなくなった時（接続をコピーへ変えた後。特に元を読まずに既存の完成ファイルを再利用した時）: 外した照合は戻さずに取りやめる
  * （読まない・失敗として覚えない。まだ要るなら次に問われた時に並び直す）。 */
 drop():void;
}
/** 予約を外す。returnHeld: 外した照合を待ち行列の先頭に戻す（元の順のまま）。false なら読まずに取りやめる（copying の理由: 失敗として覚えず、待っていた再生は接続を確かめ直す）。 */
function endClaim(claim:CopyClaim,returnHeld:boolean){
 if(copyClaims.get(claim.path)!==claim)return;
 copyClaims.delete(claim.path);claim.open();
 const held=claim.held.splice(0);for(const job of held)job.held=false;
 if(returnHeld)verificationQueue.unshift(...held);
 else for(const job of held){verifications.delete(job.key);job.started=true;job.stop(copying());job.begin(true);}   // 止める合図を立ててから順番を渡す（読まずに終わる）
 pumpVerifications();
}
function claimHandle(claim:CopyClaim):ReferenceCopyClaim{
 return {release:verifiedCopy=>{
  if(copyClaims.get(claim.path)!==claim)return;
  if(verifiedCopy&&sourceReadAndVerified(claim.path,verifiedCopy.fingerprint,verifiedCopy.info))rememberVerified(claim.path,verifiedCopy.fingerprint,verifiedCopy.info);
  endClaim(claim,true);
 },drop:()=>endClaim(claim,false)};
}
/**
 * コピーが元のファイル（実パス）を読む前に呼ぶ（作業の残り全項目を一度に予約する。項目の間に同じ媒体のほかの照合が始まらない）。
 * まだ始まっていない同じ素材の照合は待ち行列から外す（コピーで照合も済むため）。実行中の照合は、コピー対象の素材なら意図的に中止し（失敗として覚えない）、
 * それ以外は終わるのを待ってから返す。予約のある媒体（dev）のほかの照合は、その媒体の予約がすべて外れるまで始めない。
 * 待ちの途中で signal が中止されたら（「残りを中止」）、予約を外し、外した照合を戻してから中止の理由で失敗する。
 * release(verified) は、copyOneItem がこのプロセスで元を読み切って照合した組（sourceReadAndVerified）の時だけ元を照合済みとして覚える（受け渡しは照合を省く旗ではない）。
 */
export async function claimReferenceCopies(items:readonly {path:string;dev:number}[],signal?:AbortSignal):Promise<Map<string,ReferenceCopyClaim>>{
 signal?.throwIfAborted();
 const wanted=new Map<string,number>();for(const {path,dev} of items)if(!wanted.has(path))wanted.set(path,dev);
 for(const path of wanted.keys())if(copyClaims.has(path))throw error('この素材はコピー中です');
 const mine=new Map<string,CopyClaim>();
 for(const [path,dev] of wanted){let open!:()=>void;const claim:CopyClaim={path,dev,gate:new Promise<void>(resolve=>{open=resolve;}),open,held:[]};copyClaims.set(path,claim);mine.set(path,claim);}
 for(let i=verificationQueue.length-1;i>=0;i--){const claim=mine.get(verificationQueue[i]!.path);if(claim){const [job]=verificationQueue.splice(i,1);job!.held=true;claim.held.unshift(job!);}}
 const running=verifying;
 if(running&&mine.has(running.path))running.stop(copying());
 // 止めた照合も、終わるのを待つ照合も、片付け（settle）まで済ませてから返す（失敗の記憶・次の照合の選び直しが先に済む）
 if(running){try{await waitFor(running.done.then(()=>undefined,()=>undefined),signal);}catch(e){for(const claim of mine.values())endClaim(claim,true);throw e;}}
 return new Map([...mine].map(([path,claim])=>[path,claimHandle(claim)]));
}
/** 1項目だけの予約（claimReferenceCopies と同じ規則）。 */
export async function claimReferenceCopy(path:string,dev:number,signal?:AbortSignal):Promise<ReferenceCopyClaim>{
 return (await claimReferenceCopies([{path,dev}],signal)).get(path)!;
}
/** settles（コピーの終わり・照合の片付け）を待つ。自分の中止は自分の待ちをやめるだけ。 */
const waitFor=(settles:Promise<void>,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 if(signal?.aborted){reject(signal.reason);return;}const abort=()=>reject(signal!.reason);signal?.addEventListener('abort',abort,{once:true});
 void settles.then(()=>{signal?.removeEventListener('abort',abort);resolve();});
});

/** 試験専用（製品の経路からは呼ばない）。forget は再起動に相当する（メモリの照合記録・失敗の記憶を消す。ディスクの記録は残る）。 */
export const referenceVerificationTesting={
 /** 照合中の組に後から合流した回数。 */
 joined:0,
 /** 全体読み（登録・受け渡しの照合と裏の照合）を始めた回数。受け渡しで読み直さないことの確かめに使う。 */
 fullReads:0,
 /** 試験だけ: 受け渡しの登録・つなぎ直しで、接続の確定と最後の確認の間に呼ぶ（結果不明の再現）。 */
 afterConnect:undefined as undefined|(()=>unknown),
 /** 読みが進まない時に切り上げるまでの長さ（試験で縮める）。 */
 stallMs:STALL_MS,
 /** コピーの予約の残数（作業の終わりごとに 0 であることを確かめる）。 */
 claims:()=>copyClaims.size,
 /** 再起動に相当: コピーの予約（外した照合は読まずに取りやめる）と、copyOneItem が照合した記憶も消す。 */
 forget(){for(const claim of [...copyClaims.values()])endClaim(claim,false);copyItemTesting.forget();
  verified.clear();failures.clear();persisted.clear();persistFailures.clear();readSpeeds.clear();referenceVerificationTesting.joined=0;referenceVerificationTesting.fullReads=0;},
 /** 照合がすべて終わるまで待つ。コピーのために外している照合は待たない（予約を残して落ちた試験の後片付けを止めない。forget が取りやめる）。 */
 async idle(){let pending:Verification[];while((pending=[...verifications.values()].filter(job=>!job.held)).length)await Promise.allSettled(pending.map(job=>job.done));},
};

interface PinnedReference {root:string;path:string;handle:FileHandle;before:Stats;verify():Promise<void>;close():Promise<void>}
/** 台帳・リンク・接続先を確かめて参照先を開く（中身の照合はしない）。大きさが台帳と違えば全体を読む前に断る。
 * 接続先に触れる処理（実パスの解決・開く・stat）は見張る（fsWatch.ts）。limit.unresponsiveMs があればその長さで待つのをやめる。 */
async function pinSequenceReference(project:string,asset:SequenceAsset,signal?:AbortSignal,limit:ReadLimit={}):Promise<PinnedReference>{
 signal?.throwIfAborted();validateAsset(asset);const dir=await directory(project);await unlocked(dir);
 const initial=await readRecord(dir,asset.file);if(!isDeepStrictEqual(assetIdentity(initial.record.asset),assetIdentity(asset)))throw error('参照素材の文書と台帳が一致しません');
 const leaf=join(dir,basename(asset.file)),link=await lstat(leaf),target=initial.record.target,limitMs=limit.unresponsiveMs;
 // 実パスの解決は接続先の各段をたどる（止まった媒体ではここで戻らない）。記録・失敗の場所は接続先で示す。
 const resolveLeaf=()=>watchedFs('realpath',target,()=>realpath(leaf),{limitMs});
 if(!link.isSymbolicLink()||await readlink(leaf)!==target)throw error('参照素材のリンクが登録時と一致しません');
 const path=await resolveLeaf();if(path!==target)throw error('参照素材の接続先が変更されています');
 const handle=await watchedFs('open',path,()=>open(path,constants.O_RDONLY|constants.O_NOFOLLOW),{limitMs,dispose:late=>late.close()});let closed=false;
 try{
  const before=await handle.stat();if(!before.isFile())throw error('参照先が通常のファイルではありません');
  if(before.size!==initial.record.sizeBytes)throw error('参照素材の大きさが一致しません');
  const verify=async()=>{
   signal?.throwIfAborted();if(closed)throw error('参照素材の読み取りは終了しています');
   if(await directory(project)!==dir)throw error('参照台帳の場所が変更されました');await unlocked(dir);
   const current=await readRecord(dir,asset.file),nowLink=await lstat(leaf);
   if(current.bytes!==initial.bytes||!sameInode(current.info,initial.info)||!nowLink.isSymbolicLink()||!sameInode(nowLink,link)
    ||await readlink(leaf)!==path||await resolveLeaf()!==path||identity(await watchedFs('stat',path,()=>stat(path),{limitMs}))!==identity(before)||identity(await handle.stat())!==identity(before))
    throw error('読み取り中に参照素材または接続が変更されました');
  };
  return {root:dirname(dirname(dir)),path,handle,before,verify,close:async()=>{if(!closed){closed=true;await handle.close();}}};
 }catch(e){await handle.close();throw e;}
}
/**
 * 照合済みでなければ裏の照合に合流して待つ（読み取り経路。待ち行列の先頭へ）。コピー中の素材はコピーの照合結果を待つ（カードを取り合わない）。
 * コピーが失敗・取り消しになったら通常の照合に戻る（永遠には待たない）。
 */
async function verifyHash(pinned:PinnedReference,expected:string,signal?:AbortSignal,limit:ReadLimit={}){
 const {root,path,handle,before}=pinned;
 // 書き出し前の確認（limit あり）: 裏の照合の見張りが切り上げた（読みが進まない・止まった読みが戻らない）失敗は、場所つきの「応答しません」にする。
 const unresponsive=(e:unknown)=>limit.unresponsiveMs!==undefined&&!(e instanceof UnresponsiveFileError)&&(e as NodeJS.ErrnoException|undefined)?.code==='ETIMEDOUT'
  ?new UnresponsiveFileError('read',path,referenceVerificationTesting.stallMs):e;
 for(let attempt=0;attempt<3;attempt++){
  if(await knownVerified(root,path,expected,before))return;
  // コピーの照合結果を待つ。待った後は接続を確かめ直す（コピーへつなぎ替えた後に、元の媒体を読み直さない）。
  // 書き出し前の確認はコピーの終わりを待たない（コピーの長さは読みの応答と無関係に何分にもなる。止まったコピーは終わらない）。
  const claim=copyClaims.get(path);if(claim){if(limit.unresponsiveMs!==undefined)throw error(COPYING_EXPORT_MESSAGE);await waitFor(claim.gate,signal);await pinned.verify();continue;}
  const failed=rememberedFailure(verificationKey(path,expected,before));if(failed)throw unresponsive(failed);
  try{await awaitVerification(verification(root,path,expected,before,true),signal);}catch(e){if(isCopying(e)){await pinned.verify();continue;}throw unresponsive(e);}   // 待っていた照合がコピーのために止められた
  if(identity(before)!==identity(await handle.stat()))throw error('読み取り中に参照素材が変更されました');
  return;
 }
 throw error('参照素材の照合を完了できません。もう一度お試しください');
}

/** No absolute source path is exposed in the document or status. The caller owns browse authorization. */
export async function openSequenceReference(project:string,asset:SequenceAsset,signal?:AbortSignal,limit:ReadLimit={}):Promise<SequenceReferenceLease>{
 const pinned=await pinSequenceReference(project,asset,signal,limit);
 try{await verifyHash(pinned,asset.fingerprint,signal,limit);await pinned.verify();return {path:pinned.path,handle:pinned.handle,verify:pinned.verify,close:pinned.close};}
 catch(e){await pinned.close();throw e;}
}

export async function registeredSequenceReferences(project:string):Promise<SequenceAsset[]>{
 let dir:string;try{dir=await directory(project);}catch(e){if(absent(e))return [];throw e;}await unlocked(dir);
 const assets:SequenceAsset[]=[];
 for(const name of (await readdir(dir)).sort())if(isSequenceReferenceFile(`.harness/references/${name.replace(/\.json$/,'')}`)&&name.endsWith('.json')){
  assets.push((await readRecord(dir,`.harness/references/${name.slice(0,-5)}`)).record.asset);
 }
 return assets;
}
/** 照合が走っている時だけ、この長さまで完了を待つ（小さいファイルで「確認中」が一瞬出ないように）。 */
const STATUS_WAIT_MS=1000;
const CHECKING_MESSAGE='参照素材の中身を確認しています。大きな素材は数分かかることがあります';
/**
 * すぐ答える: リンク・台帳・ファイルの存在・識別情報・大きさを確かめ、照合済みなら ok。未照合なら裏の照合を始めて checking
 * （要求が切れても照合は続く）。照合の失敗は同じ組について覚えていて、読み直さずに mismatch/invalid を返す。
 */
export async function sequenceReferenceStatus(project:string,asset:SequenceAsset,signal?:AbortSignal):Promise<SequenceReferenceStatus>{
 try{
  const pinned=await pinSequenceReference(project,asset,signal);
  try{
   const {root,path,handle,before}=pinned;
   if(!await knownVerified(root,path,asset.fingerprint,before)){
    if(copyClaims.has(path)){
     // 外している照合は、問われ続けている間は捨てない（コピーの後に待ち行列へ戻す。ABANDONED_MS）
     const held=verifications.get(verificationKey(path,asset.fingerprint,before));if(held){held.roots.add(root);held.askedAt=Date.now();}
     await pinned.verify();return {state:'copying',message:COPYING_MESSAGE};
    }
    const failed=rememberedFailure(verificationKey(path,asset.fingerprint,before));if(failed)throw failed;
    const job=verification(root,path,asset.fingerprint,before,false);
    if(!job.started||!await awaitVerification(job,signal,STATUS_WAIT_MS)){await pinned.verify();return {state:'checking',message:CHECKING_MESSAGE};}
    if(identity(before)!==identity(await handle.stat()))throw error('読み取り中に参照素材が変更されました');
   }
   await pinned.verify();return {state:'ok'};
  }finally{await pinned.close();}
 }
 catch(e){signal?.throwIfAborted();if(isCopying(e))return {state:'copying',message:COPYING_MESSAGE};   // 待っていた照合がコピーのために止められた
  const message=(e as NodeJS.ErrnoException).code?'参照素材を読み取れません。接続と登録情報を確認してください':e instanceof Error?e.message:'参照素材を確認できません';
  return {state:absent(e)?'missing':/未完了|完了後に再試行/.test(message)?'invalid':/一致|変更/.test(message)?'mismatch':'invalid',message:absent(e)?'参照先が見つかりません。ドライブの接続を確認してください':message};}
}

async function removeOwned(path:string,expected:Inode){
 try{const now=await lstat(path);if(sameInode(now,expected))await unlink(path);}catch(e){if(!absent(e))throw e;}
}
const inodeSchema=z.object({dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative()}).strict();
const transactionSchema=z.object({file:z.string().refine(isSequenceReferenceFile),backup:z.string().regex(/^\.previous-[a-f0-9-]{36}$/).optional(),
 before:z.object({record:inodeSchema,link:inodeSchema.optional()}).strict().optional(),
 owned:z.object({record:inodeSchema.optional(),link:inodeSchema.optional()}).strict(),committed:z.boolean().optional()}).strict();
const lockSchema=z.object({format:z.literal('harness-reference-mutation'),version:z.literal(1),pid:z.number().int().positive(),startedAt:z.number().nonnegative(),token:z.string().uuid(),retired:z.boolean().optional(),transaction:transactionSchema.optional()}).strict();
type Journal=z.infer<typeof lockSchema>;type Transaction=z.infer<typeof transactionSchema>;
const inode=(info:Inode):Inode=>({dev:info.dev,ino:info.ino});
const newJournal=():Journal=>({format:'harness-reference-mutation',version:1,pid:process.pid,startedAt:Date.now()-process.uptime()*1000,token:randomUUID()});
const recoveryMessage=(reason:string)=>error(`参照素材の接続変更が未完了です（.harness/references/.mutation-lock）。${reason}。素材と退避記録は削除していません。エディターを終了して再起動してください。再起動後も続く場合は、この案件の参照記録の修復が必要です`);
async function optionalStat(path:string){return lstat(path).catch(e=>{if(absent(e))return null;throw e;});}
/** 読む間に持ち主が記録を消した・書き換えた（rename で差し替えた）: 壊れた記録ではなく、読み直せば済む（消すと開いた記録の ctime も進む。APFS で実測）。待てば済む（busy）の扱いにもする。 */
const changingJournal=()=>Object.assign(recoveryMessage('所有者記録が更新中です'),{busy:true,changing:true});
const isChanging=(e:unknown)=>!!(e as {changing?:boolean}|undefined)?.changing;
async function readJournal(path:string){
 let handle:FileHandle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(absent(e))throw changingJournal();throw e;}
 try{const info=await handle.stat();if(!info.isFile()||info.size>32*1024)throw recoveryMessage('所有者を確認できません');
  const value=lockSchema.parse(JSON.parse(await handle.readFile('utf8')));if(identity(info)!==identity(await handle.stat()))throw changingJournal();return {value,info};
 }catch(e){if(e instanceof Error&&e.message.includes('未完了'))throw e;throw recoveryMessage('所有者のない旧形式または破損した記録です');}finally{await handle.close();}
}
function deadOwner(pid:number){try{process.kill(pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}}
// Publish a fully written owner record atomically; an empty marker can never be a new lock.
async function publishJournal(path:string,value:Journal,replace?:Inode){
 const temporary=path+'.owner-'+randomUUID(),handle=await open(temporary,'wx',0o600),owned=await handle.stat();
 try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();
  if(replace){const current=await optionalStat(path);if(!current||!sameInode(current,replace))throw recoveryMessage('所有者記録が置き換わっています');await rename(temporary,path);}
  else await link(temporary,path);
  return owned;
 }finally{await handle.close();await removeOwned(temporary,owned);}
}
async function recoverTransaction(dir:string,t:Transaction){
 const leaf=join(dir,basename(t.file)),metadata=leaf+'.json',backup=t.backup?join(dir,t.backup):undefined;
 // Inspect all leaves before any removal. Unknown objects are never adopted or overwritten.
 const currentLink=await optionalStat(leaf),currentRecord=await optionalStat(metadata),oldLink=backup?await optionalStat(backup):null,oldRecord=backup?await optionalStat(backup+'.json'):null;
 const known=(actual:Stats|null,...owners:(Inode|undefined)[])=>!actual||owners.some(owner=>owner&&sameInode(actual,owner));
 if(!known(currentLink,t.owned.link,t.before?.link)||!known(currentRecord,t.owned.record,t.before?.record)
  ||!known(oldLink,t.before?.link)||!known(oldRecord,t.before?.record))throw recoveryMessage('所有不明のファイルがあり自動修復を中止しました');
 if(t.before){
  const savedPath=oldRecord&&backup?backup+'.json':metadata;
  if(oldRecord||currentRecord&&sameInode(currentRecord,t.before.record)){
   const saved=await readRecord(dir,t.file,savedPath);if(!sameInode(saved.info,t.before.record))throw recoveryMessage('復旧用の台帳が置き換わっています');
   if(t.before.link){const savedLink=oldLink&&backup?backup:currentLink&&sameInode(currentLink,t.before.link)?leaf:undefined;
    if(savedLink&&await readlink(savedLink)!==saved.record.target)throw recoveryMessage('復旧用リンクと台帳が一致しません');}
  }
 }
 if(t.committed){
  if(!currentLink||!currentRecord||!t.owned.link||!t.owned.record||!sameInode(currentLink,t.owned.link)||!sameInode(currentRecord,t.owned.record))throw recoveryMessage('公開済みの参照対が不足しています');
  const record=await readRecord(dir,t.file);if(!currentLink.isSymbolicLink()||await readlink(leaf)!==record.record.target)throw recoveryMessage('公開済みの参照対が一致しません');
  if(backup&&oldLink&&t.before?.link)await removeOwned(backup,t.before.link);if(backup&&oldRecord&&t.before)await removeOwned(backup+'.json',t.before.record);return;
 }
 if(t.before){
  // A missing backup is safe only if the corresponding original is still in place.
  if(!oldRecord&&(!currentRecord||!sameInode(currentRecord,t.before.record)))throw recoveryMessage('復旧用の台帳が不足しています');
  if(t.before.link&&!oldLink&&(!currentLink||!sameInode(currentLink,t.before.link)))throw recoveryMessage('復旧用のリンクが不足しています');
 }
 if(currentRecord&&t.owned.record&&sameInode(currentRecord,t.owned.record))await removeOwned(metadata,t.owned.record);
 if(currentLink&&t.owned.link&&sameInode(currentLink,t.owned.link))await removeOwned(leaf,t.owned.link);
 if(backup&&oldLink&&t.before?.link){
  // Create into an empty path without overwriting; retain backups on conflicts.
  if(await optionalStat(leaf))throw recoveryMessage('復旧先のリンクが使用されています');await symlink(await readlink(backup),leaf);await removeOwned(backup,t.before.link);
 }
 if(backup&&oldRecord&&t.before){await link(backup+'.json',metadata);await removeOwned(backup+'.json',t.before.record);}
}
const recoveries=new Map<string,Promise<void>>();
const JOURNAL_READS=5;
async function recoverMutation(dir:string):Promise<void>{
 const pending=recoveries.get(dir);if(pending)return pending;
 const recovery=(async()=>{
  // 見つけてから読み終えるまでに記録が消えた・書き換わった時は読み直す（消えていれば回収するものは無い）。読み直しても落ち着かなければ busy で投げる。
  const path=join(dir,'.mutation-lock');let initial:Awaited<ReturnType<typeof readJournal>>;
  for(let attempt=1;;attempt++){
   if(!await optionalStat(path))return;
   try{initial=await readJournal(path);break;}catch(e){if(!isChanging(e)||attempt>=JOURNAL_READS)throw e;}
  }
  if(!deadOwner(initial.value.pid)&&!initial.value.retired){
   if(initial.value.pid===process.pid)throw Object.assign(error('参照素材の接続を変更しています。完了後に再試行してください'),{busy:true});
   throw error(`参照素材の接続変更が未完了です（.harness/references/.mutation-lock、PID ${initial.value.pid}、記録開始時刻 ${new Date(initial.value.startedAt).toUTCString()} / startedAt=${initial.value.startedAt}）。別のエディターが処理中なら完了までお待ちください。処理していない場合はエディターを終了して再起動してください。再起動後も続く場合は、この表示を添えて案件の参照記録の修復を依頼してください。所有者を確認できないため、記録や素材は削除していません`);
  }
  // A separate atomically published live owner prevents two editor processes recovering together.
  const guard=join(dir,'.mutation-recovery');const stale=await optionalStat(guard);
  if(stale){const holder=await readJournal(guard);if(!deadOwner(holder.value.pid))throw recoveryMessage('別のエディターが自動修復中です');await removeOwned(guard,holder.info);}
  let owner:Stats;try{owner=await publishJournal(guard,newJournal());}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw recoveryMessage('別のエディターが自動修復中です');throw e;}
  try{const current=await readJournal(path);if(!sameInode(initial.info,current.info)||(!deadOwner(current.value.pid)&&!current.value.retired))throw recoveryMessage('所有者が変わりました');
   if(current.value.transaction){try{await recoverTransaction(dir,current.value.transaction);}catch(e){if(e instanceof Error&&e.message.includes('未完了'))throw e;throw recoveryMessage('退避記録の整合性を確認できません');}}
   else if((await readdir(dir)).some(name=>name.startsWith('.previous-')))throw recoveryMessage('出典が未記録の退避ファイルがあります');
   await removeOwned(path,current.info);
  }finally{await removeOwned(guard,owner);}
 })();recoveries.set(dir,recovery);try{await recovery;}finally{if(recoveries.get(dir)===recovery)recoveries.delete(dir);}
}
async function mutation<T>(project:string,body:(dir:string,journal:(transaction:Transaction)=>Promise<void>)=>Promise<T>):Promise<T>{
 const dir=await directory(project,true),path=join(dir,'.mutation-lock');await recoverMutation(dir);
 const value=newJournal();let info:Stats;
 try{info=await publishJournal(path,value);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Object.assign(error('参照素材の接続変更が未完了です。完了後に再試行してください'),{busy:true});throw e;}
 const journal=async(transaction:Transaction)=>{value.transaction=transaction;info=await publishJournal(path,value,info);};
 let incomplete=false;
 try{return await body(dir,journal);}catch(e){incomplete=!!(e as {incomplete?:boolean}).incomplete;throw e;}finally{if(!incomplete)await removeOwned(path,info);else{value.retired=true;await publishJournal(path,value,info);}}
}
async function inspectSource(source:string,file:string,name:string,signal?:AbortSignal,hooks?:ImportHooks,options?:ImportSourceOptions){
 signal?.throwIfAborted();const path=await realpath(source);
 // 受付時に実パスへ解決済みの素材は、開く直前と開いた後に今も同じ実パスかを確かめる（下の stable() の同一性と合わせて差し替えを断る）。
 if(options?.resolvedSource&&path!==source)throw error(SOURCE_MOVED_MESSAGE);
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat();if(!before.isFile())throw error('参照先が通常のファイルではありません');
  await assertStillResolved(source,options);
  // 開いた実体（handle）もパスの先も、開いた時と同じ dev/ino/size/mtime/ctime のままかを確かめる。中身の上書きと別のファイルへの差し替え（元の実体の ctime が変わる）はどちらの側でも分かる。
  // パスの先でしか分からないのは途中のフォルダの差し替え（開いた実体は何も変わらない）。試験は references.reads.test.ts（ffprobe の読み中の差し替え・上書き・途中のフォルダの差し替え）。
  const stable=async()=>{if(identity(before)!==identity(await handle.stat())||identity(before)!==identity(await stat(path)))throw error('確認中に参照先が変更されました');};
  // 調査とハッシュは同じ開いたファイル（fd）を読む。全体を読むのは下のハッシュ1回だけ（設計 §2-7）。
  // stable() は調査の前・調査の後・ハッシュの後の3回。調査中の差し替えはハッシュに進む前に断り、調べた中身と指紋が別のファイルのものになる登録を作らない。
  await stable();hooks?.onPhase?.('probing');const probed=await probePinnedSequenceAsset(handle,file,signal);
  await stable();hooks?.onProbed?.(probed.streams);hooks?.onPhase?.('fingerprinting');
  const fingerprint=await hashHandle(handle,signal);await stable();
  rememberVerified(path,fingerprint,before);
  return {asset:pinnedSequenceAsset(probed,fingerprint,file,name),path,sizeBytes:before.size,image:probed.image};
 }finally{await handle.close();}
}
async function writeRecord(path:string,record:ReferenceRecord){
 const handle=await open(path,'wx',0o600),owned=await handle.stat();
 try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();return await handle.stat();}
 catch(e){await removeOwned(path,owned);throw e;}finally{await handle.close();}
}

/**
 * 新しい登録（リンクと台帳）だけを公開する。既存の葉は置き換えない（呼び手が mutation の中で既存が無いことを確かめてから呼ぶ）。
 * 確定（committed の記録）の後に投げても、ここで作った葉を消してから投げる（消せなければ incomplete。回収が記録に従って片付ける）。
 */
async function publishReference(dir:string,journal:(transaction:Transaction)=>Promise<void>,asset:SequenceAsset,target:string,sizeBytes:number,beforeLink?:()=>void,signal?:AbortSignal):Promise<{leaf:string;metadata:string;link:Stats;record:Stats}>{
 const leaf=join(dir,basename(asset.file)),metadata=leaf+'.json';signal?.throwIfAborted();let ownedLink:Stats|undefined,ownedRecord:Stats|undefined;
 const transaction:Transaction={file:asset.file,owned:{}};await journal(transaction);
 try{
  beforeLink?.();await symlink(target,leaf);ownedLink=await lstat(leaf);transaction.owned.link=inode(ownedLink);await journal(transaction);
  ownedRecord=await writeRecord(metadata,{format:'harness-reference',version:1,asset,target,generation:randomUUID(),sizeBytes});
  transaction.owned.record=inode(ownedRecord);transaction.committed=true;await journal(transaction);
  signal?.throwIfAborted();return {leaf,metadata,link:ownedLink,record:ownedRecord};
 }catch(e){try{if(ownedRecord)await removeOwned(metadata,ownedRecord);if(ownedLink)await removeOwned(leaf,ownedLink);}catch(cleanup){throw Object.assign(cleanup as Error,{incomplete:true});}throw e;}
}
/** Publishes only new owned leaves. Existing regular files or incomplete registrations are never replaced. */
export async function registerSequenceReference(project:string,source:string,name=basename(source),signal?:AbortSignal,expectedFingerprint?:string):Promise<SequenceAsset>{
 return (await registerSequenceReferenceDetailed(project,source,name,signal,expectedFingerprint)).asset;
}
export async function registerSequenceReferenceDetailed(project:string,source:string,name=basename(source),signal?:AbortSignal,expectedFingerprint?:string,hooks?:ImportHooks,options?:ImportSourceOptions):Promise<RegisteredSequenceAsset>{
 const expected=expectedReferenceFingerprint(expectedFingerprint);
 const extension=(extname(name)||extname(source)).toLowerCase();if(!isSequenceReferenceFile(`.harness/references/${'0'.repeat(64)}${extension}`))throw error('参照できない素材形式です');
 const inspected=await inspectSource(source,`.harness/references/${'0'.repeat(64)}${extension}`,name,signal,hooks,options);
 const verifyExpected=()=>{if(expected!==undefined&&inspected.asset.fingerprint!==expected)throw error('選択した素材の指紋と現在の参照先が一致しません');};
 verifyExpected();
 const asset={...inspected.asset,file:`.harness/references/${inspected.asset.fingerprint}${extension}`};validateAsset(asset);
 let published:{leaf:string;metadata:string;link:Stats;record:Stats}|undefined;
 const result=await mutation(project,async(dir,journal)=>{
  const leaf=join(dir,basename(asset.file)),metadata=leaf+'.json';
  const existing=await lstat(metadata).catch(e=>{if(absent(e))return null;throw e;});
  if(existing){const old=await readRecord(dir,asset.file);if(old.record.asset.fingerprint!==asset.fingerprint||old.record.asset.kind!==asset.kind||old.record.sizeBytes!==inspected.sizeBytes)throw error('既存の参照素材と一致しません');
   const info=await lstat(leaf);if(!info.isSymbolicLink()||await readlink(leaf)!==old.record.target)throw error('既存の参照リンクが不正です');
   // Keep the original target; choosing another path is an explicit reconnect operation.
   return old.record.asset;
  }
  published=await publishReference(dir,journal,asset,inspected.path,inspected.sizeBytes,verifyExpected,signal);return asset;
 });
 try{const lease=await openSequenceReference(project,result,signal);await lease.close();return {asset:result,...(inspected.image?{image:inspected.image}:{})};}
 catch(e){
  // A failed final verification must not leave this request's newly published registration.
  // The mutation lock and inode checks preserve pre-existing or subsequently replaced leaves.
  if(published){const owned=published;await mutation(project,async(_dir,journal)=>{await journal({file:asset.file,owned:{record:inode(owned.record),link:inode(owned.link)}});try{await removeOwned(owned.metadata,owned.record);await removeOwned(owned.leaf,owned.link);}catch(error){throw Object.assign(error as Error,{incomplete:true});}});}
  throw e;
 }
}

/**
 * リンク素材の由来（「BGM として取り込んだ」など）を参照台帳の asset に書き足す。台帳の形・接続先・世代・大きさは変えない。
 * 管理素材は素材の台帳（.harness/assets/…json）に由来を持つが、リンク素材の登録情報はこの参照台帳だけにある。
 * 管理素材の台帳の形で同じ場所へ書くと参照台帳が壊れ、以後の登録・再生が読めなくなっていた（2026-10-15）。
 * 同じ由来なら書かない（読み取り中の素材の台帳を無駄に差し替えない）。差し替えは書き終えた一時ファイルの rename で、読んだ台帳から変わっていない時だけ行う。
 */
export async function recordSequenceReferenceOrigin(project:string,file:string,origin:NonNullable<SequenceAsset['origin']>):Promise<SequenceAsset>{
 if(!isSequenceReferenceFile(file))throw error('参照素材の保存先が不正です');
 return settledMutation(project,async dir=>{
  const old=await readRecord(dir,file);
  if(isDeepStrictEqual(old.record.asset.origin,origin))return old.record.asset;
  const asset:SequenceAsset={...old.record.asset,origin};validateAsset(asset);
  const metadata=join(dir,basename(file)+'.json'),temporary=join(dir,`.origin-${randomUUID()}`);
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify({...old.record,asset})+'\n');await handle.sync();}finally{await handle.close();}
  try{
   const current=await lstat(metadata);if(!sameInode(current,old.info))throw error('由来を記録する間に参照台帳が変更されました');
   await rename(temporary,metadata);
  }catch(e){await unlink(temporary).catch(()=>undefined);throw e;}
  return asset;
 });
}

/** Same bytes, size and kind; saved exact streams remain authoritative. Backups are private leaves, never recursive deletion. */
export async function reconnectSequenceReference(project:string,asset:SequenceAsset,source:string,signal?:AbortSignal):Promise<SequenceAsset>{
 validateAsset(asset);const inspected=await inspectSource(source,asset.file,asset.name,signal);
 if(inspected.asset.fingerprint!==asset.fingerprint||inspected.asset.kind!==asset.kind)throw error('再接続する素材が保存時と一致しません');
 const result=await reconnectInspected(project,asset,inspected,{signal});
 const lease=await openSequenceReference(project,result,signal);await lease.close();return result;
}
/**
 * つなぎ直しの本体（中身は照合済みの inspected.path）。generation を渡すと、台帳の generation がそれと同じ場合だけ確定する（別の操作によるつなぎ直しを上書きしない。設計 §5-6）。
 * onCommitted は、新しい対を確定して元に戻さなくなった時（退避の片付けの前）に呼ぶ。
 */
async function reconnectInspected(project:string,asset:SequenceAsset,inspected:{path:string;sizeBytes:number},options:{signal?:AbortSignal;generation?:string;onCommitted?:()=>void;settle?:boolean}={}):Promise<SequenceAsset>{
 const {signal}=options;
 return (options.settle?settledMutation:mutation)(project,async(dir,journal)=>{
  const leaf=join(dir,basename(asset.file)),metadata=leaf+'.json',old=await readRecord(dir,asset.file);
  if(!isDeepStrictEqual(assetIdentity(old.record.asset),assetIdentity(asset)))throw error('参照素材の文書と台帳が一致しません');
  if(options.generation!==undefined&&old.record.generation!==options.generation)throw new ReferenceGenerationChanged();
  if(old.record.sizeBytes!==inspected.sizeBytes)throw error('再接続する素材の大きさが保存時と一致しません');
  const oldLink=await lstat(leaf).catch(e=>{if(absent(e))return null;throw e;});
  if(oldLink&&(!oldLink.isSymbolicLink()||await readlink(leaf)!==old.record.target))throw error('既存の参照リンクが不正です');
  const token=randomUUID(),backup=join(dir,`.previous-${token}`),backupRecord=backup+'.json';
  let movedLink=false,movedRecord=false,newLink:Stats|undefined,newRecord:Stats|undefined;
  const transaction:Transaction={file:asset.file,backup:basename(backup),before:{record:inode(old.info),...(oldLink?{link:inode(oldLink)}:{})},owned:{}};await journal(transaction);
  try{
   signal?.throwIfAborted();if(oldLink){await rename(leaf,backup);movedLink=true;}
   await rename(metadata,backupRecord);movedRecord=true;
   await symlink(inspected.path,leaf);newLink=await lstat(leaf);transaction.owned.link=inode(newLink);await journal(transaction);
   newRecord=await writeRecord(metadata,{...old.record,target:inspected.path,generation:randomUUID(),sizeBytes:inspected.sizeBytes});
   transaction.owned.record=inode(newRecord);transaction.committed=true;await journal(transaction);
   signal?.throwIfAborted();
  }catch(e){
   try{if(newRecord)await removeOwned(metadata,newRecord);if(newLink)await removeOwned(leaf,newLink);}catch(cleanup){throw Object.assign(cleanup as Error,{incomplete:true});}
   // Do not overwrite an unexpected object added during failure recovery.
   try{
    if(movedLink&&oldLink){await symlink(await readlink(backup),leaf);await removeOwned(backup,oldLink);}
    if(movedRecord){await link(backupRecord,metadata);await removeOwned(backupRecord,old.info);}
   }catch{throw Object.assign(error('参照の再接続が未完了です。既存の記録と退避ファイルを保持しました'),{incomplete:true});}
   throw e;
  }
  options.onCommitted?.();
  try{if(movedLink&&oldLink)await removeOwned(backup,oldLink);if(movedRecord)await removeOwned(backupRecord,old.info);}catch(error){throw Object.assign(error as Error,{incomplete:true});}
  return old.record.asset;
 });
}
export interface ReferenceReadState {path:string;sizeBytes:number;verified:boolean;bytesPerSecond?:number;failed?:true;copying?:true}
/** 案内の判定用: 台帳・リンク・接続先を確かめ、照合済みか・測った速さ（今の大きさ・更新時刻で測ったものだけ）を返す（全体は読まない・照合を始めない）。
 * 未接続・不正は undefined。照合の失敗（中身の不一致・読み取り中の変更・読み取りのエラー）を覚えている間は failed（理由は返さない。
 * 状態確認 sequenceReferenceStatus が mismatch・invalid と答え、エラーのバナーが扱う）。
 * copying: このプロセスのコピーの作業が元を予約している間（claimReferenceCopies から release・drop まで。案内はこの素材を出さない）。 */
export async function referenceReadState(project:string,asset:SequenceAsset):Promise<ReferenceReadState|undefined>{
 let pinned:PinnedReference;try{pinned=await pinSequenceReference(project,asset);}catch{return undefined;}
 try{
  const verifiedNow=await knownVerified(pinned.root,pinned.path,asset.fingerprint,pinned.before),speed=measuredSpeed(pinned.path,pinned.before);
  const failed=!verifiedNow&&rememberedFailure(verificationKey(pinned.path,asset.fingerprint,pinned.before))!==undefined;
  return {path:pinned.path,sizeBytes:pinned.before.size,verified:verifiedNow,...(speed!==undefined?{bytesPerSecond:speed}:{}),...(failed?{failed:true as const}:{}),
   ...(copyClaims.has(pinned.path)?{copying:true as const}:{})};
 }finally{await pinned.close();}
}

// ---- コピーの作業との受け渡し（設計 §5-6・7） ----
/** 同じプロセスの接続の変更（数ミリ秒〜）が終わるのを待つ長さ: 50ms ずつ 100 回（5 秒）。 */
const SETTLE_ATTEMPTS=100,SETTLE_MS=50;
const busy=(e:unknown)=>!!(e as {busy?:boolean}|undefined)?.busy;
const settleWait=()=>new Promise(resolve=>setTimeout(resolve,SETTLE_MS));
/** 同じプロセスの接続の変更が終わるのを待ってから台帳を読む（変更の途中の台帳で結果不明を誤って判定しない）。 */
async function settledDirectory(project:string):Promise<string>{
 for(let attempt=1;;attempt++){
  const dir=await directory(project);
  try{await unlocked(dir);return dir;}catch(e){if(!busy(e)||attempt>=SETTLE_ATTEMPTS)throw e;await settleWait();}
 }
}
/**
 * 入口で別の接続の変更のロックに当たった時（同じプロセスで変更中・確かめてから取るまでの間に取られた）だけ、終わるのを待ってやり直す。
 * 本体を始めた後の失敗はやり直さない（取り込みの束と重なっただけで、コピーを失敗にして完成ファイルを消さない）。
 */
async function settledMutation<T>(project:string,body:(dir:string,journal:(transaction:Transaction)=>Promise<void>)=>Promise<T>):Promise<T>{
 for(let attempt=1;;attempt++){
  let entered=false;
  try{return await mutation(project,(dir,journal)=>{entered=true;return body(dir,journal);});}
  catch(e){if(entered||!busy(e)||attempt>=SETTLE_ATTEMPTS)throw e;await settleWait();}
 }
}
/** 台帳の generation と接続先（コピーの作業の開始時に読む）。 */
export async function referenceConnection(project:string,asset:SequenceAsset):Promise<{generation:string;target:string}>{
 validateAsset(asset);const {record}=await readRecord(await settledDirectory(project),asset.file);
 if(!isDeepStrictEqual(assetIdentity(record.asset),assetIdentity(asset)))throw error('参照素材の文書と台帳が一致しません');
 return {generation:record.generation,target:record.target};
}
/** 台帳の接続先（結果不明の判定に使う）。台帳が無ければ undefined。途中で止まった接続の変更は、読む前に記録に従って回収する。 */
export async function referenceTarget(project:string,file:string):Promise<string|undefined>{
 try{return (await readRecord(await settledDirectory(project),file)).record.target;}catch(e){if(absent(e))return undefined;throw e;}
}
/**
 * 受け渡された照合済みのコピーを開く（リンクをたどらない・待たない）。開いた実体とパスの先が受け渡しの識別情報（5項目）と同じで、その組を
 * copyOneItem がこのプロセスで照合した時だけ、全体を読まずに照合済みとして覚える。そうでなければ（受け渡しの後に変わった・外から組んだ値）、照合の記憶・記録に
 * 無い限り開いた実体の全体を読んで expected と照合する。照合を省く旗にはしない。照合済みの組は案件に照合記録を残す（最後の確認・以後の再生で読み直さない）。
 * path は実パスの解決（native）が返すディスク上の形。受け渡しの path と違ってよいのは Unicode の正規化（NFC/NFD）だけで、途中のリンク・大文字小文字の違いは断る。
 * 台帳の接続先・照合の記憶はこの path で持つ（開く時の実パスの解決と同じ形）。
 */
async function adoptVerifiedCopy(project:string,copy:VerifiedCopy,expected:string,signal?:AbortSignal):Promise<{handle:FileHandle;info:Stats;path:string}>{
 if(!/^[a-f0-9]{64}$/.test(copy.fingerprint)||!isAbsolute(copy.path))throw error('受け渡された素材が不正です');
 const path=await realpath(copy.path);if(path.normalize('NFC')!==copy.path.normalize('NFC'))throw error('受け渡された素材の場所が変わりました');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await handle.stat();if(!info.isFile())throw error('受け渡された素材が通常のファイルではありません');
  const stable=async()=>{if(identity(info)!==identity(await handle.stat())||identity(info)!==identity(await stat(path)))throw error('確認中に受け渡された素材が変更されました');};
  await stable();const root=await realpath(project);
  const handed=copy.fingerprint===expected&&identity(info)===identity(copy.identity)&&copiedAndVerified(copy.path,copy.fingerprint,copy.identity);
  if(!handed&&!await knownVerified(root,path,expected,info)){
   const digest=await hashHandle(handle,signal);await stable();
   if(digest!==expected)throw error('受け渡された素材の中身が素材の指紋と一致しません');
  }
  rememberVerified(path,expected,info);await persistVerified(root,path,expected,info);
  return {handle,info,path};
 }catch(e){await handle.close();throw e;}
}
/** 確定した後か、確定したか分からない失敗（片付けの失敗）なら結果不明にする。確定の前の失敗（元に戻した）はそのまま投げる。 */
const unknownAfter=(committed:boolean)=>(e:unknown):never=>{if(committed||(e as {incomplete?:boolean}).incomplete)throw new ReferenceConnectUnknown(e);throw e;};
/** 接続を確定した後の最後の確認。失敗は結果不明（呼び手が台帳の接続先で判定する。設計 §5-7）。 */
async function finalCheck(project:string,asset:SequenceAsset,signal?:AbortSignal){
 try{await referenceVerificationTesting.afterConnect?.();const lease=await openSequenceReference(project,asset,signal);await lease.close();}catch(e){throw new ReferenceConnectUnknown(e);}
}
/**
 * 開いた時のコピー: 台帳の generation が作業の開始時と同じ場合だけ、照合済みのコピーへつなぎ直す（別の操作のつなぎ直しは ReferenceGenerationChanged で上書きしない）。
 * 確定した後の失敗・最後の確認の失敗は ReferenceConnectUnknown（設計 §5-6・7）。
 */
export async function reconnectSequenceReferenceVerified(project:string,asset:SequenceAsset,copy:VerifiedCopy,expectedGeneration:string):Promise<void>{
 validateAsset(asset);if(copy.fingerprint!==asset.fingerprint)throw error('コピーした素材の指紋が素材の記録と一致しません');
 const {handle,info,path}=await adoptVerifiedCopy(project,copy,asset.fingerprint);let committed=false;
 try{await reconnectInspected(project,asset,{path,sizeBytes:info.size},{generation:expectedGeneration,settle:true,onCommitted:()=>{committed=true;}}).catch(e=>unknownAfter(committed)(e));}
 finally{await handle.close();}
 await finalCheck(project,asset);
}
/**
 * 追加時のコピー: 照合済みのコピーを新しい場所でリンク登録する。調べるのは見出し（ffprobe に開いた fd を渡す）だけで、全体は読まない。
 * 同じ指紋の登録が既にあれば、登録ではなくつなぎ直しへ分岐する（既存の登録は元の接続先を保つので、そのままではカードを指し続ける。設計 §5-6）。
 */
export async function registerSequenceReferenceVerified(project:string,copy:VerifiedCopy,name:string,signal?:AbortSignal):Promise<{asset:SequenceAsset;branch:'registered'|'reconnected'}>{
 const extension=(extname(name)||extname(copy.path)).toLowerCase(),file=`.harness/references/${copy.fingerprint}${extension}`;if(!isSequenceReferenceFile(file))throw error('参照できない素材形式です');
 const {handle,info,path}=await adoptVerifiedCopy(project,copy,copy.fingerprint,signal);let asset:SequenceAsset;
 try{
  asset=pinnedSequenceAsset(await probePinnedSequenceAsset(handle,file,signal),copy.fingerprint,file,name);validateAsset(asset);
  if(identity(await handle.stat())!==identity(info)||identity(await stat(path))!==identity(info))throw error('受け渡された素材が調査中に変更されました');
 }finally{await handle.close();}
 let committed=false;
 const existing=await settledMutation(project,async(dir,journal)=>{
  if(await optionalStat(join(dir,basename(file))+'.json')){
   const old=await readRecord(dir,file);if(old.record.asset.kind!==asset.kind||old.record.sizeBytes!==info.size)throw error('既存の参照素材と一致しません');return old.record;
  }
  await publishReference(dir,journal,asset,path,info.size,undefined,signal);committed=true;return undefined;
 }).catch(e=>unknownAfter(committed)(e));
 if(existing){await reconnectSequenceReferenceVerified(project,existing.asset,copy,existing.generation);return {asset:existing.asset,branch:'reconnected'};}
 await finalCheck(project,asset,signal);return {asset,branch:'registered'};
}
