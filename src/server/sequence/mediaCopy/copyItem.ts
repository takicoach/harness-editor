import {createHash,randomBytes} from 'node:crypto';
import type {Stats} from 'node:fs';
import {extname,join} from 'node:path';
import {CREATE_EXCLUSIVE,READ_ONLY,isSimulatedCrash,type CopyFile,type CopyIo,type IoPurpose} from './io';
import {CopyFolderError,type CopyFolder} from './volumes';

export interface Inode {dev:number;ino:number}
export interface FileIdentity extends Inode {size:number;mtimeMs:number;ctimeMs:number}
const identityOf=(info:Stats):FileIdentity=>({dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs});
const sameIdentity=(a:FileIdentity,b:FileIdentity)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const sameInode=(a:Inode,b:Inode)=>a.dev===b.dev&&a.ino===b.ino;
/**
 * ino がファイルを見分けられる確かな数か。exFAT（macOS 26 の FSKit で実測）は空のファイルの ino が全部同じ仮の値（Number で 2^64 に丸まった値）で、
 * 初めて書いた時に先頭クラスタ番号になる。仮の値は照合にも記録にも使わない（ジョブ記録の zod の int() も安全な整数しか通さない）。
 */
const identifiable=(inode:Inode)=>Number.isSafeInteger(inode.ino)&&inode.ino>=0&&Number.isSafeInteger(inode.dev);
const codeOf=(error:unknown)=>(error as NodeJS.ErrnoException|undefined)?.code;
export const PART_SUFFIX='.harness-part',CHUNK=4*1024*1024,MAX_NAMES=99;
/** フォルダーの中の1つの名前（区切り・NUL を含まない。「.」「..」は呼び手が別に断る）。 */
const SINGLE_NAME=/^[^/\0]+$/;
/** .part に初めて書く量。exFAT は初めて書いた時に ino が決まるので、少しだけ書いてすぐ記録し、記録の無い実体が残りうる量を小さくする。 */
const FIRST_WRITE=4096;
/** 予約に書く印（乱数）の大きさ。exFAT では空の予約を ino で見分けられないため、印を書いて同期してから実体を記録し、置き換える前と片付けの前に印の中身を確かめる。 */
export const RESERVATION_MARK_BYTES=16;
export class CopySourceChangedError extends Error{constructor(message:string){super(message);this.name='CopySourceChangedError';}}
/**
 * コピーの元。expectedFingerprint: 期待する指紋（違えばコピー中に止める）。expectedFrom: その指紋の出どころ（理由の文言を分ける）。
 * registered（既定）は開いた時（登録した素材の指紋）、chosen は追加時（画面で選んだ時の素材の指紋）。
 */
export interface CopySource {path:string;expectedFingerprint?:string;expectedFrom?:'registered'|'chosen'}
const SOURCE_MISMATCH={registered:'元の素材の中身が登録時と一致しません',chosen:'選んだ時の素材と中身が一致しません'} as const;
export class ReservationLostError extends Error{constructor(message:string){super(message);this.name='ReservationLostError';}}
export class CopyVerifyError extends Error{constructor(message:string){super(message);this.name='CopyVerifyError';}}
/**
 * 作業の記録に残す「自分が作った実体」。reused は既にあった同じ中身のファイル（消さない）、connected は接続を変えた（消さない）。
 * reserved.token は予約に書いた印（16 バイトの16進）。予約は作る前に印だけで記録し（dev・ino なし）、ino を確かめられた時に dev・ino を足す。part も作る前に名前だけで記録し、ino を確かめられた時に dev・ino を足す。part の size・mtimeMs は読み直して確かめた後に記録する（rename 済みの .part を完成名で見分けるため）。
 * final は確定した実体の dev・ino・大きさ・更新時刻（exFAT は付け直しで同じ番号が別のファイルに使われるので ino だけでは見分けない）。
 */
