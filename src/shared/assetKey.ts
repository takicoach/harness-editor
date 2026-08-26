// src/shared/assetKey.ts
/**
 * 素材の同一性キー（Codex レビュー P1「使用中素材の未保存参照」対応）。
 * サーバ側の静的走査（materialUsage.ts）とクライアント編集状態の走査
 * （app/edit/materialUsage.ts）が同じキーで比較できるよう、正規化を一本化する:
 * - 種別（se/image/bgm/video）をキーに含める（同名別種を混同しない）
 * - バックスラッシュ → スラッシュ
 * - Unicode NFC 正規化（macOS の濁点分解 NFD 対策。uploadMaterial の保存規則と同じ）
 * - 先頭スラッシュ除去
 * サブディレクトリは保持する（image/video 素材はサブディレクトリ相対パスを持つ）。
 */
export type AssetKind = 'se' | 'image' | 'bgm' | 'video';

export type AssetKey = string;

export function makeAssetKey(kind: AssetKind, rawPath: string): AssetKey {
  const normalized = rawPath.replaceAll('\\', '/').normalize('NFC').replace(/^\/+/, '');
  return `${kind}:${normalized}`;
}
