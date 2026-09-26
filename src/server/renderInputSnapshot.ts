import { constants, lstatSync, realpathSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface RenderInputSnapshotOptions {
  projectDir: string;
  /** Complete render dependency list, relative to projectDir. The caller owns
   * dependency discovery; this helper does not infer imports or remote assets. */
  files: readonly string[];
  signal: AbortSignal;
  tempRoot?: string;
}

export class RenderInputChangedError extends Error {
  readonly code = 'RENDER_INPUT_CHANGED';
  constructor(path: string) {
    super(`書き出し準備中に入力が変更されました: ${path}`);
    this.name = 'RenderInputChangedError';
  }
}

function identity(path: string): string {
  // ctime catches same-size edits whose mtime was restored. Resolve asset links
  // and compare link identity too, so relinking during preparation cannot pass.
  const link = lstatSync(path, { bigint: true });
  const target = statSync(path, { bigint: true });
  if (!target.isFile()) throw new Error(`書き出し入力は通常ファイルである必要があります: ${path}`);
  return [realpathSync(path), link.dev, link.ino, link.size, link.mtimeNs, link.ctimeNs,
    target.dev, target.ino, target.size, target.mtimeNs, target.ctimeNs].join('|');
}

/** Materialize explicitly selected files into a job-owned directory. No hard
 * links or source symlinks survive: later saves/in-place media edits cannot change
 * the successful snapshot. A double metadata scan rejects ordinary concurrent
 * writes during capture (not a hostile-writer or remote-storage transaction).
 * Node copyFile is not atomic, so metadata validation is required even on systems
 * supporting copy-on-write. Pending copies finish before abort cleanup returns.
 */
export async function createRenderInputSnapshot(options: RenderInputSnapshotOptions): Promise<{
  projectDir: string;
  files: readonly string[];
  cleanup: () => void;
}> {
  options.signal.throwIfAborted();
  if (options.tempRoot !== undefined && !isAbsolute(options.tempRoot)) throw new Error('Render input tempRoot must be absolute');
  if (!options.files.length || options.files.length > 100_000) throw new Error('Invalid render input file count');
  const files = [...options.files];
  const seen = new Set<string>();
  for (const file of files) {
    // Canonical portable relative paths only, including on POSIX when validating
    // a Windows-origin project. Never copy node_modules through this interface.
    if (!file || isAbsolute(file) || /[\\:\0]/.test(file)
      || file.split('/').some((part) => !part || part === '.' || part === '..' || part === 'node_modules')
      || seen.has(file)) throw new Error(`Invalid render input path: ${file}`);
    seen.add(file);
  }
  const sourceRoot = realpathSync(resolve(options.projectDir));
  // Capture all identities before the first async copy. Saves by this server are
  // synchronous transactions and cannot interleave this initial scan.
  const initial = new Map(files.map((file) => [file, identity(join(sourceRoot, file))]));
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'sme-render-inputs-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    rmSync(root, { recursive: true, force: true });
    cleaned = true;
  };
  const assertUnchanged = (file: string) => {
    try {
      if (identity(join(sourceRoot, file)) === initial.get(file)) return;
    } catch { /* removed, relinked or unreadable is also a changed input */ }
    throw new RenderInputChangedError(file);
  };
  try {
    for (const file of files) {
      options.signal.throwIfAborted();
      assertUnchanged(file);
      const destination = join(root, file);
      await mkdir(dirname(destination), { recursive: true });
      options.signal.throwIfAborted();
      await copyFile(join(sourceRoot, file), destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      options.signal.throwIfAborted();
      assertUnchanged(file);
    }
    for (const file of files) assertUnchanged(file);
    options.signal.throwIfAborted();
    return { projectDir: root, files: Object.freeze(files), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