export interface OwnedCopyFiles {finalName?:string;reserved?:Partial<Inode>&{token:string};reused?:boolean;part?:Partial<Inode>&{name:string;size?:number;mtimeMs?:number};final?:Inode&{size:number;mtimeMs:number};connected?:boolean}
export type CopyStepPhase='copying'|'verifying'|'named';
/**
 * phase は段が変わるたびに呼ぶ（呼び手が記録を書く。書けなければ投げて止める）。値が undefined の項目は記録から消す。
 * 呼び手は記録（メモリ）を先に変えてから書く: phase が投げても、片付けはパッチを含む記録に従う（作った実体を記録から落とさない）。記録する ino はどれも安全な整数。
 * progress は書き込みの1回ごと（書いた後）に呼ぶ。空きの監視（SpaceMonitor.wrote）はここで行い、投げればコピーは止まる。
 */
export interface CopyItemHooks {phase(phase:CopyStepPhase,patch:Partial<OwnedCopyFiles>&{sourceIdentity?:FileIdentity;fingerprint?:string}):Promise<void>;progress(bytes:number):Promise<void>;signal:AbortSignal}
/** sourceIdentity は元を最後まで読んで照合した時だけ（元の照合済みとして使える）。 */
export interface CopiedFile {path:string;fingerprint:string;identity:FileIdentity;reused:boolean;sourceIdentity?:FileIdentity}
/**
 * このプロセスの copyOneItem が照合して返した完成ファイル（パス → 指紋と識別情報の5項目）。書くのは copyOneItem の成功だけで、外から足す口は無い。
 * 参照台帳は、受け渡された値がここにあり、開いた実体の識別情報も同じ時だけ全体を読み直さない（設計 §5-6）。HTTP・MCP から渡された値はここに無い限り信じない。
 */
const vouched=new Map<string,string>();
const vouchKey=(fingerprint:string,info:FileIdentity)=>JSON.stringify([fingerprint,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);
/**
 * このプロセスの copyOneItem が最後まで読んで照合した元のファイル（実パス → 指紋と、読み終えた時に開いた実体とパスの先で確かめた識別情報の5項目）。
 * 書くのは sourceIdentity を返した成功だけ（既存の完成ファイルを再利用して元を読まなかった時は書かない）。参照台帳がコピーの間に外した照合を読まずに終える条件（設計 §5 の調停）。
 */
const sourcesRead=new Map<string,string>();
function vouch(sourcePath:string,copied:CopiedFile):CopiedFile{
  vouched.delete(copied.path);vouched.set(copied.path,vouchKey(copied.fingerprint,copied.identity));while(vouched.size>256)vouched.delete(vouched.keys().next().value!);
  if(copied.sourceIdentity){sourcesRead.delete(sourcePath);sourcesRead.set(sourcePath,vouchKey(copied.fingerprint,copied.sourceIdentity));while(sourcesRead.size>256)sourcesRead.delete(sourcesRead.keys().next().value!);}
  return copied;
}
/** copyOneItem がこのプロセスで照合した組か（パス・指紋・識別情報の5項目がすべて同じ時だけ true）。 */
export function copiedAndVerified(path:string,fingerprint:string,info:FileIdentity):boolean{return vouched.get(path)===vouchKey(fingerprint,info);}
/** copyOneItem がこのプロセスで元（実パス）を読み切って照合した組か（パス・指紋・識別情報の5項目がすべて同じ時だけ true）。 */
export function sourceReadAndVerified(path:string,fingerprint:string,info:FileIdentity):boolean{return sourcesRead.get(path)===vouchKey(fingerprint,info);}
/** 試験専用: 再起動に相当（このプロセスで照合した記憶を消す）。 */
export const copyItemTesting={forget(){vouched.clear();sourcesRead.clear();}};
export function alternateName(name:string,k:number):string{if(k<=1)return name;const ext=extname(name),stem=ext?name.slice(0,-ext.length):name;return `${stem} (${k})${ext}`;}
/** `<完成名>.<乱数>.harness-part`。名前の上限（255 バイト）を超える時は完成名の部分を文字の途中で切らずに縮める（記録は名前で持つので完成名を含む必要はない）。 */
function partNameFor(finalName:string):string{
  const tail=`.${randomBytes(8).toString('hex')}${PART_SUFFIX}`,chars=Array.from(finalName);
  while(chars.length&&Buffer.byteLength(chars.join('')+tail)>255)chars.pop();
  return chars.join('')+tail;
}
/** body の失敗を閉じる時の失敗で覆わない。body が成功した時だけ、閉じる時の失敗を投げる。 */
async function closing<T>(file:CopyFile,body:()=>Promise<T>):Promise<T>{
  let result:T;
  try{result=await body();}catch(error){await file.close().catch(()=>undefined);throw error;}
  await file.close();return result;
}
const sourceChanged=()=>new CopySourceChangedError('コピー中に元の素材が変更されました。元の素材を確かめてから、もう一度コピーしてください');
const unidentifiable=()=>new Error('コピー先のドライブで作ったファイルを見分けられないため、止めました');

/** path をリンクをたどらずに読み取り専用で開いて SHA-256 を出す。開いた実体が expect と違う・読む間に大きさ・時刻が変わった時は CopyVerifyError。 */
async function hashFile(io:CopyIo,path:string,purpose:IoPurpose,signal:AbortSignal,expect?:Inode):Promise<{fingerprint:string;info:Stats}>{
  const file=await io.open(path,READ_ONLY);
  return closing(file,async()=>{
    const info=await file.stat();if(!info.isFile()||!identifiable(info)||(expect&&!sameInode(info,expect)))throw new CopyVerifyError('照合するファイルが入れ替わっています');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK);let position=0;
    while(true){
      signal.throwIfAborted();const n=await file.read(buffer,position);if(!n)break;position+=n;if(position>info.size)break;
      hash.update(buffer.subarray(0,n));await io.throttle(purpose,path,n,signal);
    }
    if(position!==info.size||!sameIdentity(identityOf(await file.stat()),identityOf(info)))throw new CopyVerifyError('照合中にファイルが変わりました');
    return {fingerprint:hash.digest('hex'),info};
  });
}
interface Candidate {name:string;fingerprint:string;info:Stats}
/**
 * 既にある名前のファイルが、元と同じ大きさの通常のファイルなら指紋を出す（リンクをたどらず読み取り専用で読む。書かない・消さない）。
 * 比べられないもの（リンク・フォルダー・大きさ違い・読む権限がない・読む間に変わった・消えた）は undefined で、別名へ進む。読めない（EIO など）は止める。
 */
