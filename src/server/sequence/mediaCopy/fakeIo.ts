import {constants,readFileSync,realpathSync,statSync,type Stats} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {z} from 'zod';
// io.ts からは型だけを読む（Task 17 で io.ts がこのファイルを読むため、値を読むと循環する）。
import type {CopyIo,IoPurpose,MountKind} from './io';

/**
 * 試験・監査専用: 一時フォルダーを「ボリューム」に見立てる。mount・diskutil・statfs・ホーム・時計・読み書きの速さだけを差し替え、ファイルの実体と dev・ino は本物のまま。
 * 本物に合わせる: 別の偽ボリュームへの rename は EXDEV、読み取り専用（readOnly か writable:false）の偽ボリュームへの書き込み・作成・削除は EROFS（既にある名前への排他の作成は EEXIST、無いものの削除・移動は ENOENT を先に返す）、statfs は先に下の層を呼ぶ（無いパスは ENOENT）。
 * 偽ボリュームはどれも同じ一時フォルダーの上にあるので dev は共通。ドライブの入れ替わり（dev の違い）はここでは再現できず、exFAT イメージの任意試験でしか確かめられない。
 * 失敗の注入（faultyIo）と重ねる時は faultyIo を外側に置く（mounts・statfs・volumeDetails は下の層を呼ばない）。
 */
/** removable: 取り外し可能な媒体（diskutil の RemovableMedia。SD カードは true）。省略すると diskutil が答えない時と同じ（取り外し可能とみなさない）。 */
export interface FakeVolume {mountPoint:string;uuid:string;kind:MountKind;fsType?:string;local?:boolean;readOnly?:boolean;writable?:boolean;removable?:boolean;container?:string;capacity:number;free:number}
/** virtual: 時計を進めるだけ（待たない。時計が要る）。それ以外は実際に待つ（監査で進み具合を見るため。止まった偽の時計とは組み合わせられない）。 */
export interface FakeSpeed {prefix:string;purpose:IoPurpose;bytesPerSecond:number;virtual?:boolean}
/** realTime: 実時間に沿って進む時計（realTimeClock）。無ければ advance だけで進む止まった時計。 */
export interface FakeClock {now():number;advance(ms:number):void;readonly realTime?:boolean}
export function fakeClock(start=1000):FakeClock{let at=start;return {now:()=>at,advance:ms=>{at+=ms;}};}
/** 単調時計に沿って進み、advance で先へずらせる時計（監査で、実際に待つ速さと仮想の速さを混ぜる時）。 */
export function realTimeClock():FakeClock{let offset=0;return {realTime:true,now:()=>performance.now()+offset,advance:ms=>{offset+=ms;}};}
export type FakeVolumesIo=CopyIo&{volumes:FakeVolume[]};
/** io.ts の WRITE_FLAGS と同じ（型だけを読むため写す）。 */
const WRITES=constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND;
/** フォルダーの境界で比べる（`…/sd` は `…/sd2/a.mp4` を含まない）。 */
const inside=(path:string,folder:string)=>path===folder||path.startsWith(folder.endsWith('/')?folder:`${folder}/`);
const errno=(code:string,op:string,path:string)=>Object.assign(new Error(`${code}（偽のボリューム）: ${op} '${path}'`),{code});
export function fakeVolumesIo(base:CopyIo,options:{volumes:FakeVolume[];home:string;clock?:FakeClock;speeds?:FakeSpeed[]}):FakeVolumesIo{
  const {clock}=options,speeds=options.speeds??[];
  if(speeds.some(rule=>rule.virtual)&&!clock)throw new Error('virtual の速さには時計（clock）が要ります');
  if(clock&&!clock.realTime&&speeds.some(rule=>!rule.virtual))throw new Error('実際に待つ速さは止まった偽の時計と組み合わせられません（realTimeClock を使う）');
  const within=(path:string)=>options.volumes.filter(volume=>inside(path,volume.mountPoint)).sort((a,b)=>b.mountPoint.length-a.mountPoint.length)[0];
  const readOnly=(path:string)=>{const volume=within(path);return !!volume&&(volume.readOnly===true||volume.writable===false);};
  const exists=(path:string)=>base.lstat(path).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;});
  /** 読み取り専用なら本物と同じ順で断る: 排他で作る名前が既にあれば EEXIST、作らずに開く・消す・移すものが無ければ ENOENT、それ以外は EROFS。 */
  const writable=async(op:string,path:string,expect:'absent'|'present'|'any')=>{
    if(!readOnly(path))return;const found=expect==='any'?undefined:await exists(path);
    if(expect==='absent'&&found)throw errno('EEXIST',op,path);if(expect==='present'&&!found)throw errno('ENOENT',op,path);throw errno('EROFS',op,path);
  };
  return {...base,volumes:options.volumes,
    open:async(path,flags,mode)=>{
      if(flags&WRITES){const create=(flags&constants.O_CREAT)!==0;await writable('open',path,create&&(flags&constants.O_EXCL)!==0?'absent':create?'any':'present');}
      return base.open(path,flags,mode);
    },
    mkdir:async path=>{await writable('mkdir',path,'absent');await base.mkdir(path);},unlink:async path=>{await writable('unlink',path,'present');await base.unlink(path);},
    rename:async(from,to)=>{if(within(from)!==within(to))throw errno('EXDEV','rename',`${from}' -> '${to}`);await writable('rename',from,'present');await base.rename(from,to);},
    mounts:async()=>options.volumes.map(volume=>({device:`/dev/fake-${volume.uuid}`,mountPoint:volume.mountPoint,fsType:volume.fsType??'apfs',local:volume.local??true,readOnly:volume.readOnly??false,kind:volume.kind})),
    volumeDetails:async mountPoint=>{const volume=options.volumes.find(item=>item.mountPoint===mountPoint);if(!volume)throw new Error(`未接続です: ${mountPoint}`);
      return {uuid:volume.uuid,...(volume.container?{container:volume.container}:{}),writable:volume.writable??true,...(volume.removable!==undefined?{removable:volume.removable}:{})};},
    statfs:async path=>{const real=await base.statfs(path),volume=within(path);if(!volume)return real;const bsize=4096;return {bsize,bavail:Math.floor(volume.free/bsize),blocks:Math.floor(volume.capacity/bsize)};},
    home:()=>options.home,...(clock?{now:()=>clock.now()}:{}),
    throttle:async(purpose,path,bytes,signal)=>{
      const rule=speeds.find(speed=>speed.purpose===purpose&&inside(path,speed.prefix));if(!rule)return;const ms=bytes*1000/rule.bytesPerSecond;
      if(rule.virtual)clock!.advance(ms);else await sleep(ms,undefined,{signal});
    },
  };
}
/** exFAT（macOS 26 の FSKit で実測）の空のファイルの ino。Number の stat では全部この値（2^64 に丸まった値。bigint では付け直すたびに変わる負の仮番号）。 */
export const EXFAT_EMPTY_INO=18446744073709552000;
/**
 * 試験専用: exFAT の ino の振る舞いを再現する。空の通常のファイルは ino が共通の仮の値（EXFAT_EMPTY_INO）になり、初めて書いた時に本当の値（本物の exFAT では先頭クラスタ番号）に変わる。
 * rename では変わらない（.part の ino のまま）。lstat・stat・開いたファイルの stat に効く。faultyIo と重ねる時はこれを内側に置く。
 */
