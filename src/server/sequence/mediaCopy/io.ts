import {constants,type Stats} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,rename,stat,statfs,unlink,type FileHandle} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {fakeIoFromEnv} from './fakeIo';

/**
 * 遅い媒体の素材のコピーが触る外界の境界。
 * 製品は nodeCopyIo。試験は faultyIo（失敗・強制終了の注入）と fakeVolumesIo（一時フォルダーをボリュームに見立てる）で差し替える。
 */
export interface CopyFile {read(buffer:Buffer,position:number):Promise<number>;write(buffer:Buffer,position:number):Promise<number>;sync():Promise<void>;stat():Promise<Stats>;close():Promise<void>}
export type MountKind='boot-system'|'boot-data'|'external'|'other';
export interface MountedVolume {device:string;mountPoint:string;fsType:string;local:boolean;readOnly:boolean;kind:MountKind}
/** removable: 取り外し可能な媒体（diskutil の RemovableMedia。「Removable Media: Removable」の SD カードは true、外付け SSD・内蔵は「Fixed」で false）。 */
export interface VolumeDetails {uuid?:string;diskUuid?:string;container?:string;writable?:boolean;removable?:boolean}
export interface SpaceInfo {bavail:number;bsize:number;blocks:number}
export type IoPurpose='probe'|'copy'|'verify';
export interface CopyIo {
  open(path:string,flags:number,mode?:number):Promise<CopyFile>;
  lstat(path:string):Promise<Stats>;stat(path:string):Promise<Stats>;realpath(path:string):Promise<string>;
  /** 1段だけ作る（recursive にしない）。 */
  mkdir(path:string):Promise<void>;rename(from:string,to:string):Promise<void>;unlink(path:string):Promise<void>;readdir(path:string):Promise<string[]>;
  statfs(path:string):Promise<SpaceInfo>;mounts():Promise<MountedVolume[]>;volumeDetails(mountPoint:string):Promise<VolumeDetails>;
  /** 単調時計（ミリ秒）。速度と監視の間隔はこれで測る。 */
  now():number;wallNow():number;
  /** 読み書きのたびに呼ぶ。製品は何もしない。試験・監査は遅い媒体を再現する（仮想時計を進める、または待つ）。 */
  throttle(purpose:IoPurpose,path:string,bytes:number,signal?:AbortSignal):Promise<void>;
  /** pid が正の整数でなければ false。 */
  processAlive(pid:number):boolean;
  /** 開始時刻（エポックミリ秒、秒の精度）。プロセスが無い時だけ undefined。確かめられない時（ps の失敗など）は例外（呼び手は「終わっていない」扱いにする）。 */
  processStartedAt(pid:number):Promise<number|undefined>;
  readonly self:{pid:number;startedAt:number};home():string;
}
/** 読み取り専用・リンクをたどらない・待たない（差し替えられた FIFO を開いて書き手を待ち続けない。通常のファイルの読み書きには効かない）。 */
export const READ_ONLY=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
export const CREATE_EXCLUSIVE=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW;
/** 書き込みを含む開き方の旗のどれか（元のファイルを開いた flags にこれが無いことを試験で確かめる）。 */
export const WRITE_FLAGS=constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND;