async function comparable(io:CopyIo,path:string,size:number,signal:AbortSignal):Promise<Omit<Candidate,'name'>|undefined>{
  let info:Stats;try{info=await io.lstat(path);}catch(error){if(codeOf(error)==='ENOENT')return undefined;throw error;}
  if(info.isSymbolicLink()||!info.isFile()||info.size!==size||!identifiable(info))return undefined;
  try{return await hashFile(io,path,'verify',signal,info);}
  catch(error){if(error instanceof CopyVerifyError||['ENOENT','ELOOP','EACCES','EPERM'].includes(codeOf(error)??''))return undefined;throw error;}
}
/**
 * 照合した実体がフォルダーの中で実際に持っている名前（大文字小文字・正規化はディスク上のまま）。照合した時から変わっていない（dev・ino・大きさ・時刻）ものだけ。
 * 見つからなければ undefined（再利用しない）。
 */
async function onDiskName(io:CopyIo,folderPath:string,name:string,info:Stats):Promise<string|undefined>{
  const fold=(value:string)=>value.normalize('NFC').toLowerCase(),entries=await io.readdir(folderPath);
  for(const entry of [...entries.filter(item=>item===name),...entries.filter(item=>item!==name&&fold(item)===fold(name))]){
    let now:Stats;try{now=await io.lstat(join(folderPath,entry));}catch(error){if(isSimulatedCrash(error))throw error;continue;}
    if(!now.isSymbolicLink()&&now.isFile()&&sameIdentity(identityOf(now),identityOf(info)))return entry;
  }
  return undefined;
}
/** 選んだ時のコピー先フォルダー（dev・ino）のままか。作った実体の dev もフォルダーと同じか。確かめられない時も止める（作業全体を止める CopyFolderError）。 */
async function assertFolder(io:CopyIo,folder:CopyFolder,created?:Inode):Promise<void>{
  let info:Stats;
  try{info=await io.lstat(folder.path);}catch(error){if(isSimulatedCrash(error))throw error;throw new CopyFolderError('コピー先のフォルダーを確かめられません',{cause:error});}
  if(info.isSymbolicLink()||!info.isDirectory()||!sameInode(info,folder)||(created&&created.dev!==folder.dev))throw new CopyFolderError('コピー先のフォルダーが作業中に置き換えられました');
}
/**
 * path が自分の予約か: リンクをたどらず・待たずに開き（FIFO でも戻る）、通常のファイルで、大きさが印と同じで中身が記録した印であること。記録に dev・ino があればそれも同じこと。
 * empty: 印を書く前（大きさ 0）も自分の予約とみなす（片付けだけ。dev・ino の記録がある時だけ。ino は確かめられた時にしか記録していないので、exFAT の空のファイルの仮の値とは一致しない）。
 * dev・ino の無い記録（作る前に印だけで記録した予約）は、名前・大きさ・印の中身で判定する（中身で確かめるので、名前だけで消すことにはならない）。
 */
