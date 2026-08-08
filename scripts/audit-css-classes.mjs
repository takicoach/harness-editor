// tsx の className と styles.css の定義を突合し、未スタイルクラスを検出する監査スクリプト。
// 使い方: node scripts/audit-css-classes.mjs
// 同じロジックを src/app/cssClassAudit.test.ts がテストとして常時実行する。
import { findUnstyledGroups } from '../src/app/cssClassAudit.mjs';

const groups = findUnstyledGroups();
if (groups.length === 0) {
  console.log('OK: 完全未スタイルの className は見つかりませんでした');
} else {
  console.log(`完全未スタイルの要素 ${groups.length} 件:`);
  for (const g of groups) console.log(`  ${g.file}: "${g.classes}"`);
  process.exitCode = 1;
}
