import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import {runCommand,type CopyIo} from '../io';

const run=promisify(execFile);
/** 自分が付けたイメージだけを外す（実在の媒体を外さない）。macOS が同名に「 1」を足した場合も含む。 */
export const OWN_MOUNT=/^\/Volumes\/HTX[0-9A-F]{4}( \d+)?$/;
/** 自分が作るイメージのファイル（一時フォルダーの harness-exfat-…/HTX….dmg）。 */
const OWN_IMAGE=/\/harness-exfat-[^/]+\/HTX[0-9A-F]{4}\.dmg$/;
export interface ExfatImage {dir:string;dmg:string;label:string;mountPoint:string}
/**
 * 使い捨ての exFAT ディスクイメージ（300MB）。置き場所は tmpdir()（実行時に TMPDIR で一時フォルダーへ向ける）。ラベルは exFAT の上限（11文字）に収まる HTX＋16進4桁。
 * label を渡すと同じ名前の別のイメージを作る（同じ名前の2枚のカードの再現）。
 */
export async function createExfatImage(options:{label?:string}={}):Promise<ExfatImage>{
  const label=options.label??`HTX${randomBytes(2).toString('hex').toUpperCase()}`;if(!OWN_MOUNT.test(`/Volumes/${label}`))throw new Error(`試験のイメージの名前ではありません: ${label}`);
  // hdiutil info は実際のパスで返すので、置き場所も実際のパスにしておく（取り残しの照合が一致するように）。
  const dir=await mkdtemp(join(await realpath(tmpdir()),'harness-exfat-')),dmg=join(dir,`${label}.dmg`);
  try{await run('/usr/bin/hdiutil',['create','-size','300m','-fs','ExFAT','-volname',label,dmg]);return {dir,dmg,label,mountPoint:await attachImage(dmg)};}
  // 付けたまま失敗した時（時間切れなど）は、外せた時だけフォルダーを消す（付いたままのイメージのファイルを消さない）。
  catch(error){await detachLeftoverImages(dir).then(()=>rm(dir,{recursive:true,force:true}),()=>undefined);throw error;}
}
export async function attachImage(dmg:string):Promise<string>{
  const {stdout}=await run('/usr/bin/hdiutil',['attach','-nobrowse','-plist',dmg]);
  const mountPoint=/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(stdout)?.[1];
  if(mountPoint&&OWN_MOUNT.test(mountPoint))return mountPoint;
  // 思わぬ場所に付いた時も付けたままにしない: 今付けたイメージ（同じ出力の装置）だけを外してから止める。
  const device=/<key>dev-entry<\/key>\s*<string>(\/dev\/disk\d+)<\/string>/.exec(stdout)?.[1];
  if(device)await run('/usr/bin/hdiutil',['detach','-force',device]).catch(()=>undefined);
  throw new Error(`使い捨てのイメージを付けられませんでした: ${mountPoint??'(なし)'}`);
}
/** 既に外れていれば何もしない。外せずに残った時は例外（イメージのファイルを消さずに残す）。 */
export async function detachImage(mountPoint:string):Promise<void>{
  if(!OWN_MOUNT.test(mountPoint))throw new Error(`試験のイメージ以外は外しません: ${mountPoint}`);
  if(!existsSync(mountPoint))return;
  await run('/usr/bin/hdiutil',['detach','-force',mountPoint]).catch(error=>{if(existsSync(mountPoint))throw error;});
}
export async function destroyExfatImage(image:ExfatImage):Promise<void>{await detachImage(image.mountPoint);await rm(image.dir,{recursive:true,force:true});}
/** 試験専用: 自分が付けたイメージだけが見える io。実在の媒体には diskutil を使わない（mount の一覧は読んだ直後に絞る。mount は表を読むだけで媒体には触れない）。 */
export function ownImagesIo(base:CopyIo):CopyIo{
  return {...base,mounts:async()=>(await base.mounts()).filter(mount=>OWN_MOUNT.test(mount.mountPoint)),
    volumeDetails:async mountPoint=>{if(!OWN_MOUNT.test(mountPoint))throw new Error(`試験のイメージ以外は調べません: ${mountPoint}`);return base.volumeDetails(mountPoint);}};
}
export interface AttachedImage {imagePath:string;device:string}
/** `hdiutil info -plist` を JSON にしたものから、root の下にある自分のイメージ（harness-exfat-…/HTX….dmg）と、その装置（/dev/diskN）だけを拾う。 */
export function ownImagesInInfo(parsed:unknown,root:string):AttachedImage[]{
  const images=typeof parsed==='object'&&parsed!==null&&Array.isArray((parsed as {images?:unknown}).images)?(parsed as {images:unknown[]}).images:[],found:AttachedImage[]=[];
  for(const image of images){
    if(typeof image!=='object'||image===null)continue;const record=image as Record<string,unknown>,imagePath=record['image-path'];
    if(typeof imagePath!=='string'||!imagePath.startsWith(`${root}/`)||!OWN_IMAGE.test(imagePath))continue;
    const entities=Array.isArray(record['system-entities'])?record['system-entities']:[];
    const device=entities.map(entity=>typeof entity==='object'&&entity!==null?(entity as Record<string,unknown>)['dev-entry']:undefined).find((entry):entry is string=>typeof entry==='string'&&/^\/dev\/disk\d+$/.test(entry));
    if(device)found.push({imagePath,device});
  }
  return found;
}
/** 今付いている自分のイメージ（既定は一時フォルダー全体の harness-exfat-*）。 */
export async function attachedOwnImages(root?:string):Promise<AttachedImage[]>{
  const info=await runCommand('/usr/bin/hdiutil',['info','-plist']);if(info.code!==0)throw new Error(`hdiutil info が失敗しました: ${info.stderr.trim()}`);
  const json=await runCommand('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:info.stdout});if(json.code!==0)throw new Error(`hdiutil info を読めませんでした: ${json.stderr.trim()}`);
  return ownImagesInInfo(JSON.parse(json.stdout),root??await realpath(tmpdir()));
}
/** 試験の後片付け: 取り残した自分のイメージ（attach が時間切れになった後に付いたものなど）を装置ごと外し、その一時フォルダーを消す。外したイメージのパスを返す。 */
export async function detachLeftoverImages(root?:string):Promise<string[]>{
  const done:string[]=[];
  for(const image of await attachedOwnImages(root)){await run('/usr/bin/hdiutil',['detach','-force',image.device]);await rm(dirname(image.imagePath),{recursive:true,force:true});done.push(image.imagePath);}
  return done;
}