async function holdsReservation(io:CopyIo,path:string,reserved:Partial<Inode>&{token:string},devOf:(dev:number)=>number=dev=>dev,empty=false):Promise<boolean>{
  let file:CopyFile;
  try{file=await io.open(path,READ_ONLY);}catch(error){if(['ENOENT','ELOOP'].includes(codeOf(error)??''))return false;throw error;}
  return closing(file,async()=>{
    const info=await file.stat();
    const pinned=reserved.dev!==undefined&&reserved.ino!==undefined;
    if(!info.isFile()||!identifiable(info)||(pinned&&(info.dev!==devOf(reserved.dev!)||info.ino!==reserved.ino)))return false;
    if(empty&&pinned&&info.size===0)return true;
    if(info.size!==RESERVATION_MARK_BYTES)return false;
    const buffer=Buffer.alloc(RESERVATION_MARK_BYTES);return await file.read(buffer,0)===RESERVATION_MARK_BYTES&&buffer.toString('hex')===reserved.token;
  });
}
type Reservation={kind:'reused';copied:CopiedFile}|{kind:'reserved';finalName:string;reserved:Inode&{token:string};candidates:Candidate[]};
/**
 * 2. 完成名を先に排他作成（wx）で予約し、16 バイトの印（乱数）を書いて同期する。既にあれば、大きさと指紋が一致する時だけそれを使う（消す対象にしない）。違えば別名で同じ手順。
 * 名前と印は作る前に記録し（dev・ino なし）、実体は閉じる前に記録し直す。ino を確かめられれば作った直後（APFS）、確かめられなければ印を書いた後（exFAT: 書くまで ino が仮の値）。
 * 追加時（期待する指紋が無い）は、同じ大きさの既存の指紋を覚えて次の名前を予約する（コピーしながら出した指紋と同じなら、後で既存を使う）。
 */
