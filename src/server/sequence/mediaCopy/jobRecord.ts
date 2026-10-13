import {randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {SequenceAsset} from '../../../core/sequence/model';
import {COPY_ITEM_PHASES} from '../../../shared/mediaCopy';

const inode=z.object({dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative()}).strict();
const fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
/**
 * 項目の記録。reserved は予約の印（作る前に印だけで記録するので dev・ino は省略可）、part は .part（作る前に名前だけで記録するので dev・ino は省略可。size・mtimeMs は読み直す前の値で省略可）、final は確定した実体（Task 7）。
 * unresolved: 接続を変えた結果が分からず、台帳も読めなかった（完成ファイルは消さずに残し、起動時の回収 Task 11 で台帳と照合し直す）。
 * 元の側の値（dev・ino）は記録の型を縛らない（ネットワークのドライブなどで ino が 2^53 を超えうる）。元の識別情報はメモリだけで持つ（記録しない）。
 */
const itemSchema=z.object({itemId:z.string().regex(/^c\d{1,2}$/),name:z.string().min(1).max(255),sizeBytes:z.number().int().nonnegative(),source:z.string().min(1).max(4096),sourceDev:z.number(),
  target:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('reconnect'),assetId:z.string().min(1).max(256),assetFile:z.string().min(1).max(512),generation:z.string().uuid(),expectedFingerprint:fingerprint}).strict(),
    // add の expectedFingerprint: 画面で選んだ素材の指紋（受け渡しの時に分かっていれば。コピー中に中身の違いで止める。足しただけなので前の記録も読める）
    z.object({kind:z.literal('add'),batchId:z.string().regex(/^imp-[a-f0-9]{20}$/),batchItemId:z.string().regex(/^i\d{1,3}$/),expectedFingerprint:fingerprint.optional()}).strict()]),
  phase:z.enum(COPY_ITEM_PHASES),finalName:z.string().min(1).max(300).optional(),reserved:z.object({dev:z.number().int().nonnegative().optional(),ino:z.number().int().nonnegative().optional(),token:z.string().regex(/^[a-f0-9]{32}$/)}).strict().optional(),reused:z.boolean().optional(),
  part:z.object({dev:z.number().int().nonnegative().optional(),ino:z.number().int().nonnegative().optional(),name:z.string().regex(/\.[a-f0-9]{16}\.harness-part$/),size:z.number().int().nonnegative().optional(),mtimeMs:z.number().optional()}).strict().optional(),
  final:inode.extend({size:z.number().int().nonnegative(),mtimeMs:z.number()}).strict().optional(),
  fingerprint:fingerprint.optional(),connected:z.boolean().optional(),unresolved:z.literal(true).optional(),assetId:z.string().min(1).max(256).optional(),error:z.string().max(1100).optional()}).strict();
/**
 * 作業の記録 .harness/copy-jobs/<ジョブID>.json（設計 §5）。作成したプロセス（pid と開始時刻）・コピー先ボリュームの識別・各項目の段・作成した実体。
 * recordFolder: 記録を作った時の記録先（.harness/copy-jobs）の dev・ino。案件フォルダーを複製・復元した先では違うので、回収はその記録で台帳を見ず何も消さない（Task 11）。
 * 案件のドライブによっては ino が 2^53 を超えうるので、整数に縛らない。
 */
export const jobRecordSchema=z.object({format:z.literal('harness-copy-job'),version:z.literal(1),jobId:z.string().regex(/^cp-[a-f0-9]{20}$/),
  owner:z.object({pid:z.number().int().positive(),startedAt:z.number().nonnegative()}).strict(),recordFolder:z.object({dev:z.number(),ino:z.number()}).strict(),createdAt:z.string().min(1).max(64),projectId:z.string().min(1).max(1024),
  mode:z.enum(['reconnect','add']),margin:z.number().nonnegative(),
  destination:z.object({kind:z.enum(['internal','volume','custom']),label:z.string().min(1).max(300),
    volume:z.object({uuid:z.string().min(1).max(200),dev:z.number().int().nonnegative(),mountPoint:z.string().min(1).max(4096),spaceUnit:z.string().min(1).max(300)}).strict(),
    folder:inode.extend({path:z.string().min(1).max(4096)}).strict()}).strict(),
  state:z.enum(['running','finished','stopped','waiting-volume']),stopReason:z.string().max(1100).optional(),dismissed:z.boolean().optional(),kept:z.array(z.string().max(300)).max(200).optional(),
  items:z.array(itemSchema).min(1).max(50)}).strict();