/** `/Volumes/<名前>` だけを外付けとする。`/System/Volumes/Data`（/Users のある内蔵のデータボリューム）は `/` と同じ入れ物なので内蔵（boot-data）。 */
export function mountKind(mountPoint:string):MountKind{
  if(mountPoint==='/')return 'boot-system';if(mountPoint==='/System/Volumes/Data')return 'boot-data';
  return /^\/Volumes\/[^/]+$/.test(mountPoint)?'external':'other';
}
/** `mount` の1行（`/dev/disk4s1 on /Volumes/SD 1 (exfat, local, nodev, nosuid, noowners)`）。 */
export function parseMountLine(line:string):MountedVolume|undefined{
  const match=/^(.+?) on (\/.*) \(([^,()]+)((?:, [^,()]+)*)\)$/.exec(line.trim());if(!match)return undefined;
  const flags=match[4]!.split(',').map(flag=>flag.trim()).filter(Boolean),mountPoint=match[2]!;
  return {device:match[1]!,mountPoint,fsType:match[3]!.trim(),local:flags.includes('local'),readOnly:flags.includes('read-only')||flags.includes('rdonly'),kind:mountKind(mountPoint)};
}
/** `ps -o lstart=` の値（`Sat Oct  4 10:12:13 2026`）。ps は TZ=UTC で動かすので UTC として読む（ローカル時刻だと夏時間の切り替えでずれる）。 */
export function parsePsStart(value:string):number|undefined{
  const match=/^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value.trim());if(!match)return undefined;
  const month='JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(match[1]!)/3;if(!Number.isInteger(month)||month<0)return undefined;
  return Date.UTC(Number(match[6]),month,Number(match[2]),Number(match[3]),Number(match[4]),Number(match[5]));
}
export interface CommandResult {code:number|null;stdout:string;stderr:string}
/** `ps -o lstart= -p <pid>` の結果。終了コード 1 で出力が何も無い時だけ「プロセスが無い」（undefined）。それ以外に読めない時は例外。 */
export function readPsStart(result:CommandResult):number|undefined{
  if(result.code===1&&!result.stdout.trim()&&!result.stderr.trim())return undefined;
  if(result.code!==0)throw new Error(`ps が失敗しました（${result.code}）: ${result.stderr.trim()}`);
  const started=parsePsStart(result.stdout);if(started===undefined)throw new Error(`ps の開始時刻を読めませんでした: ${result.stdout.trim()}`);return started;
}
/**
 * 読み取りだけの外部コマンドを実行する（LC_ALL=C・TZ=UTC）。入力が無い時は stdin を閉じたまま渡す（先に終わったコマンドへ書いて EPIPE にならないように）。
 * 時間切れは SIGTERM で止め、killAfterMs の猶予の後も残っていれば SIGKILL に上げて、終わった時点で例外にする。
 * 本体が終わっていて孫のプロセスが出力を握っている時は、時間切れの時点で例外にする。時間切れで返す時は出力の読み口を閉じる。
 */
export function runCommand(command:string,args:string[],options:{input?:string;timeoutMs?:number;killAfterMs?:number}={}):Promise<CommandResult>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env:{...process.env,LC_ALL:'C',TZ:'UTC'},stdio:[options.input===undefined?'ignore':'pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false,exited=false,settled=false;
    let kill:ReturnType<typeof setTimeout>|undefined;
    const settle=(action:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(kill);action();};
    const late=()=>settle(()=>{child.stdout!.destroy();child.stderr!.destroy();reject(new Error(`${command} が時間内に終わりませんでした`));});
    const timer=setTimeout(()=>{timedOut=true;if(exited){late();return;}child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),options.killAfterMs??1000);},options.timeoutMs??10_000);
    child.stdout!.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});child.stderr!.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
    child.once('error',error=>settle(()=>reject(error)));
    // 時間切れの時は出力の終わり（孫のプロセスが握っていることがある）を待たず、本体が終わった時点で返す。
    child.once('exit',()=>{exited=true;if(timedOut)late();});
    child.once('close',code=>settle(()=>timedOut?reject(new Error(`${command} が時間内に終わりませんでした`)):resolve({code,stdout,stderr})));
    if(child.stdin){child.stdin.on('error',()=>undefined);child.stdin.end(options.input);}
  });
}
async function run(command:string,args:string[],input?:string):Promise<string>{
  const result=await runCommand(command,args,input===undefined?{}:{input});
  if(result.code!==0)throw new Error(`${command} が失敗しました（${result.code}）: ${result.stderr.trim()}`);return result.stdout;
}
const text=(value:unknown)=>typeof value==='string'&&value?value:undefined;
/** `diskutil info -plist` を JSON にしたものから、型の合う項目だけを読む。 */
export function volumeDetailsFromJson(parsed:unknown):VolumeDetails{
  if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))throw new Error('diskutil の結果を読めませんでした');
  const json=parsed as Record<string,unknown>,uuid=text(json.VolumeUUID),diskUuid=text(json.DiskUUID),container=text(json.APFSContainerReference);
  return {...(uuid?{uuid}:{}),...(diskUuid?{diskUuid}:{}),...(container?{container}:{}),...(typeof json.WritableVolume==='boolean'?{writable:json.WritableVolume}:{}),
    ...(typeof json.RemovableMedia==='boolean'?{removable:json.RemovableMedia}:{})};
}
const validPid=(pid:number)=>Number.isSafeInteger(pid)&&pid>0;
const wrap=(handle:FileHandle):CopyFile=>({read:async(buffer,position)=>(await handle.read(buffer,0,buffer.length,position)).bytesRead,
  write:async(buffer,position)=>(await handle.write(buffer,0,buffer.length,position)).bytesWritten,sync:()=>handle.sync(),stat:()=>handle.stat(),close:()=>handle.close()});
