import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,readSync,readdirSync,renameSync,rmSync,unlinkSync,writeSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {z} from 'zod';
import type {SequenceAsset} from '../../../core/sequence/model';
import type {SlowMediaAdvice} from '../../../shared/mediaCopy';
import {isSequenceReferenceFile,referenceReadState,type ReferenceReadState} from '../references';
import type {CopyIo,MountedVolume} from './io';
import {SLOW_SECONDS} from './estimate';
import {networkVolumeUuid,volumeOfPath} from './volumes';

/**
 * 「この接続先では今後出さない」（設計 §2）: `.harness/slow-media.json` に素材 ID と接続先の識別情報（実パスとボリュームの UUID）で残す。
 * 接続先が変われば（別のファイルへつなぎ直した・同じ名前の別のカード＝UUID が違う）再び判定する。同じカードの挿し直し（パスも UUID も同じ）では出さないまま。
 */
export interface SlowMediaConnection {target:string;volume:string}
const FILE='slow-media.json';
/** 記録の大きさの上限。超えた記録は読まない（無いものとする）。書く時は古い項目から落として収める。 */
export const SLOW_MEDIA_MAX_BYTES=256*1024;
const ASSET_ID=/^(media|image)-[a-f0-9]{24}$/;
const connectionSchema=z.object({target:z.string().min(1).max(4096).refine(isAbsolute),volume:z.string().min(1).max(200)}).strict();
const schema=z.object({format:z.literal('harness-slow-media'),version:z.literal(1),entries:z.record(z.string().regex(ASSET_ID),connectionSchema)}).strict();
type Prefs=Record<string,SlowMediaConnection>;
/** ネットワークのボリュームの識別（network:<mount の装置名>）には利用者名が入りうるので、案件に書く時と比べる時は SHA-256 の形にする。 */
const storedVolume=(volume:string)=>volume.startsWith('network:')?`network-sha256:${createHash('sha256').update(volume).digest('hex')}`:volume;