export type CopyJobRecord=z.infer<typeof jobRecordSchema>;
export type CopyJobItemRecord=CopyJobRecord['items'][number];
const FOLDER='copy-jobs',RECORD=/^cp-[a-f0-9]{20}\.json$/,MAX_BYTES=256*1024;
export const newCopyJobId=()=>`cp-${randomBytes(10).toString('hex')}`;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
/** 記録先 .harness/copy-jobs。.harness は作らない（削除された案件を復活させない）。copy-jobs だけを再帰なしで作る。 */
async function folder(root:string,create:boolean):Promise<string|undefined>{
  const harness=join(root,'.harness'),dir=join(harness,FOLDER);
  const outer=await lstat(harness).catch(error=>{if(missing(error))return undefined;throw error;});
  if(!outer){if(create)throw new Error('案件の記録先（.harness）がありません');return undefined;}
  if(!outer.isDirectory()||outer.isSymbolicLink())throw new Error('案件の記録先が不正です');
  if(create)await mkdir(dir).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
  const info=await lstat(dir).catch(error=>{if(missing(error))return undefined;throw error;});if(!info)return undefined;
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('コピーの記録先が不正です');return dir;
}
/** 記録先（.harness/copy-jobs）の dev・ino。create は記録先を作る（作業の開始時）。無ければ undefined。 */
export async function copyJobsFolderIdentity(root:string,create=false):Promise<{dev:number;ino:number}|undefined>{
  const dir=await folder(root,create);if(!dir)return undefined;const info=await lstat(dir);return {dev:info.dev,ino:info.ino};
}
/** 記録の形が正しくない（画面には決まった文言だけを出す。詳しい内容はログへ）。 */
export class CopyJobRecordInvalidError extends Error{constructor(){super('コピーの記録の形が正しくありません');this.name='CopyJobRecordInvalidError';}}
/** 段が変わるたびに書く（推測できない名前の一時ファイル＋同期＋rename＋記録のフォルダーの同期）。 */
export async function writeCopyJobRecord(root:string,record:CopyJobRecord):Promise<void>{
  const parsed=jobRecordSchema.safeParse(record);
  if(!parsed.success){console.error('[sme] コピーの記録の形が正しくありません:',parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; '));throw new CopyJobRecordInvalidError();}
  const dir=(await folder(root,true))!,value=parsed.data,temporary=join(dir,`${record.jobId}.${randomUUID()}.tmp`),handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}
  catch(error){await handle.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);throw error;}
  await handle.close();
  try{await rename(temporary,join(dir,`${record.jobId}.json`));}catch(error){await unlink(temporary).catch(()=>undefined);throw error;}
  // 名前の置き換えをドライブに残す（できない場合でも、起動時の回収は確定した実体を台帳と照合してから消す）
  const directory=await open(dir,constants.O_RDONLY).catch(()=>undefined);
  if(directory)try{await directory.sync();}catch{/* フォルダーの同期ができないファイルシステム */}finally{await directory.close().catch(()=>undefined);}
}
/** 読めない・形が違う記録は飛ばす（回収もしない＝その記録の実体は消さない）。 */
export async function readCopyJobRecords(root:string):Promise<CopyJobRecord[]>{
  const dir=await folder(root,false);if(!dir)return [];const records:CopyJobRecord[]=[];
  for(const name of (await readdir(dir)).filter(entry=>RECORD.test(entry)).sort()){
    try{
      const handle=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const info=await handle.stat();if(!info.isFile()||info.size>MAX_BYTES){console.warn('[sme] コピーの記録を読めません:',name);continue;}
        const parsed=jobRecordSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
        if(parsed.success&&`${parsed.data.jobId}.json`===name)records.push(parsed.data);else console.warn('[sme] コピーの記録を読めません:',name);}
      finally{await handle.close();}
    }catch(error){console.warn('[sme] コピーの記録を読めません:',name,error instanceof Error?error.message:error);}
  }
  return records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.jobId.localeCompare(b.jobId));
}
/** 終わって閉じた記録（自分の実体が残っていないもの）だけを、新しい keep 件を残して消す。 */
export async function pruneCopyJobRecords(root:string,keep=20):Promise<void>{
  const dir=await folder(root,false);if(!dir)return;
  const ended=(await readCopyJobRecords(root)).filter(record=>record.dismissed&&(record.state==='finished'||record.state==='stopped')
    &&!record.items.some(item=>item.part||item.unresolved||((item.reserved||item.final)&&!item.connected&&!item.reused)));
  for(const record of ended.slice(0,Math.max(0,ended.length-keep)))await unlink(join(dir,`${record.jobId}.json`)).catch(()=>undefined);
}
/** 台帳を読む出入口（結果不明の判定に使う。作業と回収で共有する）。 */
export interface LedgerPorts {target(root:string,file:string):Promise<string|undefined>;references(root:string):Promise<SequenceAsset[]>}
/** 台帳を読めない（別のプロセスが変更中・記録の破損など）。「つながっていない」とは答えない（完成ファイルを消さない）。 */
export class LedgerUnreadableError extends Error{constructor(cause:unknown){super('参照台帳を読めないため、接続の結果を確かめられません',{cause});this.name='LedgerUnreadableError';}}
const unreadable=(error:unknown):never=>{throw new LedgerUnreadableError(error);};
/** 台帳の接続先はディスク上の形（実パスの解決の結果）。copied.path とは Unicode の正規化（NFC/NFD）だけ違いうるので、両側を NFC にそろえて比べる。 */
const samePath=(target:string|undefined,path:string)=>target!==undefined&&target.normalize('NFC')===path.normalize('NFC');
/**
 * 結果不明の判定（設計 §5-7）: 台帳の接続先が新しい場所を指しているか。追加時は同じ指紋の登録を探す。
 * 台帳が無い（未登録・削除済み）は「つながっていない」。台帳を読めない時は LedgerUnreadableError を投げる（呼び手は完成ファイルを消さずに記録を残す）。
 */
export async function ledgerConnects(ports:LedgerPorts,root:string,item:CopyJobItemRecord,path:string):Promise<{connected:boolean;asset?:SequenceAsset}>{
  if(item.target.kind==='reconnect')return {connected:samePath(await ports.target(root,item.target.assetFile).catch(unreadable),path)};
  for(const asset of await ports.references(root).catch(unreadable))
    if(asset.fingerprint===item.fingerprint&&samePath(await ports.target(root,asset.file).catch(unreadable),path))return {connected:true,asset};
  return {connected:false};
}
