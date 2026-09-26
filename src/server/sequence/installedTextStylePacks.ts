import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {parseInstalledTextStylePackInfo, type InstalledTextStylePackInfo} from '../../core/sequence/installedTextStylePack';
import {compileSequenceComponent, storeSequenceComponent} from './components';
import {componentHash} from '../telopPack/identity';

export interface InstalledTextStylePack extends InstalledTextStylePackInfo {
  /** Telop.tsx・manifest.json・textStylePack.json を持つフォルダ。 */
  directory: string;
}

const SERVER_DIRECTORY = resolve(import.meta.dirname, '..');

/** `src/server/<フォルダ>/textStylePack.json` を持つフォルダを追加パックとして返す（フォルダ名の順）。1 つも無ければ空。 */
export function findInstalledTextStylePacks(serverDirectory = SERVER_DIRECTORY): InstalledTextStylePack[] {
  return readdirSync(serverDirectory, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && existsSync(join(serverDirectory, entry.name, 'textStylePack.json')))
    .map(entry => entry.name).sort()
    .map(name => ({...parseInstalledTextStylePackInfo(JSON.parse(readFileSync(join(serverDirectory, name, 'textStylePack.json'), 'utf8'))),
      directory: join(serverDirectory, name)}));
}

/** 追加パックを案件へ凍結する。カタログの項目順（source→packId→version→componentHash→entries→animations）と資産名は変えない（既存案件の凍結部品の fingerprint を保つため）。 */
export async function prepareInstalledTextStylePack(projectDirectory: string, pack: InstalledTextStylePack): Promise<SequenceAsset> {
  const entries: {id: number; name: string}[] = JSON.parse(readFileSync(join(pack.directory, 'manifest.json'), 'utf8'));
  if (entries.length !== pack.count) throw new Error(`${pack.name}: manifest.json は ${entries.length} 件、textStylePack.json の count は ${pack.count}`);
  const probe = await compileSequenceComponent(pack.directory, 'Telop.tsx', 'Telop');
  const catalog: NonNullable<SequenceAsset['textStyleCatalog']> = {source: 'installed', packId: pack.packId,
    version: componentHash(probe), componentHash: componentHash(probe), entries, animations: [...pack.animations]};
  const bytes = await compileSequenceComponent(pack.directory, 'Telop.tsx', 'Telop', `export const NATIVE_TEXT_STYLE_CATALOG = ${JSON.stringify(catalog)};`);
  return {...await storeSequenceComponent(projectDirectory, bytes, pack.name), textStyleCatalog: catalog};
}
