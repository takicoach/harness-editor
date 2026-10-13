import type { SequenceAsset, SequenceDocument } from './model';

export type AssetReferencePlace =
  | 'clip-content' | 'clip-anchor' | 'clip-lut' | 'clip-witness'
  | 'transcript' | 'rendering' | 'cut-archive' | 'speed-basis' | 'audio-fix-origin';
export interface AssetReference { place: AssetReferencePlace; clipId?: string; detail: string }

/** Every structural place an asset id can appear. A removal is safe only when this is empty. */
export function sequenceAssetReferences(doc: SequenceDocument, assetId: string): AssetReference[] {
  const found: AssetReference[] = [];
  const scan = (clips: readonly SequenceDocument['clips'][number][], place: AssetReferencePlace, where: string): void => {
    for (const clip of clips) {
      const content = clip.content;
      if ((content.kind === 'video' || content.kind === 'audio' || content.kind === 'image') && content.assetId === assetId)
        found.push({ place, clipId: clip.id, detail: `${where}${clip.name}` });
      if (content.kind === 'telop' && content.componentAssetId === assetId)
        found.push({ place, clipId: clip.id, detail: `${where}${clip.name}（文字の描画部品）` });
      if (clip.anchor?.kind === 'source' && clip.anchor.sourceAssetId === assetId)
        found.push({ place: place === 'clip-content' ? 'clip-anchor' : place, clipId: clip.id, detail: `${where}${clip.name}（使用箇所）` });
      if (clip.visual?.lut?.assetId === assetId)
        found.push({ place: place === 'clip-content' ? 'clip-lut' : place, clipId: clip.id, detail: `${where}${clip.name}（LUT）` });
      for (const witness of [...(clip.legacyMainRole?.witnesses ?? []), ...(clip.legacyCaptionContinuity?.witnesses ?? [])])
        if (witness.assetId === assetId) found.push({ place: 'clip-witness', clipId: clip.id, detail: `${where}${clip.name}（旧編集の証拠）` });
    }
  };
  scan(doc.clips, 'clip-content', '');
  for (const transcript of doc.transcripts)
    if (transcript.assetId === assetId) found.push({ place: 'transcript', detail: `文字起こし（ストリーム ${transcript.streamIndex}）` });
  if (doc.rendering?.telopComponentAssetId === assetId) found.push({ place: 'rendering', detail: '文字の描画部品（案件既定）' });
  if (doc.rendering?.imageComponentAssetId === assetId) found.push({ place: 'rendering', detail: '画像の描画部品（案件既定）' });
  for (const entry of doc.cutArchive?.entries ?? []) {
    scan(entry.clips, 'cut-archive', `カット履歴 ${entry.id}: `);
    for (const source of entry.sourceRecovery?.sources ?? [])
      if (source.assetId === assetId) found.push({ place: 'cut-archive', detail: `カット履歴 ${entry.id}（復元元）` });
  }
  for (const clip of doc.clips) if (clip.speed?.source.assetId === assetId)
    found.push({ place: 'speed-basis', clipId: clip.id, detail: `${clip.name}（速度の基準）` });
  for (const clip of doc.clips) if (clip.insertOwnSpeed?.source.assetId === assetId)
    found.push({ place: 'speed-basis', clipId: clip.id, detail: `${clip.name}（挿入の速度基準）` });
  // C3: 補正済み素材の由来（origin.from）も参照。数えないと、ノイズ除去→正規化の
  // 連鎖で中間の素材が外せてしまい、原本探索が途切れて「戻す」操作ごと消える。
  for (const asset of doc.assets) if (asset.origin?.kind === 'audio-fix' && asset.origin.from === assetId)
    found.push({ place: 'audio-fix-origin', detail: `${asset.name}（音声補正の元）` });
  return found;
}

const fixOrigin = (asset: SequenceAsset | undefined) => asset?.origin?.kind === 'audio-fix' ? asset.origin : undefined;
/** 補正の系譜（origin.from）を原本までたどる。循環・自己参照で回り続けない（その時と系譜が途切れた時は、たどり始めた素材を返す）。
 * 画面（音声補正の対象）とサーバ（学習の注記）で共有する。 */
export function audioFixRoot(doc: SequenceDocument, assetId: string): string {
  let current = doc.assets.find(asset => asset.id === assetId);
  const seen = new Set([assetId]);
  for (let origin = fixOrigin(current); origin; origin = fixOrigin(current)) {
    const from = origin.from;
    if (seen.has(from)) return assetId;
    seen.add(from);
    current = doc.assets.find(asset => asset.id === from);
  }
  return current?.id ?? assetId;
}
