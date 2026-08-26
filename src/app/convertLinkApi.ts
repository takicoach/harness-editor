/**
 * 既存プロジェクトの「リンク化で容量回収」。
 *
 * 2 段構え: まず候補を探し（link-candidate）、見つかった接続先をユーザーに見せてから
 * 実行する（convert-to-link）。**接続先パスはサーバが探索して決める**ので、
 * ここから送るのは id だけ（表示用に受け取ったパスを送り返さない）。
 */

export type LinkCandidate =
  | { matched: true; target: string; sizeBytes: number; mtimeMs: number }
  | { matched: false; reason: string; message: string };

async function post(path: string): Promise<unknown> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) {
    let message = `リンク化に失敗しました (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // JSON でないエラー応答はステータスのみ
    }
    throw new Error(message);
  }
  return await res.json();
}

/** 同一実体を探すだけ（プロジェクトには一切触れない）。 */
export async function linkCandidateRequest(id: string): Promise<LinkCandidate> {
  return (await post(`/api/project/link-candidate?id=${encodeURIComponent(id)}`)) as LinkCandidate;
}

/** コピーをゴミ箱へ退避してリンクへ置き換える（破壊的）。 */
export async function convertToLinkRequest(
  id: string,
): Promise<{ target: string; freedBytes: number; keptCopyPath?: string }> {
  return (await post(`/api/project/convert-to-link?id=${encodeURIComponent(id)}`)) as {
    target: string;
    /** 実際に回収できたバイト数。コピーを消せなかった場合は 0。 */
    freedBytes: number;
    /** コピーを消せず残ったときの場所（プロジェクトからの相対）。消せていれば undefined。 */
    keptCopyPath?: string;
  };
}