export function exfatEmptyInodes<T extends CopyIo>(base:T):T{
  const mask=(info:Stats):Stats=>info.isFile()&&info.size===0?Object.assign(Object.create(Object.getPrototypeOf(info) as object) as Stats,info,{ino:EXFAT_EMPTY_INO}):info;
  return {...base,lstat:async(path:string)=>mask(await base.lstat(path)),stat:async(path:string)=>mask(await base.stat(path)),
    open:async(path:string,flags:number,mode?:number)=>{const file=await base.open(path,flags,mode);return {...file,stat:async()=>mask(await file.stat())};}};
}

const fakeSchema=z.object({home:z.string().min(1),volumes:z.array(z.object({mountPoint:z.string().min(1),uuid:z.string().min(1),kind:z.enum(['boot-system','boot-data','external','other']),
  fsType:z.string().optional(),local:z.boolean().optional(),readOnly:z.boolean().optional(),writable:z.boolean().optional(),removable:z.boolean().optional(),container:z.string().optional(),capacity:z.number().positive(),free:z.number().nonnegative()}).strict()),
  speeds:z.array(z.object({prefix:z.string().min(1),purpose:z.enum(['probe','copy','verify']),bytesPerSecond:z.number().positive(),virtual:z.boolean().optional()}).strict()).optional()}).strict();
const OUTSIDE='HARNESS_TEST_MEDIA_COPY_FAKE は一時フォルダーの中の設定・ボリュームだけを受け付けます';
/** 実パスが一時フォルダーの中か。まだ無いパスは、在る一番近い親の実パスに残りを足して比べる（中から外へのリンクも外とみなす）。 */
function insideTemporary(path:string,temporary:string):boolean{
  let current=resolve(path),rest='';
  for(;;){
    try{return `${realpathSync(current)}${rest}`.startsWith(`${temporary}/`);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(current);if(parent===current)return false;rest=`/${basename(current)}${rest}`;current=parent;}
  }
}
/**
 * 実ブラウザ監査専用: HARNESS_TEST_MEDIA_COPY_FAKE に一時フォルダーの中の設定 JSON があれば、一時フォルダーをボリュームに見立てた外界を返す（監査はサーバを別のモジュールとして読み込むため、
 * 試験の差し替え口が届かない）。製品で働かないように閉じる: 設定は一時フォルダーの中の通常のファイルで、持ち主が自分・ほかの利用者が書き換えられないものだけ。
 * 偽のボリューム・ホームも一時フォルダーの中だけ（コピーが実際のドライブ・ホームに書かない）。デスクトップ版のサーバ（HARNESS_DESKTOP_CACHE）では使わない。
 * 実際に待つ速さ（copy・verify）と仮想の速さ（probe）を混ぜるので、時計は単調時計に沿って進む realTimeClock（止まった fakeClock とは組み合わせられない）。
 */
export function fakeIoFromEnv(base:CopyIo,env:NodeJS.ProcessEnv=process.env):CopyIo|undefined{
  const file=env.HARNESS_TEST_MEDIA_COPY_FAKE;if(!file)return undefined;
  if(env.HARNESS_DESKTOP_CACHE)throw new Error('HARNESS_TEST_MEDIA_COPY_FAKE はデスクトップ版のサーバでは使えません');
  const temporary=realpathSync(tmpdir()),real=realpathSync(file);if(!real.startsWith(`${temporary}/`))throw new Error(OUTSIDE);
  const info=statSync(real);
  if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o022)!==0)throw new Error('HARNESS_TEST_MEDIA_COPY_FAKE は、自分が持ち主でほかの利用者が書き換えられない設定ファイルだけを受け付けます');
  const config=fakeSchema.parse(JSON.parse(readFileSync(real,'utf8')));
  if(![config.home,...config.volumes.map(volume=>volume.mountPoint)].every(path=>insideTemporary(join(path),temporary)))throw new Error(OUTSIDE);
  return fakeVolumesIo(base,{volumes:config.volumes,home:config.home,clock:realTimeClock(),...(config.speeds?{speeds:config.speeds}:{})});
}