async function reserveName(io:CopyIo,before:FileIdentity,source:{expectedFingerprint?:string},target:{folder:CopyFolder;name:string},hooks:CopyItemHooks):Promise<Reservation>{
  const candidates:Candidate[]=[];
  for(let k=1;k<=MAX_NAMES;k++){
    hooks.signal.throwIfAborted();
    const name=alternateName(target.name,k),path=join(target.folder.path,name),mark=randomBytes(RESERVATION_MARK_BYTES),token=mark.toString('hex');let handle:CopyFile;
    await hooks.phase('copying',{finalName:name,reserved:{token},reused:false,sourceIdentity:before});
    try{handle=await io.open(path,CREATE_EXCLUSIVE,0o644);}
    catch(error){
      if(codeOf(error)!=='EEXIST')throw error;
      // 既にあるのは自分の予約ではない: 読み比べる前に記録から予約を外す（比べる間の中止・失敗で、他人のファイルや接続済みのコピーを「自分のもの」として扱わない）
      await hooks.phase('copying',{reserved:undefined});
      const existing=await comparable(io,path,before.size,hooks.signal);if(!existing)continue;
      if(source.expectedFingerprint===undefined){candidates.push({name,...existing});continue;}
      if(existing.fingerprint!==source.expectedFingerprint)continue;
      const actual=await onDiskName(io,target.folder.path,name,existing.info);if(!actual)continue;
      await hooks.phase('named',{finalName:actual,reused:true,reserved:undefined,sourceIdentity:undefined});
      return {kind:'reused',copied:{path:join(target.folder.path,actual),fingerprint:existing.fingerprint,identity:identityOf(existing.info),reused:true}};
    }
    const reserved=await closing(handle,async()=>{
      const record=(info:Inode)=>hooks.phase('copying',{reserved:{dev:info.dev,ino:info.ino,token}});
      const created=await handle.stat();if(identifiable(created))await record(created);
      await writeAll(handle,mark,0);await handle.sync();
      const marked=await handle.stat();if(!identifiable(marked))throw unidentifiable();
      if(!identifiable(created)||!sameInode(created,marked))await record(marked);
      return {dev:marked.dev,ino:marked.ino,token};
    });
    await assertFolder(io,target.folder,reserved);
    return {kind:'reserved',finalName:name,reserved,candidates};
  }
  throw new Error(`コピー先に「${target.name}」と同じ名前のファイルが多すぎるため、名前を決められません`);
}
async function writeAll(file:CopyFile,data:Buffer,position:number){
  let done=0;while(done<data.length){const n=await file.write(data.subarray(done),position+done);if(n<=0)throw Object.assign(new Error('書き込めませんでした'),{code:'EIO'});done+=n;}
}
/**
 * 3. <名前>.<乱数>.harness-part の名前を記録してから wx で作り、元を同じファイルハンドルで読みながら SHA-256 を計算して書く。実体は閉じる前に記録する
 * （ino を確かめられれば作った直後、そうでなければ先頭の数 KB を初めて書いた直後に同じハンドルで取り直して記録してから残りを書く。exFAT は初めて書いた時に ino が先頭クラスタ番号に変わる）。
 * 読み終えた時に、開いた実体と大きさ・時刻が変わっていないこと、パスが同じ実体を指すことを確かめ、期待する指紋と照合する。4. 同期（fsync）する。
 */
