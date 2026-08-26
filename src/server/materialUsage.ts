// src/server/materialUsage.ts
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { makeAssetKey, type AssetKey, type AssetKind } from '../shared/assetKey';

/** 使用箇所走査の読み取り上限（巨大ファイルによる DoS 防止）。 */
const MAX_USAGE_SCAN_BYTES = 2 * 1024 * 1024;

/** 走査対象データファイル → その file: が指す素材種別。 */
const USAGE_SOURCES: Array<{ rel: string; kind: AssetKind }> = [
  { rel: 'src/SoundEffects/seData.ts', kind: 'se' },
  { rel: 'src/InsertImage/insertImageData.ts', kind: 'image' },
  { rel: 'src/InsertVideo/insertVideoData.ts', kind: 'video' },
  { rel: 'src/Bgm/bgmData.ts', kind: 'bgm' },
];

export type UsageScanResult = { ok: true; count: number } | { ok: false };

/**
 * ソース中の `file: '...'` 文字列リテラルを AST で列挙する（コード実行なし）。
 * データファイルは toFrame() 等の関数呼び出しを含むため、staticModule の全値評価ではなく
 * file プロパティのリテラルだけを拾う。
 */
export function collectFileLiterals(source: string): string[] {
  const sf = ts.createSourceFile('data.ts', source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'file' &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      out.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * ディスク上のデータファイル4種から素材の使用箇所数を数える。
 * 走査失敗（読めない・サイズ上限超）は「未使用」と誤認せず ok:false を返す
 * （呼び出し側は削除を保留する — Codex レビュー P1 対応）。
 * 未保存のクライアント編集状態はここでは見えない。クライアント側の
 * collectUsedAssetKeys（app/edit/materialUsage.ts）と合算して使う。
 */
export function scanMaterialUsage(dir: string, key: AssetKey): UsageScanResult {
  let count = 0;
  for (const { rel, kind } of USAGE_SOURCES) {
    const path = join(dir, rel);
    try {
      // existsSync は「不在」も「権限が無くて確かめられない」も同じ false になるため、
      // ここでは使わない（後者を不在扱いにすると、参照している素材を「未使用」と
      // 誤判定して削除を通してしまう＝fail-safe の唯一の穴だった）。
      // 見えないファイルは ENOENT のときだけ「無い」と断定し、それ以外は保留する。
      const st = statSync(path);
      // 通常ファイル以外（ディレクトリ等）は読めないため「未使用」と誤認せず削除保留にする。
      if (!st.isFile() || st.size > MAX_USAGE_SCAN_BYTES) return { ok: false };
      for (const file of collectFileLiterals(readFileSync(path, 'utf8'))) {
        if (makeAssetKey(kind, file) === key) count += 1;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false };
    }
  }
  return { ok: true, count };
}
