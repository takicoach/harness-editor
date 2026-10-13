import type {Stats} from 'node:fs';
import {basename,join} from 'node:path';
import {isSimulatedCrash,type CopyIo,type MountedVolume,type VolumeDetails} from './io';

export const COPY_ROOT_NAME='Harness 素材';
const NETWORK_FS=new Set(['smbfs','nfs','afpfs','webdav','cifs','ftp','sshfs']);
/**
 * ボリュームは表示名ではなく識別（UUID と dev）で持つ（設計 §3）。kind は boot-data（このMac。/Users もここ）か external（/Volumes の下）。
 * spaceUnit は空きを共有する単位（APFS は同じ入れ物を1つとみなす: apfs:<入れ物>、それ以外は volume:<UUID>）。
 * dev はドライブではなくディスクの番号に付く（exFAT イメージで実測: 同じ番号に付き直せば同じ、逆の順で付け直すと2枚の dev が入れ替わる）。
 * dev だけでは別のドライブと区別できないので、照合は UUID と dev の両方で行い、付け直しをまたぐ照合は UUID で行う。
 * removable は取り外し可能な媒体（SD カード。diskutil の RemovableMedia。読めなければ false）。コピー先の候補では最後に回し、注記を添え、勧めない。
 * ネットワークのボリュームは根に触れずに登録する（切れかけの NAS で一覧ごと止まらないように stat も diskutil も呼ばない）。dev は -1（測っていない）で、書き込み不可・コピー先にしない。
 */
export interface VolumeIdentity {uuid:string;dev:number;mountPoint:string;label:string;fsType:string;kind:'boot-data'|'external';network:boolean;writable:boolean;removable:boolean;spaceUnit:string}
/** コピー先のフォルダーやボリュームが確かめられない（作業全体を止める）。 */
export class CopyFolderError extends Error{readonly stop=true as const;constructor(message:string,options?:{cause?:unknown}){super(message,options);this.name='CopyFolderError';}}

/** ネットワークのボリュームの dev（測っていない。実際の dev は 0 以上なので一致しない）。 */
export const NETWORK_DEV=-1;
/** ネットワークのボリュームなら、その識別（mount の装置名から。根に触れない・diskutil を呼ばない）。ローカルなら undefined。 */
export const networkVolumeUuid=(mount:MountedVolume):string|undefined=>NETWORK_FS.has(mount.fsType)||!mount.local?`network:${mount.device}`:undefined;
/**
 * 今つながっているボリューム。識別情報（VolumeUUID、無ければ DiskUUID）を読めないローカルのボリュームは除く（候補にも元の判定にも使わない）。ネットワークは mount の行だけで登録する。
 * mounts: 読んだばかりの mount の表（回収の見張りが同じ表で2回読まないため）。省略すると読む。
 */
