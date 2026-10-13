// src/server/sequence/sourceCheck.ts
import {realpath} from 'node:fs/promises';

/**
 * resolvedSource: 呼び出し側が受付時に実パスへ解決し、許可された場所かを確かめた素材。読む前と読んだ後に、今もそれ自身の実パスかを確かめ直す
 * （受付から準備までの間に途中のフォルダをリンクへ差し替えて、許可されていない場所を読ませない）。指定しない呼び出しは今のまま。
 */
export interface ImportSourceOptions {resolvedSource?:boolean}
export const SOURCE_MOVED_MESSAGE='素材の場所が受け付けた時から変わりました。もう一度追加してください';
export async function assertStillResolved(sourcePath:string,options?:ImportSourceOptions):Promise<void>{
  if(options?.resolvedSource&&await realpath(sourcePath).catch(()=>null)!==sourcePath)throw new Error(SOURCE_MOVED_MESSAGE);
}
