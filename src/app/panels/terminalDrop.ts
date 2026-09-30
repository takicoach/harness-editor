/**
 * AI ターミナルへのファイルのドロップ。macOS のターミナルアプリと同じく、落としたファイルの
 * パスを端末へ入力する（claude は貼り付けられた画像パスを添付画像として取り込む）。
 * デスクトップ版は実パスを使い、実パスを取れないブラウザ版は中身をサーバーの一時フォルダへ
 * 送ってそのパスを使う。
 */
import { desktopFilePath } from '../native/fileReference';

export function hasDroppedFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types ?? []).includes('Files') || transfer.files.length > 0;
}

/**
 * 1 つのパスを端末の 1 語として書く。POSIX はターミナルアプリと同じバックスラッシュ逃がし、
 * Windows のパスは空白などを含む時だけ二重引用符で囲む。
 * 改行などの制御文字を含むパスは、貼った瞬間に命令として送られるため受け付けない。
 */
export function terminalPathWord(path: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('改行などを含む名前のファイルは渡せません');
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(path)) return /[\s&()^;,=!'"%]/.test(path) ? `"${path}"` : path;
  return path.replace(/([ !"#$&'()*,;<>?[\\\]^`{|}~])/g, '\\$1');
}

/** 端末へ入力する文字列。ターミナルアプリと同じく末尾に空白を 1 つ付ける。 */
export function terminalDropText(paths: readonly string[]): string {
  return paths.map(terminalPathWord).join(' ') + ' ';
}

/** ブラウザ版: 中身をサーバーの一時フォルダへ送り、保存先の絶対パスを受け取る。 */
export async function uploadTerminalAttachment(file: File, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/pty/attachment?${new URLSearchParams({ name: file.name })}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, signal,
  });
  const body = await response.json().catch(() => null) as { path?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.path !== 'string') {
    throw new Error(typeof body?.error === 'string' ? body.error : `ファイルを渡せませんでした（${response.status}）`);
  }
  return body.path;
}

/** 落とされた順に、各ファイルの端末で使えるパスを返す。 */
export async function dropPaths(
  files: readonly File[],
  upload: (file: File) => Promise<string> = uploadTerminalAttachment,
  localPath: (file: File) => string = desktopFilePath,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) paths.push(localPath(file) || await upload(file));
  return paths;
}
