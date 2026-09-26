import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { build, type Loader } from 'esbuild';
import ts from 'typescript';
import { AUDITED_API } from '../../captureRuntime/auditImports';
import type { SequenceAsset } from '../../core/sequence/model';
import { managedAssetPath } from './media';

export const NATIVE_FRAME_MODULE = '@harness/frame-runtime';
/** The only bare specifiers a frozen component may keep; everything else must live in the folder. */
export const SHARED_COMPONENT_MODULES: ReadonlySet<string> = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', NATIVE_FRAME_MODULE]);
const shared = SHARED_COMPONENT_MODULES;
const hash = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** Reject dynamic dependencies: a saved component must be independent of old source files. */
function auditSource(path: string, source: string): void {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
      throw new Error(`${path}: 動的な部品読み込みは移行できません`);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      throw new Error(`${path}: require形式の部品読み込みは移行できません`);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && (node.moduleSpecifier.text === 'remotion' || node.moduleSpecifier.text === NATIVE_FRAME_MODULE)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly && (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)))
        throw new Error(`${path}: フレームAPIは対応済みの名前付きimportが必要です`);
      if (!clause?.isTypeOnly && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (!item.isTypeOnly && !AUDITED_API.includes(name)) throw new Error(`${path}: 未対応のフレームAPIです: ${name}`);
        }
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && (node.moduleSpecifier.text === 'remotion' || node.moduleSpecifier.text === NATIVE_FRAME_MODULE)) {
      if (node.exportClause && ts.isNamespaceExport(node.exportClause)) throw new Error(`${path}: フレームAPIの名前空間exportは移行できません`);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const item of node.exportClause.elements) {
        const name = (item.propertyName ?? item.name).text;
        if (!item.isTypeOnly && !AUDITED_API.includes(name)) throw new Error(`${path}: 未対応のフレームAPIです: ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/** Compile an audited local source tree without writing into that tree.
 * staticFileBase binds live swatch assets locally; saved components use the default runtime resolver. */
export async function compileSequenceComponent(sourceDirectory:string,entryFile:string,exportName:'Telop'|'InsertImage',footer='',staticFileBase?:string):Promise<Uint8Array> {
  const root = await realpath(sourceDirectory), entry = await managedAssetPath(root, entryFile);
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true,
    format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', logLevel: 'silent',footer:{js:footer},
    plugins: [{ name: 'freeze-sequence-component', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.namespace !== 'native-frame-api' && (args.path === 'remotion' || (args.path === NATIVE_FRAME_MODULE && staticFileBase !== undefined))) return { path: 'frame-api', namespace: 'native-frame-api' };
        if (shared.has(args.path)) return { path: args.path, external: true };
        if (args.kind === 'entry-point' || args.path.startsWith('.') || isAbsolute(args.path)) return undefined;
        return { errors: [{ text: `未対応の部品依存です: ${args.path}。旧部品を変更せず移行を中止しました` }] };
      });
      // A real module with a fixed export surface lets esbuild validate indirect
      // imports/re-exports too, without loading any Remotion package.
      builder.onLoad({ filter: /.*/, namespace: 'native-frame-api' }, () => ({
        contents: staticFileBase === undefined ? `export { ${AUDITED_API.join(', ')} } from '${NATIVE_FRAME_MODULE}';`
          : `export { ${AUDITED_API.filter(name => name !== 'staticFile').join(', ')} } from '${NATIVE_FRAME_MODULE}';
export function staticFile(path) { return ${JSON.stringify(staticFileBase)} + encodeURIComponent(path.replace(/^\\/+/, '')); }`, loader: 'js',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
        const local = relative(root, args.path).split('\\').join('/');
        if (isAbsolute(local) || local === '..' || local.startsWith('../')) throw new Error('プロジェクト外の部品は読み込めません');
        const path = await managedAssetPath(root, local);
        const extension = extname(path).slice(1);
        const loader = ({ ts: 'ts', tsx: 'tsx', js: 'jsx', jsx: 'jsx', mjs: 'js', json: 'json' } as Record<string, Loader>)[extension];
        if (!loader) throw new Error(`未対応の部品ファイルです: ${relative(root, path)}`);
        const contents = await readFile(path, 'utf8');
        if (loader !== 'json') auditSource(path, contents);
        return { contents, loader, resolveDir: dirname(path) };
      });
    } }],
  });
  if (result.warnings.length) throw new Error(`部品の変換を確定できません: ${result.warnings.map(w => w.text).join('\n')}`);
  const output = result.outputFiles[0], metadata = Object.values(result.metafile.outputs)[0];
  if (!output || !metadata?.exports.includes(exportName)) throw new Error(`部品に ${exportName} export がありません`);
  if (metadata.imports.some(item => !shared.has(item.path))) throw new Error('保存した部品に未固定の依存が残っています');
  return output.contents;
}

/** Compiles legacy local TSX once; the result imports only React and our frame API. */
export async function freezeSequenceComponent(projectDirectory: string, entryFile: string, exportName: 'Telop' | 'InsertImage'): Promise<SequenceAsset> {
  return storeSequenceComponent(projectDirectory,await compileSequenceComponent(projectDirectory,entryFile,exportName),exportName);
}

/** Publish immutable component bytes in the target project's managed storage. */
export async function storeSequenceComponent(projectDirectory:string,contents:Uint8Array,name:string):Promise<SequenceAsset> {
  const root=await realpath(projectDirectory),fingerprint = hash(contents), file = `.harness/components/${fingerprint}.mjs`;
  let directory = root;
  for (const segment of ['.harness', 'components']) {
    directory = join(directory, segment);
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('部品の保存先が不正です');
  }
  const temporary = join(directory, `${randomUUID()}.tmp`), destination = join(root, file);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents); await handle.sync(); await handle.close();
    try { await link(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const asset: SequenceAsset = { id: `component-${fingerprint.slice(0, 24)}`, kind: 'component', name, file, fingerprint, streams: [] };
    await readSequenceComponent(root, asset);
    if (process.platform !== 'win32') { const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
    return asset;
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}

/** Never recompiles legacy sources: changed/missing saved bytes are an explicit error. */
export async function readSequenceComponent(projectDirectory: string, asset: SequenceAsset): Promise<string> {
  if (asset.kind !== 'component' || !/^[a-f0-9]{64}$/.test(asset.fingerprint)) throw new Error('描画部品の素材参照が不正です');
  const path = await managedAssetPath(projectDirectory, asset.file);
  const info = await lstat(join(projectDirectory, asset.file));
  if (info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('保存した描画部品が不正です');
  const data = await readFile(path);
  if (hash(data) !== asset.fingerprint) throw new Error('保存した描画部品が変更されています。旧ファイルへは切り替えません');
  return data.toString('utf8');
}
