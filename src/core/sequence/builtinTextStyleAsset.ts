import type {SequenceAsset, SequenceDocument} from './model';
import {textComponentId} from './textStyle';

/**
 * 「いまの builtin テロップスタイル資産」。**クリップが実際に参照しているもの**を起点にする。
 * 更新後は旧 1.0.0 と新 1.1.0 が両方 `assets` に残る（複数版共存が要件）ので、
 * `find(asset => …source === 'builtin')` は配列先頭＝**旧資産**を返し続ける（Codex P1-6・事前検査 B の B9-2）。
 * その結果 ①更新済みでも `fromVersion:'1.0.0'` の plan が出続け ②もう一度 apply すると
 * `prepareNativeTextStyles` が同じバイト＝同じ id を返して `register-assets` が無変化になり、
 * `replace-text-style-asset` が MISSING_TARGET（`commands.ts:675`）で落ちる。
 * **参照中でも版を見る**（Codex P2-1）。新旧を併用していて `assets` の並びで新版が先に来る文書では、
 * 「参照中の最初の 1 件」は新版になり、旧版を参照している字幕が残っていても plan が null
 * ＝「最新です」と言ってしまう。順序は ①参照中かつ現行版でない ②参照中 ③現行版でない ④先頭。
 *
 * `src/server/telopPackUpdate.ts` と `src/server/sequence/textStyles.ts` の両方が使う。
 * 両者は互いに import し合う（telopPackUpdate → prepareNativeTextStyles、textStyles → この関数）ので、
 * 循環を作らないよう共通の下層である core に置いた。現行版は server の
 * `telopPack/identity.ts` が持つため、core から server を読まずに済むよう**引数で受ける**。
 */
export function currentBuiltinTextStyleAsset(
  document: SequenceDocument, currentVersion: string,
): SequenceAsset | undefined {
  const referenced = new Set(document.clips.flatMap(clip =>
    clip.content.kind === 'telop' ? [textComponentId(document, clip.content)] : []));
  const builtins = document.assets.filter(asset => asset.textStyleCatalog?.source === 'builtin');
  const outdated = (asset: SequenceAsset): boolean => asset.textStyleCatalog!.version !== currentVersion;
  return builtins.find(asset => referenced.has(asset.id) && outdated(asset))
    ?? builtins.find(asset => referenced.has(asset.id))
    ?? builtins.find(outdated)
    ?? builtins[0];
}
