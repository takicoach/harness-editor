import {readFile} from 'node:fs/promises';
import type {SequenceAsset} from '../../core/sequence/model';
import {importSequenceAsset} from '../sequence/assets';
import {storeSequenceComponent} from '../sequence/components';
import {componentHash} from '../telopPack/identity';
import {findLibraryItem,readLibraryCatalog,resolveLibraryFile,LibraryError,type LibraryPack} from './catalog';

const CATALOG_KEYS=['source','packId','version','componentHash','animations','entries'] as const;

/** Stores the pack's component in the project and returns it with the library's catalog. The document is not touched. */
export async function libraryPackAsset(projectDirectory:string,libraryDir:string,pack:LibraryPack):Promise<SequenceAsset>{
  const bytes=await readFile(await resolveLibraryFile(libraryDir,pack.component,'component'));
  let expected:SequenceAsset;
  try{expected=JSON.parse(await readFile(await resolveLibraryFile(libraryDir,pack.asset,'assetJson'),'utf8')) as SequenceAsset;}
  catch(error){if(error instanceof LibraryError)throw error;throw new LibraryError('置場の部品の登録情報（asset.json）が読めません',409);}
  const catalog=expected?.textStyleCatalog;
  if(!catalog||CATALOG_KEYS.some(k=>catalog[k]===undefined)||catalog.packId!==pack.packId)
    throw new LibraryError('置場の部品の登録情報が不完全です（packId・version・componentHash・animations・entries が必要）',409);
  if(!Array.isArray(catalog.entries)||!Array.isArray(catalog.animations)||typeof expected.name!=='string')
    throw new LibraryError('置場の部品の登録情報の形が不正です（entries・animations は配列、name は文字列）',409);
  if(catalog.componentHash!==componentHash(bytes))
    throw new LibraryError('置場の部品と登録情報が一致しません（componentHash）。部品を作り直してください',409);
  const stored=await storeSequenceComponent(projectDirectory,bytes,expected.name||pack.name);
  if(stored.id!==expected.id||stored.fingerprint!==expected.fingerprint)throw new LibraryError('置場の部品と登録情報が一致しません。部品を作り直してください',409);
  return {...stored,name:expected.name,textStyleCatalog:structuredClone(catalog)};
}

export async function prepareLibraryItem(projectDirectory:string,libraryDir:string,key:string,signal?:AbortSignal):Promise<SequenceAsset>{
  const found=findLibraryItem(await readLibraryCatalog(libraryDir),key);
  if(found.kind==='template'){
    const asset=await libraryPackAsset(projectDirectory,libraryDir,found.pack);
    if(!asset.textStyleCatalog!.entries.some(e=>e.id===found.item.template))throw new LibraryError('このモーションは部品の一覧にありません',409);
    return asset;
  }
  const m=found.item,source=await resolveLibraryFile(libraryDir,m.file,m.kind==='image'?'image':'audio');
  // 指紋の照合は取り込み後に行うため、不一致のとき案件に未参照ファイルが残りうる（設計上許容。文書は触らない）。
  const asset=await importSequenceAsset(projectDirectory,source,m.file.split('/').pop()!,signal);
  if(asset.fingerprint!==m.fingerprint)throw new LibraryError('置場の素材の指紋が一致しません。台帳を確認してください',409);
  return asset;
}
