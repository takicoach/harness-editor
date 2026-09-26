import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const archive = resolve(import.meta.dirname, 'legacy-template-launcher');
const catalog = resolve(import.meta.dirname, '../../project-template/src');
const MANIFEST_SHA256 = '486da8cf8fd03b0bea915750fdc40f8164a08cba9013eb8e332fc1a1809a5a42';
const SOURCE_FILES = ['src/MainVideo.tsx', 'src/Root.tsx', 'src/index.ts', 'src/index.css'] as const;
export type LegacyTemplateSourcePath = typeof SOURCE_FILES[number];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Closed historical input: callers cannot supply or replace its trust anchor. */
function readArchive(): Map<string, Buffer> {
  if (!lstatSync(archive).isDirectory()) throw new Error('Legacy template archive must be a real directory');
  const inventory: string[] = [];
  function walk(relative: string): void {
    for (const entry of readdirSync(join(archive, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) inventory.push(path);
      else throw new Error(`Legacy template archive contains a non-file: ${path}`);
    }
  }
  walk('');
  const raw = readFileSync(join(archive, 'provenance.json'));
  if (sha(raw) !== MANIFEST_SHA256) throw new Error('Legacy template provenance SHA mismatch');
  const manifest = JSON.parse(raw.toString('utf8')) as {
    files: Array<{ path: string; sourcePath: string; bytes: number; sha256: string }>;
  };
  const expected = [...manifest.files.map(file => file.path), 'provenance.json', 'README.md'].sort();
  if (JSON.stringify(inventory.sort()) !== JSON.stringify(expected)) throw new Error('Legacy template archive inventory mismatch');
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const bytes = readFileSync(join(archive, file.path));
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Legacy template source SHA mismatch: ${file.path}`);
    files.set(file.sourcePath.slice('project-template/'.length), bytes);
  }
  return files;
}

/** Read original legacy wiring as data, never execute the archived launcher. */
export function readLegacyTemplateSource(path: LegacyTemplateSourcePath): string {
  if (!SOURCE_FILES.includes(path)) throw new Error(`Unsupported legacy template source: ${path}`);
  return readArchive().get(path)!.toString('utf8');
}

/** Current component/data catalog + fixed legacy wiring, for private fixtures.
 * This is not a frozen whole historical project or an installable runtime.
 * Existing src is refused; no package/config or dependency install is restored. */
export function copyLegacyTemplateProject(target: string): void {
  const originals = readArchive();
  const destination = join(target, 'src');
  if (existsSync(destination) || lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error('Legacy template target/src already exists');
  }
  mkdirSync(target, { recursive: true });
  cpSync(catalog, destination, { recursive: true, force: false, errorOnExist: true });
  for (const path of SOURCE_FILES) writeFileSync(join(target, path), originals.get(path)!, { flag: 'wx' });
}
