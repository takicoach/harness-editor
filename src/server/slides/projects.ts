import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emptySlideDocument } from '../../core/slides/model';
import { HttpError } from '../http';
import { precheckProjectName } from '../projectCreationChecks';
import { SLIDES_FILE, SlidesStore } from './store';

export interface SlidesProjectSummary { id: string; name: string; status: 'ok' | 'broken'; pages: number; updatedAt: string | null }
/** .harness/slides.v1.json（または壊れて保全したファイル）があるフォルダーをスライド案件とみなす。 */
export function isSlidesProject(directory: string): boolean {
  try {
    const harness = join(directory, '.harness');
    if (!lstatSync(harness, { throwIfNoEntry: false })?.isDirectory()) return false;
    return existsSync(join(harness, SLIDES_FILE)) || readdirSync(harness).some(name => /^slides\.v1\.broken-.+\.json$/.test(name));
  } catch { return false; }
}
/** 案件ルート直下のスライド案件（ホームの「スライド」の欄）。 */
export function listSlidesProjects(root: string): SlidesProjectSummary[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const out: SlidesProjectSummary[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const directory = join(root, name);
    try { if (!statSync(directory).isDirectory() || !isSlidesProject(directory)) continue; } catch { continue; }
    try {
      const store = new SlidesStore(directory), load = store.load();
      out.push(load.kind === 'ok' ? { id: name, name, status: 'ok', pages: load.saved.document.pages.length, updatedAt: statSync(store.file).mtime.toISOString() }
        : { id: name, name, status: 'broken', pages: 0, updatedAt: null });
    } catch (error) { console.warn(`[sme] スライド "${name}" の要約に失敗（一覧から除外）:`, error); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}
/** ホームの「スライドを作る」。名前の形と重複は動画の案件と同じ規則。中身は空のスライド（ページなし）。 */
export function createSlidesProject(root: string, rawName: string): { id: string } {
  const name = precheckProjectName(root, rawName), directory = join(root, name);
  try { mkdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, `同じ名前のプロジェクトがすでにあります: ${name}`); throw error; }
  new SlidesStore(directory).save({ expectedSavedRevision: null, executionId: `create-${randomUUID()}`, document: emptySlideDocument(`slides-${randomUUID()}`) });
  return { id: name };
}
