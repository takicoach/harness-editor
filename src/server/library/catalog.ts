import {lstat,mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {extname,isAbsolute,join,relative as rel,resolve,sep} from 'node:path';

export type LibraryMediaKind='se'|'bgm'|'image';
export interface LibraryPack{packId:string;name:string;component:string;asset:string}
export interface LibraryTemplate{key:string;packId:string;template:number;name:string;group:string;use:string;preview:string;sample:string;durationSec:number}
export interface LibraryMedia{key:string;kind:LibraryMediaKind;name:string;desc:string;file:string;preview?:string;fingerprint:string;durationSec?:number;gainDb?:number}
export interface LibraryCatalog{version:2;packs:LibraryPack[];templates:LibraryTemplate[];media:LibraryMedia[]}
export type LibraryPurpose='preview'|'audio'|'image'|'component'|'assetJson';
export type LibraryListing={ok:true;directory:string;catalog:LibraryCatalog;missing:string[]}|{ok:false;directory:string;reason:string};
export class LibraryError extends Error{constructor(message:string,readonly status=400){super(message);}}

const EXT:Record<LibraryPurpose,RegExp>={preview:/^\.(jpe?g|png|webp)$/,audio:/^\.(wav|mp3|m4a|aac|flac|ogg)$/,image:/^\.(png|jpe?g|webp)$/,component:/^\.mjs$/,assetJson:/^\.json$/};
export const libraryExtensionAllowed=(purpose:LibraryPurpose,extension:string)=>EXT[purpose].test(extension.toLowerCase());
const text=(v:unknown,max=2000):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const rec=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const relPath=(v:unknown)=>text(v,512)&&!isAbsolute(v)&&!v.split(/[\\/]/).includes('..');

/** 素材置場。HARNESS_LIBRARY_DIR が無ければ、保存先フォルダ（HARNESS_PROJECT_ROOT・旧 SME_PROJECT_ROOT・無ければ cwd）の中の「素材置場」。 */
export function libraryDirectory(env:NodeJS.ProcessEnv=process.env):string{
  if(env.HARNESS_LIBRARY_DIR)return resolve(env.HARNESS_LIBRARY_DIR);
  return join(resolve(env.HARNESS_PROJECT_ROOT??env.SME_PROJECT_ROOT??process.cwd()),'素材置場');
}

export const emptyLibraryCatalog=():LibraryCatalog=>({version:2,packs:[],templates:[],media:[]});
/** 既定の場所（HARNESS_LIBRARY_DIR 無し）で台帳がまだ無ければ真。指定した場所が無い時（外付けの外れ等）は空の置き場と取り違えない。 */
export async function libraryNotStartedYet(directory:string,env:NodeJS.ProcessEnv=process.env):Promise<boolean>{
  if(env.HARNESS_LIBRARY_DIR)return false;
  try{await lstat(join(directory,'catalog.json'));return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}
}
/** 既定の場所に空の台帳を作る。既にあれば何もしない（上書きしない）。 */
export async function startDefaultLibrary(directory:string):Promise<void>{
  await mkdir(directory,{recursive:true});
  try{await writeFile(join(directory,'catalog.json'),JSON.stringify(emptyLibraryCatalog(),null,2)+'\n',{flag:'wx'});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
}

export function parseLibraryCatalog(value:unknown):LibraryCatalog{
  if(!rec(value)||value.version!==2||!Array.isArray(value.packs)||!Array.isArray(value.templates)||!Array.isArray(value.media))
    throw new LibraryError('素材置場の台帳（catalog.json）が v2 の形ではありません');
  const keys=new Set<string>(),packIds=new Set<string>();
  const key=(k:unknown)=>{if(!text(k,120))throw new LibraryError('台帳の key が不正です');if(keys.has(k))throw new LibraryError(`台帳の key が重複しています: ${k}`);keys.add(k);};
  for(const p of value.packs){
    if(!rec(p)||!text(p.packId,80)||!text(p.name,120)||!relPath(p.component)||!relPath(p.asset))throw new LibraryError('台帳のパックが不正です');
    if(packIds.has(p.packId))throw new LibraryError(`台帳のパックが重複しています: ${p.packId}`);
    packIds.add(p.packId);
  }
  for(const t of value.templates){
    if(!rec(t)||!text(t.packId,80)||!Number.isSafeInteger(t.template)||(t.template as number)<1||!text(t.name,120)||!text(t.group,60)||typeof t.use!=='string'
      ||!relPath(t.preview)||typeof t.sample!=='string'||t.sample.length>2000||typeof t.durationSec!=='number'||!(t.durationSec>0&&t.durationSec<=600))
      throw new LibraryError('台帳のモーションが不正です');
    if(!packIds.has(t.packId))throw new LibraryError(`台帳のモーションが存在しないパックを参照しています: ${t.packId}`);
    key(t.key);
  }
  for(const m of value.media){
    if(!rec(m)||!['se','bgm','image'].includes(String(m.kind))||!text(m.name,120)||typeof m.desc!=='string'||!relPath(m.file)
      ||(m.preview!==undefined&&!relPath(m.preview))||(m.durationSec!==undefined&&!(typeof m.durationSec==='number'&&m.durationSec>0))
      ||(m.gainDb!==undefined&&!(typeof m.gainDb==='number'&&m.gainDb>=-60&&m.gainDb<=12)))throw new LibraryError('台帳の素材が不正です');
    if(typeof m.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(m.fingerprint))throw new LibraryError('台帳の素材の指紋が不正です');
    key(m.key);
  }
  return value as unknown as LibraryCatalog;
}

/** All library reads go through here: real path inside the library, a regular file, an extension for the purpose. */
export async function resolveLibraryFile(directory:string,relative:string,purpose:LibraryPurpose):Promise<string>{
  if(!relPath(relative))throw new LibraryError('素材置場のパスが不正です');
  if(!EXT[purpose].test(extname(relative).toLowerCase()))throw new LibraryError('素材置場のファイル形式が用途に合いません');
  let root:string,real:string;
  try{root=await realpath(directory);real=await realpath(join(directory,relative));}catch{throw new LibraryError('素材置場のファイルが見つかりません',404);}
  const inside=rel(root,real);
  if(!inside||isAbsolute(inside)||inside.split(sep)[0]==='..')throw new LibraryError('素材置場の外を指すファイルは使えません');
  // No symlink anywhere on the path inside the library: the real path must equal the lexical one.
  if(real.normalize('NFC')!==resolve(root,relative).normalize('NFC'))throw new LibraryError('素材置場のリンクは使えません');
  if(!(await stat(real)).isFile())throw new LibraryError('素材置場の通常のファイルではありません');
  return real;
}

export async function readLibraryCatalog(directory:string):Promise<LibraryCatalog>{
  let raw:string;
  try{raw=await readFile(await resolveLibraryFile(directory,'catalog.json','assetJson'),'utf8');}catch{throw new LibraryError(`素材置場が見つかりません（${directory}）`,404);}
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new LibraryError('素材置場の台帳（catalog.json）が読めません');}
  return parseLibraryCatalog(value);
}

const exists=async(directory:string,file:string,purpose:LibraryPurpose)=>resolveLibraryFile(directory,file,purpose).then(()=>true,()=>false);
export async function listLibrary(directory:string):Promise<LibraryListing>{
  let catalog:LibraryCatalog;
  try{catalog=await readLibraryCatalog(directory);}catch(error){return {ok:false,directory,reason:error instanceof Error?error.message:String(error)};}
  const missing:string[]=[];
  for(const t of catalog.templates){const pack=catalog.packs.find(p=>p.packId===t.packId)!;
    if(!(await exists(directory,t.preview,'preview'))||!(await exists(directory,pack.component,'component'))||!(await exists(directory,pack.asset,'assetJson')))missing.push(t.key);}
  for(const m of catalog.media)if(!(await exists(directory,m.file,m.kind==='image'?'image':'audio')))missing.push(m.key);
  return {ok:true,directory,catalog,missing};
}

export function findLibraryItem(catalog:LibraryCatalog,key:string):{kind:'template';item:LibraryTemplate;pack:LibraryPack}|{kind:'media';item:LibraryMedia}{
  const t=catalog.templates.find(x=>x.key===key);
  if(t)return {kind:'template',item:t,pack:catalog.packs.find(p=>p.packId===t.packId)!};
  const m=catalog.media.find(x=>x.key===key);
  if(m)return {kind:'media',item:m};
  throw new LibraryError('素材置場にその項目がありません',404);
}