export const nodeCopyIo:CopyIo={
  open:async(path,flags,mode)=>wrap(await open(path,flags,mode)),lstat:path=>lstat(path),stat:path=>stat(path),realpath:path=>realpath(path),
  mkdir:async path=>{await mkdir(path);},rename:(from,to)=>rename(from,to),unlink:path=>unlink(path),readdir:path=>readdir(path),
  statfs:async path=>{const info=await statfs(path);return {bavail:Number(info.bavail),bsize:Number(info.bsize),blocks:Number(info.blocks)};},
  mounts:async()=>(await run('/sbin/mount',[])).split('\n').map(parseMountLine).filter((mount):mount is MountedVolume=>!!mount),
  volumeDetails:async mountPoint=>{
    const plist=await run('/usr/sbin/diskutil',['info','-plist',mountPoint]);
    try{return volumeDetailsFromJson(JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-','-'],plist)));}catch(error){throw new Error(`diskutil の結果を読めませんでした: ${mountPoint}`,{cause:error});}
  },
  now:()=>performance.now(),wallNow:()=>Date.now(),throttle:async()=>undefined,
  // 0・負の数は kill(2) ではプロセスグループ・全プロセスへの合図になるので、正の整数だけを調べる。
  // EPERM は「他の利用者のプロセスが生きている」。ESRCH だけを「終わっている」とする（references.ts の deadOwner と同じ）。
  processAlive:pid=>{if(!validPid(pid))return false;try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}},
  processStartedAt:async pid=>{if(!validPid(pid))throw new Error(`pid が正しくありません: ${pid}`);return readPsStart(await runCommand('/bin/ps',['-o','lstart=','-p',String(pid)]));},
  self:{pid:process.pid,startedAt:Date.now()-process.uptime()*1000},home:()=>homedir(),
};
let override:CopyIo|undefined,fromEnv:CopyIo|null|undefined;
/** vitest の実行中か（aiToolBin.ts の isVitest と同じく明示比較。`VITEST=0` で開かない）。 */
const testRun=()=>process.env.VITEST==='1'||process.env.VITEST==='true';
/**
 * 実ブラウザ監査の偽装（HARNESS_TEST_MEDIA_COPY_FAKE。fakeIo.ts の fakeIoFromEnv が設定の場所・持ち主・権限を確かめる）を最初の1回だけ読み、有効になった時は1度だけ警告する。
 * 設定が不正なら覚えずに毎回投げる（偽装の指定を黙って捨てて本物の外界へ書かない）。
 */
function envFake():CopyIo|null{
  if(fromEnv!==undefined)return fromEnv;
  const fake=process.env.HARNESS_TEST_MEDIA_COPY_FAKE?fakeIoFromEnv(nodeCopyIo)??null:null;
  if(fake)console.warn('[sme] 試験用の偽装（HARNESS_TEST_MEDIA_COPY_FAKE）が有効です: ボリューム・空き・読み書きの速さは偽物です。製品では設定しないでください');
  return fromEnv=fake;
}
/** 製品は nodeCopyIo。試験は copyIoTesting.use、実ブラウザ監査は HARNESS_TEST_MEDIA_COPY_FAKE（fakeIo.ts の fakeIoFromEnv）で差し替える。 */
export function copyIo():CopyIo{return override??envFake()??nodeCopyIo;}
/** 確かめ終えた監査の偽装が有効か（設定が無い・不正なら false。sharedDigest.ts の試験用の遅延はこの時だけ効かせる）。 */
export function mediaCopyFakeActive():boolean{
  if(!process.env.HARNESS_TEST_MEDIA_COPY_FAKE)return false;
  try{return envFake()!==null;}catch{return false;}
}
/** 試験専用（製品の経路からは呼ばない）。vitest の外では差し替えを断る（戻す `use(undefined)` はいつでも可）。 */
export const copyIoTesting={use(io?:CopyIo){if(io&&!testRun())throw new Error('copyIoTesting は試験の実行中だけ使えます');override=io;}};

/** 試験専用: 強制終了（プロセスが落ちた）の再現。これを受けたコピーの作業は片付けも記録もせずに止まる。 */
export class SimulatedCrash extends Error{constructor(at:string){super(`試験: ${at} で強制終了しました`);this.name='SimulatedCrash';}}
export const isSimulatedCrash=(error:unknown):boolean=>error instanceof SimulatedCrash;
export type IoOp='open'|'read'|'write'|'sync'|'close'|'rename'|'unlink'|'mkdir'|'statfs'|'lstat'|'stat'|'mounts'|'volumeDetails';
/** nth 回目（1始まり。省略は毎回）に op・path・match が合う呼び出しの直前で before を呼び、error（errno）か crash を起こす。 */
export interface IoFault {op:IoOp;path?:RegExp;nth?:number;match?:(call:IoCall)=>boolean;error?:string;crash?:boolean;before?:(call:IoCall)=>unknown}
export interface IoCall {op:IoOp;path:string;from?:string;flags?:number;bytes?:number}
export type FaultyIo=CopyIo&{calls:IoCall[]};
/**
 * 試験専用: base への呼び出しを calls に記録し、faults（後から push してよい）に合う呼び出しで失敗・強制終了を起こす。base の型（fakeVolumesIo の volumes など）はそのまま残る。
 * 偽ボリュームと重ねる時は必ずこれを一番外側に置く（fakeVolumesIo の mounts・statfs・volumeDetails は下の層を呼ばないので、内側に置くと注入も記録も届かない）。
 */
export function faultyIo<T extends CopyIo>(base:T,faults:IoFault[]=[]):T&{calls:IoCall[]}{
  const calls:IoCall[]=[],counts=new Map<IoFault,number>();
  const hit=async(call:IoCall)=>{
    calls.push(call);
    for(const fault of faults){
      if(fault.op!==call.op||(fault.path&&!fault.path.test(call.path))||(fault.match&&!fault.match(call)))continue;
      const n=(counts.get(fault)??0)+1;counts.set(fault,n);if(fault.nth!==undefined&&fault.nth!==n)continue;
      await fault.before?.(call);
      if(fault.crash)throw new SimulatedCrash(`${call.op} ${call.path}`);
      if(fault.error)throw Object.assign(new Error(`${fault.error}（試験）: ${call.op} ${call.path}`),{code:fault.error});
    }
  };
  const wrapFile=(path:string,file:CopyFile):CopyFile=>{
    let closed=false;const shut=async()=>{if(closed)return;closed=true;await file.close();};
    // close の失敗と、読み書き・同期の途中の強制終了では、下のファイルを閉じてから投げる（試験の中で開いたままの fd を残さない。close は失敗しても fd を手放す）。
    const guard=async(call:IoCall)=>{try{await hit(call);}catch(error){if(call.op==='close'||isSimulatedCrash(error))await shut().catch(()=>undefined);throw error;}};
    return {read:async(buffer,position)=>{const call:IoCall={op:'read',path};await guard(call);const n=await file.read(buffer,position);call.bytes=n;return n;},
      write:async(buffer,position)=>{const call:IoCall={op:'write',path,bytes:buffer.length};await guard(call);return file.write(buffer,position);},
      sync:async()=>{await guard({op:'sync',path});await file.sync();},stat:()=>file.stat(),close:async()=>{await guard({op:'close',path});await shut();}};
  };
  return {...base,calls,
    open:async(path:string,flags:number,mode?:number)=>{await hit({op:'open',path,flags});return wrapFile(path,await base.open(path,flags,mode));},
    lstat:async(path:string)=>{await hit({op:'lstat',path});return base.lstat(path);},stat:async(path:string)=>{await hit({op:'stat',path});return base.stat(path);},
    mkdir:async(path:string)=>{await hit({op:'mkdir',path});await base.mkdir(path);},rename:async(from:string,to:string)=>{await hit({op:'rename',path:to,from});await base.rename(from,to);},
    unlink:async(path:string)=>{await hit({op:'unlink',path});await base.unlink(path);},statfs:async(path:string)=>{await hit({op:'statfs',path});return base.statfs(path);},
    mounts:async()=>{await hit({op:'mounts',path:''});return base.mounts();},
    volumeDetails:async(mountPoint:string)=>{await hit({op:'volumeDetails',path:mountPoint});return base.volumeDetails(mountPoint);},
  };
}
