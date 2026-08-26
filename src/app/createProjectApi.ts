import type { ImportOutcome } from '../shared/types';

/** 選んだ動画ファイルから新規プロジェクト名の初期値を作る（例: 2026-07-10-DJI_0688）。 */
export function defaultProjectName(fileName: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const stem = fileName.replace(/\.[^.]+$/, '').normalize('NFC').trim();
  return `${y}-${m}-${d}${stem === '' ? '' : `-${stem}`}`;
}

/**
 * 新規プロジェクトを作成する。失敗時はサーバーのエラーメッセージで throw。
 *
 * `preferCopy` はユーザーが「コピーして取り込む」を明示した場合。既定（false）では
 * サーバが登録済みフォルダから同一実体を探し、確証が取れればコピーせずリンクにする。
 * どちらになったかは応答の `imported` に入る（呼び出し側が通知に使う）。
 */
export async function createProjectRequest(
  name: string,
  file: File,
  preferCopy = false,
): Promise<{ id: string; imported?: ImportOutcome }> {
  const url =
    `/api/create-project?name=${encodeURIComponent(name)}&video=${encodeURIComponent(file.name)}` +
    (preferCopy ? '&copy=1' : '');
  const res = await fetch(url, { method: 'POST', body: file });
  if (!res.ok) {
    let message = `プロジェクトの作成に失敗しました (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // JSON でないエラー応答はステータスのみ
    }
    throw new Error(message);
  }
  return (await res.json()) as { id: string; imported?: ImportOutcome };
}
