import type { SequenceAsset, SequenceDocument } from './model';

export type AssetReferencePlace =
  | 'clip-content' | 'clip-anchor' | 'clip-lut' | 'clip-witness'
  | 'transcript' | 'rendering' | 'cut-archive' | 'speed-basis' | 'audio-fix-origin'
  // 移行した文書: 旧テロップ・画像の部品が旧素材を名前（rendering.staticFiles の名前）で読んでいる／移行元の主映像（legacy.primaryAssetId）。
  | 'legacy-static-file' | 'legacy-primary';
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
  for (const use of legacyStaticFileUses(doc, assetId))
    found.push({ place: 'legacy-static-file', clipId: use.clip.id, detail: `${use.clip.name}（旧テロップ・画像の部品が「${use.name}」を名前で読んでいます）` });
  if (doc.legacy?.primaryAssetId === assetId) found.push({ place: 'legacy-primary', detail: '移行元の主映像' });
  // C3: 補正済み素材の由来（origin.from）も参照。数えないと、ノイズ除去→正規化の
  // 連鎖で中間の素材が外せてしまい、原本探索が途切れて「戻す」操作ごと消える。
  for (const asset of doc.assets) if (asset.origin?.kind === 'audio-fix' && asset.origin.from === assetId)
    found.push({ place: 'audio-fix-origin', detail: `${asset.name}（音声補正の元）` });
  return found;
}

/** 移行した文書の旧素材の名前の対応表（rendering.staticFiles）で、この素材を指す名前（「se/beep.mp3」など）。 */
export function legacyStaticFileNames(doc: SequenceDocument, assetId: string): string[] {
  return Object.entries(doc.rendering?.staticFiles ?? {}).filter(([, id]) => id === assetId).map(([name]) => name);
}

/** クリップの content（部品の props を含む）の文字列をまとめたもの。文書ごとに 1 回だけ作る（素材の行ごとに走査し直さない）。 */
const contentTexts = new WeakMap<SequenceDocument, Array<{ clip: SequenceDocument['clips'][number]; text: string }>>();
function clipContentTexts(doc: SequenceDocument): Array<{ clip: SequenceDocument['clips'][number]; text: string }> {
  let cached = contentTexts.get(doc);
  if (!cached) {
    const strings = (value: unknown, out: string[]): string[] => {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) for (const item of value) strings(item, out);
      else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
      return out;
    };
    const clips = [...doc.clips, ...(doc.cutArchive?.entries.flatMap(entry => entry.clips) ?? [])];
    // 区切りは NUL（名前に現れない）。別々の文字列をつないで偶然名前に見える一致を作らない。
    cached = clips.map(clip => ({ clip, text: strings(clip.content, []).join('\u0000') }));
    contentTexts.set(doc, cached);
  }
  return cached;
}

/**
 * 旧テロップ・画像の部品がこの素材を名前で読んでいるクリップ（カットで退避したクリップも含む。戻すと部品がまた読むため）。
 * 判定は保守的に、content の文字列にその名前（images/x.png）か末尾の名前（x.png）が現れれば「読んでいる」とする。
 * 部品は staticFile(名前) で対応表を引くので、項目を外すとその部品の描画が「保存されていない部品素材です」で止まる。
 */
export function legacyStaticFileUses(doc: SequenceDocument, assetId: string): Array<{ clip: SequenceDocument['clips'][number]; name: string }> {
  const names = legacyStaticFileNames(doc, assetId);
  if (!names.length) return [];
  const uses: Array<{ clip: SequenceDocument['clips'][number]; name: string }> = [];
  for (const { clip, text } of clipContentTexts(doc)) {
    const name = names.find(item => text.includes(item) || text.includes(item.split('/').at(-1)!));
    if (name !== undefined) uses.push({ clip, name });
  }
  return uses;
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
