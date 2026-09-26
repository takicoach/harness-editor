import { compileSequenceComponent } from './sequence/components';

const TELOP_DIR = 'テロップテンプレート';

/** Read-only swatch compilation through the same audited frame API as native export. */
export async function bundleNativeTelopComponent(dir: string, projectId: string): Promise<string> {
  const staticFileBase = `/api/asset?${new URLSearchParams({ id: projectId })}&path=`;
  try {
    return new TextDecoder().decode(await compileSequenceComponent(dir, `src/${TELOP_DIR}/Telop.tsx`, 'Telop', '', staticFileBase));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`スタイル見本を作成できませんでした。名前からスタイルを選択できます。\n${detail.replaceAll('旧部品を変更せず移行を中止しました', 'この見本では利用できません').replaceAll('移行できません', '見本では利用できません')}`);
  }
}