async function writePart(io:CopyIo,src:CopyFile,before:FileIdentity,source:CopySource,folder:CopyFolder,finalName:string,hooks:CopyItemHooks):Promise<{part:Inode&{name:string};fingerprint:string;written:Stats}>{
  // 取り消しは .part を作る前と、.part を記録した後でだけ受ける（exFAT では先頭を書くまで空の .part を記録で見分けられないので、取り消しでその実体を残さない）
  const {signal}=hooks;signal.throwIfAborted();
  // 予約と同じく、作る前に名前だけを記録する（exFAT では先頭を書くまで ino を確かめられない。その間に止まっても、残った空の .part を名前で報告できる。名前だけでは消さない）
  const name=partNameFor(finalName);await hooks.phase('copying',{part:{name}});signal.throwIfAborted();
  const out=await io.open(join(folder.path,name),CREATE_EXCLUSIVE,0o644);
  return closing(out,async()=>{
    let part:(Inode&{name:string})|undefined;
    const record=async(info:Inode)=>{part={name,dev:info.dev,ino:info.ino};await hooks.phase('copying',{part});};
    const created=await out.stat();if(identifiable(created))await record(created);
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHUNK);let position=0;
    while(true){
      if(part)signal.throwIfAborted();const n=await src.read(buffer,position);if(!n)break;
      if(position+n>before.size)throw sourceChanged();   // 伸び続けるファイルを読み続けない
      hash.update(buffer.subarray(0,n));
      if(position===0){
        const head=Math.min(n,FIRST_WRITE);await writeAll(out,buffer.subarray(0,head),0);
        const now=await out.stat();if(!identifiable(now))throw unidentifiable();if(!part||!sameInode(part,now))await record(now);
        if(head<n)await writeAll(out,buffer.subarray(head,n),head);
      }else await writeAll(out,buffer.subarray(0,n),position);
      position+=n;await io.throttle('copy',source.path,n,signal);await hooks.progress(n);
    }
    if(position!==before.size||!sameIdentity(identityOf(await src.stat()),before)||!sameIdentity(identityOf(await io.stat(source.path)),before)||await io.realpath(source.path)!==source.path)
      throw sourceChanged();
    const fingerprint=hash.digest('hex');
    if(source.expectedFingerprint!==undefined&&fingerprint!==source.expectedFingerprint)throw new CopySourceChangedError(SOURCE_MISMATCH[source.expectedFrom??'registered']);
    // macOS の fsync は libuv が F_FULLFSYNC を使う
    await out.sync();
    const written=await out.stat();if(!part||!sameInode(written,part))throw new CopyVerifyError('コピー中のファイルを確かめられません');
    return {part,fingerprint,written};
  });
}
/**
 * 1本のコピー（設計 §5 の手順 1〜5）。接続の変更（手順 6・7）は呼び手（jobs.ts）が行う。片付けはしない（呼び手が記録に従って removeOwnedCopyFiles で行う）。
 * source.path は実パス（リンクを含まない。fs.realpath の結果と一致する）であること。違えば何も作らずに止める。空（0 バイト）の元も何も作らずに断る。
 * 元の媒体には書かない: 元はリンクをたどらずに読み取り専用で開き、読むだけ。既にある他人のファイルは読み取り専用で読むだけで、書き込み・移動・削除の対象にしない。
 * 既知の限界: rename の直前の確認と rename の間（数マイクロ秒）に完成名が差し替えられると、それを置き換えうる（Node に macOS の排他的 rename〈renamex_np の RENAME_EXCL〉が無いため）。
 * 予約は作る前に名前と印を記録するので、印を書いた後に止まれば中身で見分けて消せる。記録で見分けられないまま残りうるのは、exFAT で予約を作ってから印を書くまで（空のファイル）と、
 * .part を作ってから先頭の数 KB を書いて記録するまで（APFS は作った直後に記録するので、この窓は無い）。どちらも強制終了・書き込みの失敗の時だけで、取り消しはこの窓では受けない。名前だけでは消さない。
 * どちらも名前は作る前に記録してあるので、残った空のファイルは片付け・回収で「自分のものと確かめられずに残したもの」（kept）として報告される（exFAT の実機で確認: exfat.e2e.test.ts）。
 * 返した結果（照合した実体）は copiedAndVerified に、元を読み切って照合した組は sourceReadAndVerified に覚える（参照台帳が受け渡しを信じる条件）。
 */
