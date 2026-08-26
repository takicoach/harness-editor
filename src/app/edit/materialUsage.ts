import { makeAssetKey, type AssetKey } from '../../shared/assetKey';

interface FileRef {
  file: string;
}

/** EditState / EditorProject のどちらも構造的に渡せる最小形。 */
export interface UsageSource {
  se: FileRef[];
  images: FileRef[];
  videoInserts?: FileRef[];
  bgm?: FileRef[];
}

/**
 * 現在の編集状態（未保存の参照を含む）から使用素材キー → 使用箇所数を数える。
 * サーバの静的走査（materialUsage.ts）はディスク上の保存済みデータしか見えないため、
 * 削除確認ではこの結果と合算する（Codex レビュー P1「未保存参照の見落とし」対応）。
 */
export function collectUsedAssetKeys(state: UsageSource): Map<AssetKey, number> {
  const map = new Map<AssetKey, number>();
  const add = (key: AssetKey): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const s of state.se) add(makeAssetKey('se', s.file));
  for (const i of state.images) add(makeAssetKey('image', i.file));
  for (const v of state.videoInserts ?? []) add(makeAssetKey('video', v.file));
  for (const b of state.bgm ?? []) add(makeAssetKey('bgm', b.file));
  return map;
}
