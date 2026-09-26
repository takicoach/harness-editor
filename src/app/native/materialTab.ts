import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';

export type MaterialTab = 'video' | 'image' | 'bgm' | 'se' | 'lut';
export type MaterialListTab = Exclude<MaterialTab, 'lut'>;
export const MATERIAL_LIST_TABS: readonly MaterialListTab[] = ['video', 'image', 'bgm', 'se'];
export const MATERIAL_TAB_LABELS: Record<MaterialListTab, string> = {video: '動画', image: '画像', bgm: 'BGM', se: '効果音'};
export const MATERIAL_TAB_EMPTY: Record<MaterialListTab, string> = {
  video: '動画の素材がありません。「素材を追加」で読み込みます。',
  image: '画像がありません。「素材を追加」で読み込みます。',
  bgm: 'BGM がありません。「＋ BGM を追加」で読み込みます。',
  se: '効果音がありません。「＋ 効果音を追加」で読み込みます。',
};

/**
 * 素材がどのタブに入るか。**上から順に確定**し、訂正 UI は置かない（P2-12）。
 * 規則 6 が既存データ（role 記録のない効果音）を救うので、誤分類は「未使用かつ記録なし」だけに限られる。
 */
export function materialTabOf(doc: SequenceDocument, asset: SequenceAsset): MaterialTab {
  if (asset.kind === 'lut') return 'lut';
  if (asset.kind === 'image') return 'image';
  if (asset.streams.some(stream => stream.kind === 'video')) return 'video';
  if (asset.origin?.kind === 'audio-fix') return 'video';
  if (asset.origin?.kind === 'import') return asset.origin.role === 'effect' ? 'se' : 'bgm';
  const used = doc.clips.find(clip => clip.content.kind === 'audio' && clip.content.assetId === asset.id);
  if (used?.content.kind === 'audio') return used.content.role === 'effect' ? 'se' : used.content.role === 'music' ? 'bgm' : 'video';
  return asset.file.startsWith('public/se/') ? 'se' : 'bgm';
}

/** タブ名＋件数（0 でも出す）。`NativeSegmented` の items にそのまま渡す。 */
export function materialTabItems(doc: SequenceDocument, assets: readonly SequenceAsset[]): {value: MaterialListTab; label: string}[] {
  return MATERIAL_LIST_TABS.map(value => ({value, label: `${MATERIAL_TAB_LABELS[value]} ${assets.filter(asset => materialTabOf(doc, asset) === value).length}`}));
}