export async function copyOneItem(io:CopyIo,source:CopySource,target:{folder:CopyFolder;name:string},hooks:CopyItemHooks):Promise<CopiedFile>{
  return vouch(source.path,await copyAndVerify(io,source,target,hooks));
}
async function copyAndVerify(io:CopyIo,source:CopySource,target:{folder:CopyFolder;name:string},hooks:CopyItemHooks):Promise<CopiedFile>{
  const {signal}=hooks,{folder}=target;signal.throwIfAborted();
  // 完成名は1つの名前（区切り・「.」「..」を含まない）。違えば何も作らずに断る（フォルダーの外や下に作らない）
  if(!SINGLE_NAME.test(target.name)||target.name==='.'||target.name==='..')throw new Error('コピー先の名前が正しくありません（1つのファイル名ではありません）');
  // 1. 元のファイルをリンクをたどらずに読み取り専用で開き、開いた実体と大きさ・時刻を記録する（元の媒体には書かない）。元は読み終えたら閉じる
  const src=await io.open(source.path,READ_ONLY);
  const staged=await closing(src,async()=>{
    const opened=await src.stat();if(!opened.isFile())throw new CopySourceChangedError('元の素材が通常のファイルではありません');
    if(opened.size===0)throw new CopySourceChangedError('元の素材が空（0 バイト）のため、コピーしません');
    const before=identityOf(opened);
    if(await io.realpath(source.path)!==source.path||!sameIdentity(identityOf(await io.stat(source.path)),before))throw new CopySourceChangedError('元の素材の場所が変わりました');
    const slot=await reserveName(io,before,source,target,hooks);if(slot.kind==='reused')return slot;
    return {...slot,...await writePart(io,src,before,source,folder,slot.finalName,hooks),before};
  });
  if(staged.kind==='reused')return staged.copied;
  const {finalName,reserved,part,fingerprint,written,before}=staged,finalPath=join(folder.path,finalName),partPath=join(folder.path,part.name);
  // 追加時に同じ名前・同じ中身のファイルが既にあった: 照合した時のままなら、自分の .part と予約を消して既存を使う（既存は消す対象にしない）
  const same=staged.candidates.find(candidate=>candidate.fingerprint===fingerprint);
  const actual=same&&await onDiskName(io,folder.path,same.name,same.info);
  if(same&&actual){
    // 自分のものと確かめられずに残したもの（kept）があれば、記録から落とさずに止める（再利用に切り替えると記録の予約と名前が合わなくなる）
    const cleaned=await removeOwnedCopyFiles(io,folder.path,{finalName,reserved,part});
    if(cleaned.kept.length)throw cleaned.kept.includes(finalName)?new ReservationLostError('コピー先の同じ名前のファイルが作業中に置き換えられたため、止めました（そのファイルには触れていません）')
      :new CopyVerifyError('コピー中のファイルが作業中に置き換えられたため、止めました（そのファイルには触れていません）');
    await hooks.phase('named',{finalName:actual,reused:true,part:undefined,reserved:undefined});
    return {path:join(folder.path,actual),fingerprint,identity:identityOf(same.info),reused:true,sourceIdentity:before};
  }
  // 4. 読み直して同じ指紋か確かめる。読み直す前に、確かめた後の大きさ・時刻を記録する（rename の後に止まっても完成名で自分の .part と見分けられる）
  const verified={...part,size:written.size,mtimeMs:written.mtimeMs};
  await hooks.phase('verifying',{fingerprint,part:verified});
  const reread=await hashFile(io,partPath,'verify',signal,part);
  if(reread.fingerprint!==fingerprint)throw new CopyVerifyError('コピー先で読み直した中身が元と一致しません');
  // 5. 名前を確定する前の最後の取り消しの機会（確定した後は接続の変更まで行う）
  signal.throwIfAborted();
  // 予約した完成名の実体（dev・ino・大きさ・印の中身）が変わっていないことを確かめてから、.part を完成名へ rename する（自分の予約だけを置き換える）
  await assertFolder(io,folder);
  if(!await holdsReservation(io,finalPath,reserved))
    throw new ReservationLostError('コピー先の同じ名前のファイルが作業中に置き換えられたため、止めました（そのファイルには触れていません）');
  const staging=await io.lstat(partPath);
  if(staging.isSymbolicLink()||!staging.isFile()||!sameInode(staging,part)||staging.size!==verified.size||staging.mtimeMs!==verified.mtimeMs||staging.mtimeMs!==reread.info.mtimeMs)
    throw new CopyVerifyError('照合した後にコピー中のファイルが変わりました');
  await io.rename(partPath,finalPath);
  const named=await io.lstat(finalPath);
  if(named.isSymbolicLink()||!named.isFile()||!sameInode(named,part)||named.size!==verified.size||named.mtimeMs!==verified.mtimeMs)throw new ReservationLostError('確定した名前のファイルを確かめられません');
  // 確定した名前をドライブに残す（フォルダーを fsync する。exFAT でも使えることを実測で確認済み）。記録から .part と予約を外すのは同期の後
  // （rename の直後に抜かれてディスク上は .part の名前のままでも、記録に .part と予約が残り、回収で見分けられる）
  const dir=await io.open(folder.path,READ_ONLY);await closing(dir,()=>dir.sync());
  await hooks.phase('named',{final:{dev:named.dev,ino:named.ino,size:named.size,mtimeMs:named.mtimeMs},part:undefined,reserved:undefined});
  // 確定名で開き直し、照合した実体（dev・ino・大きさ・更新時刻）のままかを確かめて、受け渡す識別情報にする（rename で ctime は変わる）
  const file=await io.open(finalPath,READ_ONLY);
  return closing(file,async()=>{
    const info=await file.stat();
    if(!sameInode(info,part)||info.size!==before.size||info.mtimeMs!==verified.mtimeMs)throw new CopyVerifyError('確定したファイルが照合した時と違います');
    return {path:finalPath,fingerprint,identity:identityOf(info),reused:false,sourceIdentity:before};
  });
}
/**
 * 失敗・取り消し時に消すのは、記録にある自分の .part と、自分が作った（再利用ではない）完成名のうち接続を変えていないものだけ。消す前に実体を照合する（設計 §5）。
 * .part: dev・ino（名前だけの記録〈作る前・exFAT で先頭を書く前〉は確かめられないので、あれば消さずに kept）。完成名: 確定した実体（dev・ino・大きさ・更新時刻）、rename 済みの自分の .part（読み直した後の記録がある時だけ。rename と記録の間で止まった時）、
 * 自分の予約（大きさ・印の中身と、記録があれば dev・ino。dev・ino の記録がある時は印を書く前の大きさ 0 も）のどれかと一致する時だけ消す。ino が確かな数でない実体（exFAT の空のファイル）は消さない。
 * 合わないもの（別の実体・印の違う予約・中身の入った予約・リンク・フォルダー・フォルダーの外を指す名前）は消さずに kept に返す。無いものはどちらにも入れない。
 * devOf: 回収で、記録した dev を今の dev に読み替える（再接続で dev が変わる）。
 * 既知の限界: 確かめてから unlink するまでの間（数マイクロ秒）に差し替えられたものは消しうる（パスで消すため）。
 * 既知の限界: 別のエディター（生きている別のプロセス）が回収している間に新しいコピーを始めると、回収が消そうとしている完成コピーを、新しい作業が既存の同じ中身のファイルとして
 * 再利用しうる（窓は回収にかかる間）。開始の前に回収の札を見回り、別の生きているプロセスが札を持つ間は開始を 409 で断って狭めている（recoveryHeldElsewhere）。
 */
