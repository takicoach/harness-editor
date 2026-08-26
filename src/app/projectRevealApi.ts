/**
 * 保存先フォルダを OS のファイラー（macOS なら Finder）で開く。
 * 送るのは **プロジェクト id だけ**で、サーバが id から絶対パスを導出する
 * （クライアントの持つ表示用パスを開く先として送り返さない）。
 *
 * 失敗は投げる（レビュー M-5）。以前は console.warn に留めていたが、
 * 多くの失敗は 404＝フォルダを外で動かした場合で、画面に何も出ないと
 * 非エンジニアには「押したのに何も起きない＝壊れた」としか見えない。
 * 呼び出し側が理由を表示する。
 */
export async function revealProjectRequest(id: string): Promise<void> {
  const res = await fetch(`/api/project/reveal?id=${encodeURIComponent(id)}`, { method: 'POST' });
  if (res.ok) return;
  let message = `保存先を開けませんでした (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string') message = body.error;
  } catch {
    // JSON でないエラー応答はステータスのみ
  }
  throw new Error(message);
}
