import {basename,join} from 'node:path';
import {HttpError} from '../../http';
import {COPY_REMOVABLE_NOTE,type CopyDestinationKind,type CopyDestinationRequest,type CopyDestinationView} from '../../../shared/mediaCopy';
import {isSimulatedCrash,type CopyIo} from './io';
import {COPY_ROOT_NAME,NETWORK_DEV,UNKNOWN_DRIVE_REASON,copyFolderName,copyFolderRefusal,listVolumes,volumeOfPath,type VolumeIdentity} from './volumes';
import {evaluateSpace,measureSpace,spaceReservations,type SpaceEvaluation,type SpaceReservations} from './space';
import {copyTimeRange} from './estimate';

/**
 * project.root は開いている案件のフォルダー（そのフォルダーとその中を「場所を指定」で選べないようにする）。
 * customPath（場所を指定）は、呼び出し側（Task 12・13 の customPath() ＝ assertBrowsablePath）で許可された場所の中の実パスに限ってから渡す前提（ここでは許可範囲を見ない）。
 */
export interface DestinationInput {project:{name:string;id:string;root:string};sources:Array<{path:string;sizeBytes:number}>;sourceBytesPerSecond?:number;customPath?:string}
/** 開始に使うコピー先: base（既にある場所）と、その下に1段ずつ作る segments（場所を指定した時は空）。 */
export interface ChosenDestination {key:string;kind:CopyDestinationKind;label:string;volume:VolumeIdentity;base:string;segments:string[];margin:number}
/** chosen は場所のドライブを識別できた（ネットワークでない）候補だけ（それ以外は選べない候補として見せるだけ）。removable は取り外し可能な媒体（勧めない）。 */
interface Candidate {view:CopyDestinationView;chosen?:ChosenDestination;removable:boolean}
/** 試験専用（製品の経路からは書き換えない）。volumesRoot は外付けの取り付け先の親（mountKind の /Volumes/<名前> と同じ）。 */
export const destinationsTesting={volumesRoot:'/Volumes'};
const PROJECT_STATE_REASON='案件の管理用フォルダー（.harness）の中には置けません',PROJECT_FOLDER_REASON='開いている案件のフォルダーの中には置けません';

/**
 * 元の素材のある媒体かを判定する関数。識別（UUID）を主に、同じ APFS の入れ物の別のボリュームも同じドライブとして除く。
 * dev は元のボリュームを識別できない時の補助だけ（試験の偽ボリュームは dev が共通なので、常に dev を足すと SSD・内蔵まで「元と同じドライブ」になる）。
 * ネットワークのボリュームの dev は NETWORK_DEV（-1）なので dev の照合には一致しない（そもそも候補にしない）。元を確かめられなければ一覧を出さない（元の媒体を候補に残さない）。
 */
async function sourceMedia(io:CopyIo,sources:DestinationInput['sources'],volumes:VolumeIdentity[]):Promise<(volume:VolumeIdentity)=>boolean>{
  const uuids=new Set<string>(),units=new Set<string>(),devs=new Set<number>();
  for(const source of sources){
    let dev:number,volume:VolumeIdentity|undefined;
    try{const real=await io.realpath(source.path);dev=(await io.stat(real)).dev;volume=await volumeOfPath(io,real,volumes);}
    catch(error){if(isSimulatedCrash(error))throw error;throw new HttpError(409,'元の素材を確かめられません。ドライブの接続を確認してください',{cause:error});}
    if(!volume){devs.add(dev);continue;}
    uuids.add(volume.uuid);if(volume.spaceUnit.startsWith('apfs:'))units.add(volume.spaceUnit);
  }
  return volume=>uuids.has(volume.uuid)||units.has(volume.spaceUnit)||devs.has(volume.dev);
}
const within=(path:string,folder:string)=>path===folder||path.startsWith(`${folder}/`);
/**
 * 指定した場所のボリューム（リンクをたどらない見かけの場所で決め、dev は根からの確認で照合する。ネットワークの場所に触れずに断るため）:
 * 外付けの取り付け先の下なら最も長いもの。/Volumes そのものと、一覧の外付けに当たらない /Volumes の下（取り付けられていないドライブの残りのフォルダーなど）は識別できない（undefined）:
 * /Volumes は内蔵と同じ dev なので、内蔵とみなすと取り外した後に残ったフォルダーへ、つまり内蔵へ書いてしまう（設計 §3）。それ以外は起動ディスクのデータボリューム。
 */
function volumeAt(path:string,volumes:VolumeIdentity[]):VolumeIdentity|undefined{
  const external=volumes.filter(volume=>volume.kind==='external'&&within(path,volume.mountPoint)).sort((a,b)=>b.mountPoint.length-a.mountPoint.length)[0];
  if(external)return external;if(within(path,destinationsTesting.volumesRoot))return undefined;return volumes.find(volume=>volume.kind==='boot-data');
}
const quiet=(error:unknown)=>{if(isSimulatedCrash(error))throw error;return undefined;};
/**
 * 案件に属する場所か: どの案件でも管理用フォルダー（.harness）の段を含む場所（名前で比べる。大文字小文字の違う書き方も同じとみなす）と、
 * 開いている案件のフォルダーそのものとその中（実体 dev・ino で比べる。大文字小文字・正規化の違う書き方でも見逃さない）。場所を根から1段ずつ lstat する（リンクは copyFolderRefusal が断る）。
 */
async function projectPlaceRefusal(io:CopyIo,root:string,path:string):Promise<string|undefined>{
  const parts=path.split('/').filter(Boolean);if(parts.some(part=>part.toLowerCase()==='.harness'))return PROJECT_STATE_REASON;
  const project=await io.stat(root).catch(quiet);if(!project)return undefined;
  let at='';for(const part of parts){at+=`/${part}`;const info=await io.lstat(at).catch(quiet);if(!info)return undefined;if(info.dev===project.dev&&info.ino===project.ino)return PROJECT_FOLDER_REASON;}
  return undefined;
}

