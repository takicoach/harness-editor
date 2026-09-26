import { createHash } from 'node:crypto';

/** The editor-bundled pack. Never reuse this id for an installed pack. */
export const BUILTIN_TELOP_PACK_ID = 'harness.builtin';
/**
 * Bump on every change to the pack's **drawing**, not just to styles/. Same id + version must mean
 * the same look, so a project frozen under an older version keeps its own component bytes.
 * 1.1.0 (2026-09-19): the wrapper now applies the seven legacy animations; styles/ bytes are unchanged
 * but the same id + 1.0.0 would no longer mean the same look.
 * 描画が変わるコミットと同じコミットで上げる（この行を守らないと、Task 5 の直前と直後に凍結した
 * 2 つの案件が同じ版を名乗って違う絵を描く）。
 */
export const BUILTIN_TELOP_PACK_VERSION = '1.1.0';

/** 保存バイトから版が決められないときの値。`validate.ts:102` の書式を通るのでスキーマ変更は要らない。 */
export const UNKNOWN_TELOP_PACK_VERSION = 'unknown';

/**
 * 既知の版 → **保存済み部品バイト（footer 込み）の componentHash**。
 * `backfillTextStyleCatalog`（`textStyles.ts:96-100`）が計算できるのはこの定義だけなので、表も同じ定義で持つ
 * （事前検査 B の B9-1。カタログに載る `componentHash` は footer 無しの probe 由来で**別の値**）。
 * backfill はここと照合して版を決め、**一致しなければ最新とは推定しない**（Codex P1-6）。
 * 値は `scripts/print-builtin-pack-hash.ts` の `stored=` の実測。
 */
export const KNOWN_BUILTIN_PACK_STORED_HASHES: Readonly<Record<string, string>> = Object.freeze({
  '71b1c67bb4fe1942': '1.0.0',   // Task 3 Step 0 の採取（wrapper 配線前）
  '275c552d36516975': '1.1.0',   // T5: wrapper 配線後、entries[].animations が footer に入る前のビルド
  '0e137d513a492752': '1.1.0',   // T6: entries[].animations が footer に入ったビルド（描画は不変なので版は据え置き）
  '7b469973e3d158d1': '1.1.0',   // TP 最終バッチ: 尺 3 未満の no-op ガード（Codex P1。1.1.0 は未出荷なので版は据え置き）
});

export function builtinVersionForStoredHash(hash: string): string | null {
  return KNOWN_BUILTIN_PACK_STORED_HASHES[hash] ?? null;
}
/** Styles declared by a project's own テロップテンプレート (TEMPLATE_MAP). */
export const PROJECT_TEMPLATE_PACK_ID = 'project.template';

/** Short content digest of the compiled component. Distinguishes two builds of one version. */
export function componentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** `packId@version` — the unit the UI labels as「（版 x）」when two versions coexist.
 * Falls back to 'legacy'/'0' for pre-T0b catalogs that never carried packId/version. */
export function textStyleCatalogKey(catalog: { packId?: string; version?: string }): string {
  return `${catalog.packId ?? 'legacy'}@${catalog.version ?? '0'}`;
}
