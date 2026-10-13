import {isDeepStrictEqual} from 'node:util';
import type {SequenceAsset} from '../../core/sequence/model';
import type {SequenceCommand} from '../../core/sequence/commands';
import {HttpError} from '../http';
import {registeredSequenceAssets,verifiedSequenceAssetPath} from '../sequence/assets';
import {readSequenceComponent} from '../sequence/components';
import {editRequest} from '../sequence/editRequest';
import type {SequenceService} from '../sequence/service';
import {findLibraryItem,readLibraryCatalog,LibraryError} from './catalog';
import {libraryPackAsset} from './prepare';

const ALLOWED=new Set(['add-track','insert']);
const CATALOG_KEYS=['packId','version','componentHash','animations','entries'] as const;
const bad=(message:string)=>new HttpError(400,message);

/**
 * Registers the chosen library items and runs the caller's add-track / insert commands as ONE batch,
 * so one undo removes both the placement and the registration.
 * Assets already in the document are NOT filtered out: register-assets accepts an identical asset as a
 * no-op, and keeping the request deterministic is what lets a repeated executionId replay instead of conflicting.
 */
export async function placeLibraryItems(directory:string,libraryDir:string,sessions:SequenceService,body:Record<string,unknown>,signal?:AbortSignal){
  const {sessionId,expectedRevision,executionId,keys,commands}=body;
  if(typeof sessionId!=='string'||!sessionId||!Number.isSafeInteger(expectedRevision)||typeof executionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionId))
    throw bad('配置の要求が不正です');
  if(!Array.isArray(keys)||!keys.length||keys.length>5||keys.some(k=>typeof k!=='string'||!k||k.length>200))throw bad('配置する項目が不正です');
  if(!Array.isArray(commands)||!commands.length||commands.length>10
    ||commands.some(c=>!c||typeof c!=='object'||!ALLOWED.has(String((c as {type?:unknown}).type))))
    throw bad('配置で使える操作は段の追加と配置だけです');
  // 既存の /command と同じ形の検証（形の壊れた操作は 500 ではなく 400 にする）
  // expectedRevision:0・sessionId は形だけを検証するためのダミー値。版と session は sessions.execute が別に確かめる。
  for(const command of commands)editRequest({sessionId:'x',executionId:'x',expectedRevision:0,command});
  try{
    const catalog=await readLibraryCatalog(libraryDir);
    const current=sessions.open(directory),registry=await registeredSequenceAssets(directory),assets:SequenceAsset[]=[];
    for(const key of keys as string[]){
      const found=findLibraryItem(catalog,key);
      let asset:SequenceAsset;
      if(found.kind==='template'){
        asset=await libraryPackAsset(directory,libraryDir,found.pack);
        if(!asset.textStyleCatalog!.entries.some(e=>e.id===found.item.template))throw new LibraryError('このモーションは部品の一覧にありません',409);
        await readSequenceComponent(directory,asset);
        const existing=current.document.assets.find(a=>a.id===asset.id);
        if(existing){
          const have=existing.textStyleCatalog,want=asset.textStyleCatalog!;
          if(!have||CATALOG_KEYS.some(k=>!isDeepStrictEqual(have[k],want[k])))
            throw new LibraryError('同じ部品が別の一覧で登録済みです。置場の部品を確認してください',409);
        }
      }else{
        const found2=registry.find(a=>a.fingerprint===found.item.fingerprint&&a.kind!=='component');
        if(!found2)throw new LibraryError('置場の素材がまだ取り込まれていません。取り込みからやり直してください',409);
        asset=found2;
        await verifiedSequenceAssetPath(directory,asset,signal);
      }
      if(!assets.some(a=>a.id===asset.id))assets.push(asset);
    }
    return sessions.execute(directory,{sessionId,expectedRevision:expectedRevision as number,executionId,
      command:{type:'batch',commands:[{type:'register-assets',assets},...(commands as SequenceCommand[])]}});
  }catch(error){if(error instanceof LibraryError)throw new HttpError(error.status,error.message);throw error;}
}
