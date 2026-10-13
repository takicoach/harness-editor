import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {extname} from 'node:path';
import {readJsonBody} from '../readBody';
import {resolveProjectDir} from '../projectRoot';
import {registeredSequenceAssets,verifiedSequenceAssetPath} from '../sequence/assets';
import {saveToLibrary,refreshCatalogScript} from './save';
import {pipeline} from 'node:stream/promises';
import {HttpError,sendJson} from '../http';
import {contentTypeFor} from '../serveAsset';
import {parseRange} from '../serveVideo';
import {emptyLibraryCatalog,findLibraryItem,libraryDirectory,libraryNotStartedYet,listLibrary,startDefaultLibrary,readLibraryCatalog,resolveLibraryFile,LibraryError,type LibraryMediaKind} from './catalog';

const EXTRA_TYPES:Record<string,string>={'.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg'};
const typeOf=(path:string)=>EXTRA_TYPES[extname(path).toLowerCase()]??contentTypeFor(path);

const asHttp=(error:unknown):never=>{if(error instanceof LibraryError)throw new HttpError(error.status,error.message);throw error;};

async function pathFor(directory:string,key:string,part:'preview'|'media'):Promise<string>{
  const found=findLibraryItem(await readLibraryCatalog(directory),key);
  if(found.kind==='template'){
    if(part!=='preview')throw new LibraryError('モーションは見本画像だけ取得できます');
    return resolveLibraryFile(directory,found.item.preview,'preview');
  }
  const m=found.item,purpose=m.kind==='image'?'image':'audio';
  if(part==='preview'){
    if(m.preview)return resolveLibraryFile(directory,m.preview,'preview');
    if(m.kind==='image')return resolveLibraryFile(directory,m.file,'image');
    throw new LibraryError('見本画像がありません',404);
  }
  return resolveLibraryFile(directory,m.file,purpose);
}

export async function handleLibraryApi(req:IncomingMessage,res:ServerResponse,url:URL,_root:string):Promise<boolean>{
  if(url.pathname!=='/api/library'&&!url.pathname.startsWith('/api/library/'))return false;
  const directory=libraryDirectory(),method=req.method??'GET';
  if(url.pathname==='/api/library'){
    if(method!=='GET')throw new HttpError(405,'素材置場の一覧は GET のみ対応します');
    // 既定の場所でまだ始めていない置き場は空の一覧（フォルダは最初の保存で作る）。
    if(await libraryNotStartedYet(directory)){sendJson(res,200,{ok:true,directory,catalog:emptyLibraryCatalog(),missing:[]});return true;}
    const listing=await listLibrary(directory);
    if(listing.ok)await refreshCatalogScript(directory);
    sendJson(res,200,listing);return true;
  }
  if(url.pathname==='/api/library/save'){
    if(method!=='POST')throw new HttpError(405,'素材置場への保存は POST のみ対応します');
    const raw=await readJsonBody(req,16*1024);
    const body=(typeof raw==='object'&&raw!==null&&!Array.isArray(raw)?raw:{}) as Record<string,unknown>;
    const projectId=String(body.projectId??''),assetId=String(body.assetId??''),kind=String(body.kind);
    if(!projectId||!assetId||!['se','bgm','image'].includes(kind)||typeof body.name!=='string'||!body.name.trim())throw new HttpError(400,'保存の指定が不正です');
    const project=resolveProjectDir(_root,projectId),asset=(await registeredSequenceAssets(project)).find(a=>a.id===assetId);
    if(!asset||(asset.kind!=='media'&&asset.kind!=='image'))throw new HttpError(400,'置場に保存できるのは効果音・BGM・画像だけです');
    const audio=asset.streams.find(s=>s.kind==='audio');
    if(asset.kind==='image'?kind!=='image':(kind==='image'||!audio||asset.streams.some(s=>s.kind==='video')))
      throw new HttpError(400,asset.kind==='image'?'画像は「画像」としてだけ保存できます':'置場に保存できるのは音声だけの効果音・BGMと画像です（映像つきの素材は保存できません）');
    const source=await verifiedSequenceAssetPath(project,asset);
    if(await libraryNotStartedYet(directory))await startDefaultLibrary(directory);
    sendJson(res,200,await saveToLibrary(directory,{sourcePath:source,fingerprint:asset.fingerprint,kind:kind as LibraryMediaKind,name:body.name.trim(),
      desc:typeof body.desc==='string'?body.desc:'',extension:extname(asset.file),...(audio&&asset.kind==='media'?{durationSec:Number((audio.duration.num/audio.duration.den).toFixed(2))}:{})}).catch(asHttp));
    return true;
  }
  if(url.pathname==='/api/library/file'){
    if(method!=='GET')throw new HttpError(405,'素材置場のファイルは GET のみ対応します');
    const key=url.searchParams.get('key'),part=url.searchParams.get('part');
    if(!key||(part!=='preview'&&part!=='media'))throw new HttpError(400,'素材置場の項目指定が不正です');
    const path=await pathFor(directory,key,part).catch(asHttp);
    const size=(await stat(path)).size,header=req.headers.range,range=parseRange(header,size);
    if(header&&!range&&/^\s*bytes=/.test(header)){
      res.writeHead(416,{'Content-Range':`bytes */${size}`,'Cache-Control':'no-store'});res.end();return true;
    }
    res.writeHead(range?206:200,{'Content-Type':typeOf(path),'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Cache-Control':'no-store',
      'Content-Length':String(range?range.end-range.start+1:size),...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${size}`}:{})});
    if(size===0){res.end();return true;}
    // Headers are already sent: a failure (e.g. client disconnect) must not reach the caller's error handler.
    try{await pipeline(createReadStream(path,range?{start:range.start,end:range.end}:{}),res);}
    catch{if(!res.destroyed)res.destroy();}
    return true;
  }
  return false;
}