export async function listVolumes(io:CopyIo,mounts?:readonly MountedVolume[]):Promise<VolumeIdentity[]>{
  const volumes:VolumeIdentity[]=[];
  for(const mount of mounts??await io.mounts()){
    if(mount.kind!=='boot-data'&&mount.kind!=='external')continue;
    const networkUuid=networkVolumeUuid(mount),network=networkUuid!==undefined;
    if(networkUuid){volumes.push({uuid:networkUuid,dev:NETWORK_DEV,mountPoint:mount.mountPoint,label:basename(mount.mountPoint),fsType:mount.fsType,kind:mount.kind,network,writable:false,removable:false,spaceUnit:`volume:${networkUuid}`});continue;}
    let dev:number;try{dev=(await io.stat(mount.mountPoint)).dev;}catch{continue;}
    const details:VolumeDetails|undefined=await io.volumeDetails(mount.mountPoint).catch(()=>undefined);if(!details)continue;
    const uuid=details.uuid??details.diskUuid;if(!uuid)continue;
    volumes.push({uuid,dev,mountPoint:mount.mountPoint,label:mount.kind==='boot-data'?'このMac':basename(mount.mountPoint),fsType:mount.fsType,kind:mount.kind,network,
      writable:!mount.readOnly&&details.writable!==false,removable:details.removable===true,spaceUnit:details.container?`apfs:${details.container}`:`volume:${uuid}`});
  }
  return volumes;
}
/** パスのあるボリューム。/Volumes の下は最も長い取り付け先、それ以外は起動ディスクのデータボリューム。どちらも dev が一致する時だけ（取り外し後に残ったフォルダーを外付けと取り違えない）。ネットワークは dev を測らないので取り付け先の場所だけで決める。 */
export async function volumeOfPath(io:CopyIo,path:string,volumes?:VolumeIdentity[]):Promise<VolumeIdentity|undefined>{
  const list=volumes??await listVolumes(io),real=await io.realpath(path),dev=(await io.stat(real)).dev;
  const external=list.filter(volume=>volume.kind==='external'&&(real===volume.mountPoint||real.startsWith(`${volume.mountPoint}/`))).sort((a,b)=>b.mountPoint.length-a.mountPoint.length)[0];
  if(external)return external.network||external.dev===dev?external:undefined;
  return list.find(volume=>volume.kind==='boot-data'&&volume.dev===dev);
}
/** 名前の部分の上限: 80 文字（コードポイント）かつ、ID の部分（「-」＋8文字）と合わせてフォルダー名の上限 255 バイトに収まる 246 バイト。 */
const NAME_CHARS=80,NAME_BYTES=255-9;
/** コピー先のフォルダー名: 案件名＋案件 ID の先頭8文字（同名の案件・置き換え後の名前で衝突しない。設計 §3）。文字の途中（サロゲートの片割れ）では切らない。 */
export function copyFolderName(name:string,id:string):string{
  const chars=Array.from(name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'_').replace(/^[. ]+|[. ]+$/g,'').trim()).slice(0,NAME_CHARS);
  while(Buffer.byteLength(chars.join(''))>NAME_BYTES)chars.pop();
  return `${chars.join('')||'案件'}-${id.replace(/[^A-Za-z0-9]/g,'').slice(0,8)||'00000000'}`;
}
export interface CopyFolder {path:string;dev:number;ino:number}
const SEGMENT=/^[^/\0]+$/;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const LINK_ON_THE_WAY='コピー先の途中にリンクまたはフォルダーでないものがあります';
/** 場所のドライブを識別できない（一覧の外のボリューム・取り付けられていない /Volumes の下・別のドライブ）。一覧の段の理由。 */
export const UNKNOWN_DRIVE_REASON='この場所のドライブを識別できないため、コピー先にできません';
/** base を根から1段ずつリンクをたどらずに確かめる（作らない）。途中の「.」「..」・無い・リンク・フォルダーでないものは CopyFolderError。passCrash は試験の強制終了を受け止めずに通す（一覧の段）。 */
async function walkBase(io:CopyIo,base:string,passCrash=false):Promise<{path:string;info:Stats}>{
  const parts=base.split('/').filter(Boolean);if(!base.startsWith('/')||!parts.length||parts.some(part=>part==='.'||part==='..'))throw new CopyFolderError('コピー先の場所が不正です');
  let path='',info:Stats|undefined;
  for(const part of parts){
    path+=`/${part}`;
    try{info=await io.lstat(path);}catch(error){if(passCrash&&isSimulatedCrash(error))throw error;throw new CopyFolderError(missing(error)?'コピー先のドライブまたはフォルダーが見つかりません（作り直しません）':'コピー先を確かめられません');}
    if(info.isSymbolicLink()||!info.isDirectory())throw new CopyFolderError(LINK_ON_THE_WAY);
  }
  return {path,info:info!};
}
/**
 * 一覧の段の確認（作らない。開始時に初めて断られないように）: ensureCopyFolder と同じく base を根から1段ずつ確かめ、base がボリュームと同じ dev、
 * 既にある segments もリンクでない本物のフォルダーで同じ dev であること。選べない理由を返す（選べるなら undefined）。
 * ボリュームの UUID は listVolumes で読んだばかりなので確かめ直さない（開始時は ensureCopyFolder が確かめる）。試験の強制終了はそのまま通す。
 */
