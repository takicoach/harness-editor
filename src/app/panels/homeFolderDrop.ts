import {createMediaKind} from '../../shared/createMedia';
import {MAX_IMPORT_BATCH_ITEMS} from '../../shared/importBatches';
import {orderByName} from '../../shared/importOrder';
import {MAX_DOCUMENT_BYTES,MAX_DOCUMENTS,isDocumentName} from '../../shared/projectDocuments';

/** フォルダのドロップ（設計 3-1）。ドロップの中身をブラウザの仕組みで読み、素材集に入れる動画を決める。 */
export const FOLDER_SCAN_LIMITS={depth:5,entries:2000} as const;
export const MAX_DROPPED_FOLDERS=50;
export type DropKind={kind:'folder';entry:FileSystemDirectoryEntry}|{kind:'folders';entries:FileSystemDirectoryEntry[]}|{kind:'files'}|{kind:'refuse';message:string};
/** フォルダが 1 つならフォルダ、2 つ以上なら複数のフォルダ、無ければファイル。フォルダとファイルの混在は断る。読めない項目はファイル扱い（今と同じ）。 */
export function classifyDrop(items:DataTransferItemList|readonly DataTransferItem[]):DropKind{
  const entries=Array.from(items as ArrayLike<DataTransferItem>).filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.()??null);
  const folders=entries.filter((entry):entry is FileSystemDirectoryEntry=>!!entry&&entry.isDirectory);
  if(!folders.length)return {kind:'files'};
  if(entries.length>folders.length)return {kind:'refuse',message:'フォルダとファイルは分けてドロップしてください'};
  if(folders.length>MAX_DROPPED_FOLDERS)return {kind:'refuse',message:`フォルダは1回に${MAX_DROPPED_FOLDERS}個までドロップできます`};
  return folders.length>1?{kind:'folders',entries:folders}:{kind:'folder',entry:folders[0]!};
}
/** path はフォルダからの相対パス（区切りは /）。 */
export interface FolderDocument {path:string;file:File}
export interface FolderScan {folderName:string;files:File[];documents:FolderDocument[];skipped:number}
/**
 * 見つけたファイルから取り込む動画と保管する書類を決める。それ以外は skipped に数える。動画の並びは名前の自然順（サーバと同じ）。
 * Word が開いている間に置く作業ファイル（~$）は数えない。上限を超える書類は、作ってから失敗にせず skipped に数える。
 */
export function planFolder(found:readonly {path:string;file:File}[],folderName:string):FolderScan|{refuse:string}{
  const real=found.filter(entry=>!entry.file.name.startsWith('~$'));
  const videos=real.filter(entry=>createMediaKind(entry.file.name)==='video');
  if(!videos.length)return {refuse:`フォルダ「${folderName}」に動画がありません`};
  if(videos.length>MAX_IMPORT_BATCH_ITEMS)return {refuse:`フォルダの動画は1回に${MAX_IMPORT_BATCH_ITEMS}本まで取り込めます（フォルダ「${folderName}」の動画: ${videos.length} 本）`};
  const documents=orderByName(real.filter(entry=>isDocumentName(entry.file.name)&&entry.file.size<=MAX_DOCUMENT_BYTES),entry=>entry.path).slice(0,MAX_DOCUMENTS);
  return {folderName,files:orderByName(videos,entry=>entry.file.name).map(entry=>entry.file),documents:documents.map(({path,file})=>({path,file})),skipped:real.length-videos.length-documents.length};
}
const readChunk=(reader:FileSystemDirectoryReader)=>new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));
const fileOf=(entry:FileSystemFileEntry)=>new Promise<File>((resolve,reject)=>entry.file(resolve,reject));
/**
 * フォルダを再帰で読む（readEntries は 1 回で全部を返さないので空になるまで読む）。件数の上限を超えたら読むのをやめて断る。上限より深いフォルダは読まない。
 * 隠し項目は読まず、数えない（外付けの一番上にある .Trashes などは読めないことがあり、読みに行くと動画があっても全体を断ることになる）。
 */
export async function readDroppedFolder(root:FileSystemDirectoryEntry,limits:{depth:number;entries:number}=FOLDER_SCAN_LIMITS):Promise<FolderScan|{refuse:string}>{
  const found:{path:string;file:File}[]=[];let seen=0;
  const tooMany={refuse:`フォルダの中のファイルが多すぎます（${limits.entries.toLocaleString()} 件まで）。動画だけのフォルダにしてください`};
  const walk=async(folder:FileSystemDirectoryEntry,prefix:string,depth:number):Promise<boolean>=>{
    const reader=folder.createReader(),entries:FileSystemEntry[]=[];
    for(let chunk=await readChunk(reader);chunk.length;chunk=await readChunk(reader))
      for(const entry of chunk){
        if(entry.name.startsWith('.'))continue;
        if(++seen>limits.entries)return false;
        entries.push(entry);
      }
    for(const entry of entries){
      const path=prefix+entry.name;
      if(entry.isDirectory){if(depth<limits.depth&&!await walk(entry as FileSystemDirectoryEntry,`${path}/`,depth+1))return false;}
      else if(entry.isFile)found.push({path,file:await fileOf(entry as FileSystemFileEntry)});
    }
    return true;
  };
  try{if(!await walk(root,'',1))return tooMany;}
  catch{return {refuse:`フォルダ「${root.name}」を読めませんでした`};}
  return planFolder(found,root.name);
}
/** 複数のフォルダを順に読む。断られたフォルダは理由と一緒に返す（残りは作れるように）。 */
export async function readDroppedFolders(entries:readonly FileSystemDirectoryEntry[],limits:{depth:number;entries:number}=FOLDER_SCAN_LIMITS):Promise<{folders:FolderScan[];refused:{name:string;reason:string}[]}>{
  const folders:FolderScan[]=[],refused:{name:string;reason:string}[]=[];
  for(const entry of entries){
    const scan=await readDroppedFolder(entry,limits);
    if('refuse' in scan)refused.push({name:entry.name,reason:scan.refuse});else folders.push(scan);
  }
  return {folders,refused};
}
/**
 * フォルダ選択（webkitdirectory）の結果を読む。実パスに頼らず、ブラウザの相対パスだけを使う。
 * ドロップと違って一覧が揃った後でしか絞れないので、大きなフォルダでは選択の完了までブラウザが待つ。
 */
export function scanFromInputFiles(files:readonly File[],limits:{depth:number;entries:number}=FOLDER_SCAN_LIMITS):FolderScan|{refuse:string}{
  if(!files.length)return {refuse:'フォルダが空です。素材の入ったフォルダを選んでください'};
  const found:{path:string;file:File}[]=[];let folderName='';
  for(const file of files){
    const [root,...rest]=(file.webkitRelativePath||'').split('/');
    if(!root||!rest.length)return {refuse:'フォルダの中身を読めませんでした'};
    folderName=root;
    if(rest.some(part=>part.startsWith('.'))||rest.length>limits.depth)continue;
    found.push({path:rest.join('/'),file});
  }
  if(found.length>limits.entries)return {refuse:`フォルダの中のファイルが多すぎます（${limits.entries.toLocaleString()} 件まで）。動画だけのフォルダにしてください`};
  return planFolder(found,folderName);
}
