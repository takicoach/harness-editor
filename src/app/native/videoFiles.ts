import {createMediaKind} from '../../shared/createMedia';
import {orderByName} from '../../shared/importOrder';
/** 動画（メインの末尾へ並べる・自然順）と、それ以外（従来の取り込み）に分ける（設計 §1 ②）。 */
export function splitVideoFiles(files:readonly File[]):{videos:File[];others:File[]}{
  return {videos:orderByName(files.filter(file=>createMediaKind(file.name)==='video'),file=>file.name),others:files.filter(file=>createMediaKind(file.name)!=='video')};
}
