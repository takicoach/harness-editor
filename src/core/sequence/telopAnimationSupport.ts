import type { SequenceAsset, SequenceDocument } from './model';
import { activeTextAppearance, textComponentId, type TextContent } from './textStyle';
import { TELOP_ANIMATION_IDS, type TelopAnimationId } from '../telopAnimation';

/** null は「不明」。宣言を持たない凍結部品は 9 種対応とみなさず、全種を非対応として扱う。 */
export type AnimationSupport = ReadonlySet<TelopAnimationId> | null;

const ALL: ReadonlySet<TelopAnimationId> = new Set(TELOP_ANIMATION_IDS);

const toSet = (declared: unknown): AnimationSupport =>
  Array.isArray(declared) ? new Set(declared.filter((id): id is TelopAnimationId => ALL.has(id as TelopAnimationId))) : null;

/**
 * `styleId` を渡すと、そのスタイル固有の宣言（`entries[].animations`）を優先する。
 * 宣言が無いエントリ・一覧に無い番号は**カタログ単位へフォールバック**する（旧文書の互換。推定しない）。
 */
export function assetAnimationSupport(asset: SequenceAsset | undefined, styleId?: number): AnimationSupport {
  const catalog = asset?.textStyleCatalog;
  if (styleId !== undefined) {
    const entry = catalog?.entries.find(item => item.id === styleId);
    if (entry?.animations !== undefined) return toSet(entry.animations);
  }
  return toSet(catalog?.animations);
}

/** 自由な書式は NativeText（リポジトリ内の実装）が描くので宣言が要らない＝常に 17 種。 */
export function textAnimationSupport(document: SequenceDocument, content: TextContent): AnimationSupport {
  if (activeTextAppearance(content)) return ALL;
  const assetId = textComponentId(document, content);
  const asset = document.assets.find(item => item.id === assetId);
  return assetAnimationSupport(asset, content.data.template ?? 1);
}

export function supportsAnimation(support: AnimationSupport, id: TelopAnimationId): boolean {
  return support !== null && support.has(id);
}

/**
 * 移る先で「動きを失う」字幕クリップの id。none・未設定は数えない。
 * `styleId` を渡すと全クリップがその 1 スタイルになる前提で数え（全体適用）、
 * 省略するとクリップごとの `data.template` で数える（部品だけの差し替え）。
 */
export function telopClipsLosingAnimation(
  document: SequenceDocument, asset: SequenceAsset | undefined, styleId?: number,
): string[] {
  return document.clips.flatMap(clip => {
    if (clip.content.kind !== 'telop') return [];
    const animation = clip.content.data.animation as TelopAnimationId | undefined;
    if (animation === undefined || animation === 'none') return [];
    const support = assetAnimationSupport(asset, styleId ?? clip.content.data.template ?? 1);
    return supportsAnimation(support, animation) ? [] : [clip.id];
  });
}
