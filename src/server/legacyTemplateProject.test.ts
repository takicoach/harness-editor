import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Redirect only the helper's fixed archive reads into private corruption copies.
// No caller-supplied manifest/hash or archive path is added to the helper API.
const redirect = vi.hoisted(() => ({ original: '', private: '', separator: '' }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, ...Object.fromEntries(['readFileSync', 'readdirSync', 'lstatSync'].map(name => [name,
    (...args: unknown[]) => {
      if (redirect.private && typeof args[0] === 'string' && (args[0] === redirect.original || args[0].startsWith(redirect.original + redirect.separator))) {
        args[0] = redirect.private + args[0].slice(redirect.original.length);
      }
      return Reflect.apply(actual[name as 'readFileSync'], actual, args);
    },
  ])) };
});
import { copyLegacyTemplateProject, readLegacyTemplateSource } from '../../tests/fixtures/legacyTemplateProject';

const archive = resolve(import.meta.dirname, '../../tests/fixtures/legacy-template-launcher');
redirect.original = archive;
redirect.separator = sep;
const catalog = resolve(import.meta.dirname, '../../project-template/src');
const directories: string[] = [];
function temporary(): string { const dir = mkdtempSync(join(tmpdir(), 'legacy-template-')); directories.push(dir); return dir; }
afterEach(() => { redirect.private = ''; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function inventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else { expect(entry.isFile()).toBe(true); files[path] = readFileSync(join(root, path)).toString('base64'); }
    }
  };
  walk(''); return files;
}

it('copies every current source byte and all four original wiring files into a new nested target, without package/config', () => {
  const expected = inventory(catalog);
  for (const path of ['src/MainVideo.tsx', 'src/Root.tsx', 'src/index.ts', 'src/index.css'] as const) {
    expect(expected[path.slice(4)]).toBeUndefined();
    expected[path.slice(4)] = Buffer.from(readLegacyTemplateSource(path)).toString('base64');
  }
  const target = join(temporary(), 'nested', 'project'); copyLegacyTemplateProject(target);
  expect(inventory(join(target, 'src'))).toEqual(expected);
  expect(readdirSync(target)).toEqual(['src']);
});

it('keeps fixed provenance identity and rejects existing src without changing its contents', () => {
  const provenance = JSON.parse(readFileSync(join(archive, 'provenance.json'), 'utf8'));
  expect(provenance.sourceCommit).toBe('c11b2656785971b3cc31cf4747a827e7c6a66a4f');
  expect(provenance.files).toHaveLength(8);
  expect(provenance.files.reduce((sum: number, file: { bytes: number }) => sum + file.bytes, 0)).toBe(3435);
  const target = temporary(); mkdirSync(join(target, 'src')); writeFileSync(join(target, 'src/keep'), 'owned');
  expect(() => copyLegacyTemplateProject(target)).toThrow(/already exists/);
  expect(inventory(join(target, 'src'))).toEqual({ keep: Buffer.from('owned').toString('base64') });
});

it.each(['changed', 'missing', 'orphan', 'symlink', 'manifest'] as const)('rejects %s archive before reading even an unrelated source or creating a target', kind => {
  const dir = temporary(), privateArchive = join(dir, 'archive'); cpSync(archive, privateArchive, { recursive: true });
  // Package/config bytes are validated even though only MainVideo is requested.
  const file = join(privateArchive, 'package.json.txt');
  if (kind === 'changed') writeFileSync(file, readFileSync(file).toString() + ' ');
  if (kind === 'missing') rmSync(file);
  if (kind === 'orphan') writeFileSync(join(privateArchive, 'orphan.txt'), 'unlisted');
  if (kind === 'symlink') { rmSync(file); symlinkSync(join(archive, 'package.json.txt'), file); }
  if (kind === 'manifest') writeFileSync(join(privateArchive, 'provenance.json'), '{}');
  redirect.private = privateArchive;
  expect(() => readLegacyTemplateSource('src/MainVideo.tsx')).toThrow(/SHA mismatch|inventory|non-file/);
  const target = join(dir, 'new-target'); expect(() => copyLegacyTemplateProject(target)).toThrow();
  expect(existsSync(target)).toBe(false);
});

it('refuses a dangling destination src symlink without altering it', () => {
  const target = temporary(); symlinkSync(join(target, 'missing'), join(target, 'src'));
  expect(() => copyLegacyTemplateProject(target)).toThrow(/already exists/);
  expect(lstatSync(join(target, 'src')).isSymbolicLink()).toBe(true);
});
