import type {SequenceDocument} from '../../core/sequence/model';
import {textComponentId} from '../../core/sequence/textStyle';

export type TextStylePreparation='ready'|'needs-builtin'|'needs-project';

/**
 * useNativeSession.prepareTextStyles と同じ判定をここへ切り出したもの。
 * builtin カタログが無ければ 'needs-builtin'、builtin はあるが telop クリップが
 * 参照する component asset にカタログが無ければ 'needs-project'、それ以外は 'ready'。
 */
export function textStylePreparation(doc:SequenceDocument):TextStylePreparation {
  const referenced=new Set(doc.clips.flatMap(clip=>clip.content.kind==='telop'?[textComponentId(doc,clip.content)]:[]));
  if(!doc.assets.some(asset=>asset.textStyleCatalog?.source==='builtin'))return 'needs-builtin';
  if(doc.assets.some(asset=>asset.kind==='component'&&referenced.has(asset.id)&&!asset.textStyleCatalog))return 'needs-project';
  return 'ready';
}
