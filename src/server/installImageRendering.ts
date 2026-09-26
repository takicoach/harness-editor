import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { writeFilesAtomic, type AtomicWrite } from './writeFileAtomic';

const PAYLOAD = join(import.meta.dirname, '../../project-template/src/InsertImage');
const LEGACY: Record<string, readonly string[]> = {
  'InsertImage.tsx': [
    'd0eea57417954f5007850d8b5d5970a3a9820e81128bc750f38b77cae448d983',
    '44c9083c5a77f1556227844bc53eb9703733d9cc02b1fc9cd89214d1af7315ed',
    '4d441bfc12f68807a1ab15cbc1737ec28ccc0289840810d11eaf506e23b1ba97',
    // V3 standard body, before the explicit native frame-runtime specifier.
    '19ec4a212f940f0ca048d0d2a3169d884ea102a27c47a5f1a0b00e6a5dfb2b5f',
  ],
  'types.ts': ['745b5999c0ff8ec4d28953c4991059e74f0d79fb01883d6939937aa386b29256'],
};
// Dependencies first and the entry last: a partial install never exposes an
// entry that imports a missing helper. Expanded types remain legacy-compatible.
const FILES = ['imageMotion.ts', 'elementAnim.ts', 'types.ts', 'InsertImage.tsx'] as const;
const hash = (source: string) => createHash('sha256').update(source).digest('hex');

export interface ImageRenderingSupport { supported: boolean; canUpgrade: boolean }

function inspect(dir: string) {
  const parent = join(dir, 'src/InsertImage');
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink() || lstatSync(join(dir, 'src')).isSymbolicLink()) return null;
  return FILES.map(name => {
    const path = join(parent, name);
    const desired = readFileSync(join(PAYLOAD, name), 'utf8');
    const stat = lstatSync(path, { throwIfNoEntry: false });
    const safeFile = !stat || (stat.isFile() && !stat.isSymbolicLink());
    const current = stat && safeFile ? readFileSync(path, 'utf8') : null;
    const matches = safeFile && current === desired;
    const upgradeable = matches || (safeFile && (!(name in LEGACY)
      ? !stat : current !== null && LEGACY[name]!.includes(hash(current))));
    return { name, path, desired, current, matches, upgradeable };
  });
}

export function detectImageRenderingSupport(dir: string): ImageRenderingSupport {
  const files = inspect(dir);
  return { supported: !!files?.every(f => f.matches), canUpgrade: !!files?.every(f => f.upgradeable) };
}

export function installImageRendering(dir: string, write: (files: readonly AtomicWrite[]) => void = writeFilesAtomic) {
  const files = inspect(dir);
  if (!files || !files.every(f => f.upgradeable)) {
    throw new HttpError(409, 'この案件の画像表示には独自の変更があるため、自動更新できません。既存の表示は保持されています。');
  }
  const changed = files.filter(f => !f.matches);
  if (!changed.length) return { installed: true, changed: false };
  const backup = mkdtempSync(join(dir, '.harness-image-backup-'));
  for (const f of changed) if (f.current !== null) writeFileSync(join(backup, f.name), f.current, { flag: 'wx' });
  write(changed.map(f => ({ path: f.path, source: f.desired })));
  return { installed: true, changed: true };
}