export async function removeOwnedCopyFiles(io:CopyIo,folderPath:string,owned:OwnedCopyFiles,devOf:(dev:number)=>number=dev=>dev):Promise<{removed:string[];kept:string[]}>{
  const removed:string[]=[],kept:string[]=[];
  const matches=(info:Stats,expected:Partial<Inode>&{size?:number;mtimeMs?:number})=>expected.dev!==undefined&&expected.ino!==undefined&&info.dev===devOf(expected.dev)&&info.ino===expected.ino
    &&(expected.size===undefined||info.size===expected.size)&&(expected.mtimeMs===undefined||info.mtimeMs===expected.mtimeMs);
  const remove=async(name:string,ours:(info:Stats,path:string)=>Promise<boolean>)=>{
    if(!SINGLE_NAME.test(name)||name==='.'||name==='..'){kept.push(name);return;}
    const path=join(folderPath,name);let info:Stats;
    try{info=await io.lstat(path);}catch(error){if(codeOf(error)==='ENOENT')return;throw error;}
    if(info.isSymbolicLink()||!info.isFile()||!identifiable(info)||!await ours(info,path)){kept.push(name);return;}
    try{await io.unlink(path);}catch(error){if(codeOf(error)==='ENOENT')return;throw error;}
    removed.push(name);
  };
  const {part,final,reserved}=owned;
  // .part の名前は乱数なので dev・ino で見分ける（読み直した後に誰かが書き込んでも自分が作った実体）。大きさ・時刻は完成名で見分ける時だけ使う
  if(part)await remove(part.name,async info=>matches(info,{dev:part.dev,ino:part.ino}));
  if(!owned.reused&&!owned.connected&&owned.finalName&&(final||part||reserved)){
    await remove(owned.finalName,async(info,path)=>!!final&&matches(info,final)
      ||!!part&&part.size!==undefined&&part.mtimeMs!==undefined&&matches(info,part)
      ||!!reserved&&await holdsReservation(io,path,reserved,devOf,true));
  }
  return {removed,kept};
}