/**
 * 候補（設計 §3）: 内蔵（~/Movies/Harness 素材/<案件名>-<ID8>/）と、書き込み可能な外付け（/Volumes/<名前>/Harness 素材/<案件名>-<ID8>/）。
 * 束・対象に含まれるすべての元の媒体のボリュームとネットワークのボリュームは除く。「場所を指定」にも同じ検査を課す（除かずに理由を出す）。
 * 取り外し可能な媒体（SD カード）は書き込みが遅いことがあるので、外付けの候補の最後に回して注記を添え、勧めない（選べるかどうかは変えない）。
 * どの候補も、開始時の ensureCopyFolder と同じ確認（根から1段ずつ lstat）を一覧の段でも行い、通らなければ選べない（開始時に初めて断られないように）。何も作らない。
 */
async function candidates(io:CopyIo,input:DestinationInput,reservations:SpaceReservations):Promise<Candidate[]>{
  const volumes=await listVolumes(io),isSource=await sourceMedia(io,input.sources,volumes);
  const copyBytes=input.sources.reduce((sum,source)=>sum+source.sizeBytes,0),time=copyTimeRange(copyBytes,input.sourceBytesPerSecond);
  const segments=[COPY_ROOT_NAME,copyFolderName(input.project.name,input.project.id)],out:Candidate[]=[];
  const add=async(kind:CopyDestinationKind,volume:VolumeIdentity|undefined,base:string,segs:string[],label:string,refusal?:string)=>{
    const known=volume&&!volume.network?volume:undefined;let reason=refusal??(known?undefined:UNKNOWN_DRIVE_REASON),space:SpaceEvaluation|undefined;
    if(!reason&&known)reason=await copyFolderRefusal(io,known,base,segs);
    if(!reason&&known)try{space=evaluateSpace(await measureSpace(io,base),reservations.reservedIn(known.spaceUnit),copyBytes);reason=space.reason;}
    catch(error){if(isSimulatedCrash(error))throw error;reason='空き容量を測れないため選べません';}   // 試験の強制終了は受け止めずに通す
    const key=kind==='volume'?`volume:${volume!.uuid}`:kind,removable=known?.removable===true;
    out.push({view:{key,label,volume:known?{uuid:known.uuid,dev:known.dev}:{uuid:'',dev:NETWORK_DEV},
      space:space?{free:space.free,capacity:space.capacity,after:space.after,margin:space.margin}:null,selectable:!reason,...(reason?{reason}:{}),time,...(removable?{note:COPY_REMOVABLE_NOTE}:{})},
      removable,...(known&&space?{chosen:{key,kind,label,volume:known,base,segments:segs,margin:space.margin}}:{})});
  };
  const home=volumes.find(volume=>volume.kind==='boot-data');
  if(home&&!isSource(home))await add('internal',home,join(io.home(),'Movies'),segments,'このMac（ムービー）',home.writable?undefined:'書き込めないドライブです');
  const drives=volumes.filter(volume=>volume.kind==='external'&&!volume.network&&volume.writable&&!isSource(volume));
  for(const volume of [...drives.filter(drive=>!drive.removable),...drives.filter(drive=>drive.removable)])await add('volume',volume,volume.mountPoint,segments,volume.label);
  if(input.customPath){
    const path=input.customPath,volume=volumeAt(path,volumes);
    const refusal=!volume?UNKNOWN_DRIVE_REASON:volume.network?'ネットワークの場所には置けません':!volume.writable?'書き込めないドライブです':isSource(volume)?'元の素材と同じドライブには置けません'
      :await projectPlaceRefusal(io,input.project.root,path);
    await add('custom',volume,path,[],`指定した場所（${basename(path)}）`,refusal);
  }
  // 条件を満たす候補を勧める: コピー後に最も空きが残るもの（同じなら先の候補）。取り外し可能な媒体は勧めない。
  // それしか選べない時は、勧める候補が無い時の既存の扱い（既定の選択なし。画面は利用者が選ぶまで始められない）に合わせる: 選べるまま、利用者が注記を見て明示的に選ぶ。
  const best=out.filter(candidate=>candidate.view.selectable&&!candidate.removable).sort((a,b)=>(b.view.space?.after??0)-(a.view.space?.after??0))[0];if(best)best.view.recommended=true;
  return out;
}
export async function listCopyDestinations(io:CopyIo,input:DestinationInput,reservations:SpaceReservations=spaceReservations):Promise<CopyDestinationView[]>{
  return (await candidates(io,input,reservations)).map(candidate=>candidate.view);
}
/** 開始時の確認: 今の候補を作り直し、選んだ時と同じ識別（UUID・dev）で、今も選べること。断る時は HttpError(409)。 */
export async function resolveCopyDestination(io:CopyIo,input:DestinationInput,request:CopyDestinationRequest,reservations:SpaceReservations=spaceReservations):Promise<ChosenDestination>{
  const found=(await candidates(io,{...input,...(request.customPath?{customPath:request.customPath}:{})},reservations)).find(candidate=>candidate.view.key===request.key);
  if(!found)throw new HttpError(409,'選んだコピー先が見つかりません。もう一度選んでください');
  if(found.view.volume.uuid!==request.uuid||found.view.volume.dev!==request.dev)throw new HttpError(409,'コピー先のドライブが選んだ時から入れ替わりました。もう一度選んでください');
  if(!found.view.selectable||!found.chosen)throw new HttpError(409,found.view.reason??'このコピー先は選べません');
  return found.chosen;
}