/** .harness（リンクでない本物のフォルダー）。作らない（削除された案件のフォルダーを復活させない。importBatches と同じ）。 */
function harnessFolder(root:string):string{
  const path=join(root,'.harness'),info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('案件の記録先が不正です');return path;
}
/** 記録を読む（リンクをたどらない・FIFO で待たない・上限を超えて読まない）。無ければ {}。形が違う・大きすぎる記録は undefined。 */
function readPrefs(folder:string):Prefs|undefined{
  let fd:number;
  try{fd=openSync(join(folder,FILE),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
  try{
    const info=fstatSync(fd);if(!info.isFile()||info.size>SLOW_MEDIA_MAX_BYTES)return undefined;
    const buffer=Buffer.alloc(SLOW_MEDIA_MAX_BYTES+1);let length=0;
    while(length<buffer.length){const n=readSync(fd,buffer,length,buffer.length-length,length);if(!n)break;length+=n;}
    if(length>SLOW_MEDIA_MAX_BYTES)return undefined;
    let json:unknown;try{json=JSON.parse(buffer.subarray(0,length).toString('utf8'));}catch{return undefined;}
    const parsed=schema.safeParse(json);return parsed.success?parsed.data.entries:undefined;
  }finally{closeSync(fd);}
}
/** 案内は数秒ごとに取り直されるので、同じ警告は案件ごとに1回。 */
const warned=new Set<string>();
function warnOnce(root:string,message:string){
  const key=`${root}\0${message}`;if(warned.has(key))return;warned.add(key);while(warned.size>64)warned.delete(warned.values().next().value!);
  console.warn(`[sme] 案内の記録（.harness/${FILE}）を読めません（記録なしとして扱い、案内は出します）:`,message);
}
/** 読めない・形が違う・大きすぎる記録は無いものとする（案内を出す側に倒す）。 */
export async function readSlowMediaPrefs(root:string):Promise<Prefs>{
  try{const prefs=readPrefs(harnessFolder(root));if(!prefs)warnOnce(root,'内容が不正です');return prefs??{};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')warnOnce(root,error instanceof Error?error.message:String(error));return {};}
}
const serialize=(entries:Prefs)=>JSON.stringify({format:'harness-slow-media',version:1,entries})+'\n';
/** この時間より古い自分の一時ファイル（rename の前に止まった書き込みの残り）は、書く時に片付ける（importBatches と同じ）。 */
const STALE_TEMPORARY_MS=60*60*1000,TEMPORARY=/^slow-media\.json\.[0-9a-f-]{36}\.tmp$/;
function sweepTemporaries(folder:string){
  for(const name of readdirSync(folder).filter(entry=>TEMPORARY.test(entry))){
    try{const info=lstatSync(join(folder,name),{throwIfNoEntry:false});if(info&&!info.isDirectory()&&Date.now()-info.mtimeMs>STALE_TEMPORARY_MS)rmSync(join(folder,name),{force:true});}
    catch(error){console.warn('[sme] 案内の記録の一時ファイルを片付けられません:',name,error instanceof Error?error.message:error);}
  }
}
/** 一時ファイルは推測できない名前で新しく作り（wx＝置いてあるリンクをたどらない）、同期してから rename で置き換える（リンクの記録はリンクごと置き換わる）。失敗したら自分の一時ファイルを消す。 */
function writePrefs(folder:string,body:string){
  const temporary=join(folder,`${FILE}.${randomUUID()}.tmp`),fd=openSync(temporary,'wx',0o600);
  try{
    try{const buffer=Buffer.from(body);for(let at=0;at<buffer.length;){const n=writeSync(fd,buffer,at,buffer.length-at,at);if(n<=0)throw new Error('案内の記録を書き込めません');at+=n;}fsyncSync(fd);}
    finally{closeSync(fd);}
    renameSync(temporary,join(folder,FILE));
  }catch(error){try{unlinkSync(temporary);}catch{/* 元のエラーを返す */}throw error;}
}
/**
 * 「この接続先では今後出さない」を記録する。読み直し・足す・置き換えるまでを同期で行う（同じプロセスで同時に書かれても、間に割り込まれて記録を失わない。importBatches と同じ書き方）。
 * 壊れた記録・リンクの記録は読まずに新しく書き直す（リンクの先には書かない）。上限を超える時は古い項目から落とす（落ちた素材は案内がまた出るだけ）。
 */
export async function suppressSlowMediaAdvice(root:string,assetId:string,connection:SlowMediaConnection):Promise<void>{
  const entry=connectionSchema.safeParse({target:connection.target,volume:storedVolume(connection.volume)});
  if(!ASSET_ID.test(assetId)||!entry.success)throw new Error('案内の記録の内容が不正です');
  const folder=harnessFolder(root);sweepTemporaries(folder);let current:Prefs|undefined;
  try{current=readPrefs(folder);}catch(error){if((error as NodeJS.ErrnoException).code!=='ELOOP')throw error;}
  const entries:Prefs={...current};delete entries[assetId];entries[assetId]=entry.data;   // 最後に足したものを新しい側に置く
  let body=serialize(entries);
  for(const oldest of Object.keys(entries)){if(Buffer.byteLength(body)<=SLOW_MEDIA_MAX_BYTES||oldest===assetId)break;delete entries[oldest];body=serialize(entries);}
  if(Buffer.byteLength(body)>SLOW_MEDIA_MAX_BYTES)throw new Error('案内の記録が大きすぎます');
  writePrefs(folder,body);
}
export function isSlowAdviceSuppressed(prefs:Prefs,assetId:string,connection:SlowMediaConnection):boolean{
  const entry=Object.hasOwn(prefs,assetId)?prefs[assetId]:undefined;
  return !!entry&&entry.target===connection.target&&entry.volume===storedVolume(connection.volume);
}
/** 今の接続先（実パスとボリュームの UUID）。見つからない・ボリュームを識別できない（一覧の外・取り外し後に残ったフォルダー）時は undefined。 */
export async function connectionOf(io:CopyIo,path:string):Promise<SlowMediaConnection|undefined>{
  try{const target=await io.realpath(path),volume=await volumeOfPath(io,target);return volume?{target,volume:volume.uuid}:undefined;}catch{return undefined;}
}
export interface AdvicePorts {readState(root:string,asset:SequenceAsset):Promise<ReferenceReadState|undefined>}
const noAdvice=():SlowMediaAdvice=>({targets:[],totalBytes:0,totalSeconds:0,unmeasured:0});
const under=(path:string,mountPoint:string)=>path===mountPoint||path.startsWith(`${mountPoint}/`);
/**
 * 案内の判定だけが使うドライブの識別（UUID）の記憶: 取り付け先と dev の組ごとに 30 秒（案内は照合が続く間、数秒ごと・窓ごとに取り直されるので diskutil を繰り返さない）。
 * 読めなかったことも覚える。同じ名前の別のカードは取り付け先・dev を引き継ぐので、替えてから 30 秒は前の識別で判定しうる（案内だけ。記録する接続先は connectionOf が読み直す）。
 * コピーの開始時の照合など安全確認は listVolumes・ensureCopyFolder・assertCopyFolder で毎回読み直す（これを使わない）。
 */
export const ADVICE_VOLUME_TTL_MS=30_000;
const adviceVolumes=new Map<string,{uuid:string|undefined;at:number}>();
async function adviceVolumeUuid(io:CopyIo,mount:MountedVolume,dev:number):Promise<string|undefined>{
  const key=JSON.stringify([mount.mountPoint,dev]),known=adviceVolumes.get(key),now=io.now();
  if(known&&now-known.at<ADVICE_VOLUME_TTL_MS)return known.uuid;
  const details=await io.volumeDetails(mount.mountPoint).catch(()=>undefined),uuid=details?.uuid||details?.diskUuid||undefined;
  adviceVolumes.delete(key);adviceVolumes.set(key,{uuid,at:now});while(adviceVolumes.size>32)adviceVolumes.delete(adviceVolumes.keys().next().value!);
  return uuid;
}
/**
 * 開いた時の案内（設計 §1・§2）: 外付けのボリューム上の、まだ照合していないリンク素材だけ。速さは裏の照合が読み進めた量と時間から（追加の読み取りなし）。
 * 照合済み（保存した照合記録で読み直さないものを含む）の素材は測らず、自動の案内に出さない（手でコピーする入口は素材行に常にある）。
 * 照合の失敗を覚えている素材はエラーのバナーが扱うので、案内にも未測定にも数えない。「この接続先では今後出さない」とした素材は、未測定でも数えない。
 * このプロセスのコピーの作業が予約している素材（copying）も、案内にも未測定にも数えない（画面は別のエディターの作業も含めず、activeAssetIds と同じ範囲）。
 * 外付けかどうかは mount の一覧（1回だけ読む）で、パスを含む最も長い /Volumes の取り付け先の dev がファイルと同じこと（取り外し後に残ったフォルダーを取り違えない。volumeOfPath と同じ）。
 * ドライブの識別は候補のあるドライブだけ読む（照合が済めば mount も呼ばない）。識別を読めない外付けの素材も案内に残し（追加時の判定と同じ。§1 の条件に識別は無い）、
 * 「今後出さない」を記録できないので canRemember:false を付ける。ネットワークの識別は mount の行から（diskutil を呼ばない）。
 * ports.readState の path は実パス（referenceReadState の接続先）とする。
 */
export async function slowMediaAdvice(io:CopyIo,root:string,assets:readonly SequenceAsset[],ports:AdvicePorts={readState:referenceReadState}):Promise<SlowMediaAdvice>{
  const pending:{asset:SequenceAsset;state:ReferenceReadState}[]=[];
  for(const asset of assets){
    if(!isSequenceReferenceFile(asset.file))continue;
    const state=await ports.readState(root,asset);if(state&&!state.verified&&!state.failed&&!state.copying)pending.push({asset,state});
  }
  if(!pending.length)return noAdvice();
  const mounts=(await io.mounts()).filter(mount=>mount.kind==='external').sort((a,b)=>b.mountPoint.length-a.mountPoint.length);
  const outside=pending.flatMap(item=>{const mount=mounts.find(candidate=>under(item.state.path,candidate.mountPoint));return mount?[{...item,mount}]:[];});
  if(!outside.length)return noAdvice();
  const prefs=await readSlowMediaPrefs(root),targets:SlowMediaAdvice['targets']=[];let unmeasured=0;
  for(const {asset,state,mount} of outside){
    let uuid=networkVolumeUuid(mount);
    if(uuid===undefined){
      let dev:number;try{dev=(await io.stat(mount.mountPoint)).dev;if((await io.stat(state.path)).dev!==dev)continue;}catch{continue;}
      uuid=await adviceVolumeUuid(io,mount,dev);
    }
    if(uuid!==undefined&&isSlowAdviceSuppressed(prefs,asset.id,{target:state.path,volume:uuid}))continue;
    const rate=state.bytesPerSecond;if(rate===undefined||!(rate>0)){unmeasured++;continue;}
    const seconds=state.sizeBytes/rate;
    if(seconds>=SLOW_SECONDS)targets.push({assetId:asset.id,name:asset.name,sizeBytes:state.sizeBytes,seconds:Math.ceil(seconds),...(uuid===undefined?{canRemember:false as const}:{})});
  }
  return {targets,totalBytes:targets.reduce((sum,target)=>sum+target.sizeBytes,0),totalSeconds:targets.reduce((sum,target)=>sum+target.seconds,0),unmeasured};
}