export async function copyFolderRefusal(io:CopyIo,volume:VolumeIdentity,base:string,segments:readonly string[]):Promise<string|undefined>{
  let walked;try{walked=await walkBase(io,base,true);}catch(error){if(error instanceof CopyFolderError)return error.message;throw error;}
  let {path,info}=walked;if(info.dev!==volume.dev)return UNKNOWN_DRIVE_REASON;
  for(const segment of segments){
    if(!SEGMENT.test(segment)||segment==='.'||segment==='..')return 'コピー先のフォルダー名が不正です';
    path=join(path,segment);
    try{info=await io.lstat(path);}catch(error){if(isSimulatedCrash(error))throw error;return missing(error)?undefined:'コピー先のフォルダーを確かめられません';}   // 無い段から先は開始時に作る
    if(info.isSymbolicLink()||!info.isDirectory())return LINK_ON_THE_WAY;
    if(info.dev!==volume.dev)return 'コピー先の途中に別のドライブがあります';
  }
  return undefined;
}
/**
 * base（既にある場所。ボリュームの取り付け先・ムービー・指定した場所）から segments を1段ずつリンクをたどらずに作る（設計 §3）。
 * base とその途中は作らない（ボリュームが消えていたら作り直さずに止める＝内蔵へ書かない）。どの段もリンクでない本物のフォルダーで dev がボリュームと同じこと。
 * base の途中の「.」「..」も断る（見た場所と違う所へたどり直さない）。
 */
export async function ensureCopyFolder(io:CopyIo,volume:VolumeIdentity,base:string,segments:readonly string[]):Promise<CopyFolder>{
  if(volume.network)throw new CopyFolderError('ネットワークのドライブには書き込めないため、コピー先にできません');if(!volume.writable)throw new CopyFolderError('このドライブには書き込めないため、コピー先にできません');
  let {path,info}=await walkBase(io,base);
  if(info.dev!==volume.dev)throw new CopyFolderError('コピー先のドライブが選んだ時と違います');
  // dev は同じ番号に付いた別のドライブでも一致するので、取り付け先の UUID も確かめる（mounts は呼ばない: 作業中の mounts の回数を変えない）。
  const details=await io.volumeDetails(volume.mountPoint).catch(()=>undefined);if((details?.uuid??details?.diskUuid)!==volume.uuid)throw new CopyFolderError('コピー先のドライブが選んだ時と違います');
  for(const segment of segments){
    if(!SEGMENT.test(segment)||segment==='.'||segment==='..')throw new CopyFolderError('コピー先のフォルダー名が不正です');
    path=join(path,segment);
    // 作れない・確かめられない時も作業全体を止める（CopyFolderError。元の errno は cause に残す）。
    try{await io.mkdir(path);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code!=='EEXIST')throw new CopyFolderError(`コピー先のフォルダーを作れません（${code??'不明'}）`,{cause:error});}
    try{info=await io.lstat(path);}catch(error){throw new CopyFolderError('コピー先のフォルダーを確かめられません',{cause:error});}
    if(info.isSymbolicLink()||!info.isDirectory())throw new CopyFolderError(LINK_ON_THE_WAY);
    if(info.dev!==volume.dev)throw new CopyFolderError('コピー先の途中に別のドライブがあります');
  }
  return {path,dev:info.dev,ino:info.ino};
}
/** 作業（1本）ごとに開き直して照合する: 選んだ時のボリュームの識別（UUID・dev）と、フォルダーの dev・ino（設計 §3）。 */
export async function assertCopyFolder(io:CopyIo,folder:CopyFolder,volume:Pick<VolumeIdentity,'uuid'|'dev'>):Promise<void>{
  const now=(await listVolumes(io)).find(item=>item.uuid===volume.uuid);
  if(!now||now.dev!==volume.dev)throw new CopyFolderError('コピー先のドライブが取り外されたか、入れ替わりました');
  let info;try{info=await io.lstat(folder.path);}catch{throw new CopyFolderError('コピー先のフォルダーが見つかりません（作り直しません）');}
  if(info.isSymbolicLink()||!info.isDirectory()||info.dev!==folder.dev||info.ino!==folder.ino)throw new CopyFolderError('コピー先のフォルダーが作業中に置き換えられました');
}
