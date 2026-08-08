/** 選んだ動画ファイルから新規プロジェクト名の初期値を作る（例: 2026-07-10-DJI_0688）。 */
export function defaultProjectName(fileName: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const stem = fileName.replace(/\.[^.]+$/, '').normalize('NFC').trim();
  return `${y}-${m}-${d}${stem === '' ? '' : `-${stem}`}`;
}

/** 新規プロジェクトを作成する。失敗時はサーバーのエラーメッセージで throw。 */
export async function createProjectRequest(name: string, file: File): Promise<{ id: string }> {
  const url = `/api/create-project?name=${encodeURIComponent(name)}&video=${encodeURIComponent(file.name)}`;
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
  return (await res.json()) as { id: string };
}
