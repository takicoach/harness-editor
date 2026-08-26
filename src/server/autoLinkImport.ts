import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { browseRoots, canCreateSymlink, type BrowseRoot } from './browsePaths';
import { probeSymlinkSupport } from './symlinkProbe';
import { findLinkTarget, type MatchOutcome } from './matchVideoSource';

/**
 * アップロード（D&D／ファイル選択）で受け取った動画を、コピーで置くか
 * 外付けの実体へのリンクで置くかを決める。
 *
 * ブラウザは選ばれたファイルの元のパスを渡さないので、「同じファイルが
 * 登録済みのブラウズルート（＝『フォルダから選ぶ』と同じ探索範囲）に在るか」を
 * サーバ側で探し、確証が取れたときだけリンクへ切り替える。
 *
 * **判断はここ 1 箇所**に閉じ、失敗（探索エラー・リンク非対応）は必ず
 * 「コピーで作成する」へ落とす。取り込みそのものをブロックしない。
 */

/** コピーになった理由。UI の説明文と調査のために持ち帰る。 */
export type CopyReason =
  | 'requested'
  | 'no-symlink-support'
  | 'search-failed'
  /** 実行段（assertBrowsablePath / createProjectLinked）で失敗し、コピーへ落ちた。 */
  | 'link-failed'
  | Extract<MatchOutcome, { matched: false }>['reason'];

export type ImportPlan =
  | { link: true; target: string; sizeBytes: number }
  | { link: false; reason: CopyReason };

export interface PlanImportDeps {
  roots?: BrowseRoot[];
  match?: typeof findLinkTarget;
  symlinkOk?: () => boolean;
  chunkBytes?: number;
}

/**
 * 取り込み方法を決める。
 * `preferCopy` はユーザーが作成モーダルで「コピーして取り込む」を選んだ場合。
 */
export function planImport(
  input: {
    root: string;
    tmpPath: string;
    videoName: string;
    preferCopy: boolean;
    /** symlink 作成可否を試す場所（既定はアップロード一時ファイルの隣＝同じボリューム）。 */
    probeDir?: string;
  },
  deps: PlanImportDeps = {},
): ImportPlan {
  if (input.preferCopy) return { link: false, reason: 'requested' };
  const probeDir = input.probeDir ?? dirname(input.tmpPath);
  const symlinkOk = deps.symlinkOk ?? (() => canCreateSymlink(() => probeSymlinkSupport(probeDir)).ok);
  if (!symlinkOk()) return { link: false, reason: 'no-symlink-support' };
  const match = deps.match ?? findLinkTarget;
  try {
    const size = statSync(input.tmpPath).size;
    const outcome = match(
      { path: input.tmpPath, name: input.videoName, sizeBytes: size },
      deps.roots ?? browseRoots(),
      // プロジェクト置き場は起点に含まれることがある（例: ~/Movies の下で運用）。
      // その配下を候補にすると「取り込み済みのコピー」を実体として指してしまう。
      { exclude: [input.root], ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }) },
    );
    if (outcome.matched) {
      return { link: true, target: outcome.target, sizeBytes: outcome.sizeBytes };
    }
    return { link: false, reason: outcome.reason };
  } catch {
    // 探索や stat の失敗で作成を止めない（コピーなら必ず作れる）。
    return { link: false, reason: 'search-failed' };
  }
}

/** コピーになった理由の説明（非エンジニア向け・UI のトーストに出す）。 */
export function describeCopyReason(reason: CopyReason): string {
  switch (reason) {
    case 'requested':
      return 'コピーして取り込みました';
    case 'no-symlink-support':
      return 'この環境ではリンクを作れないため、コピーして取り込みました';
    case 'ambiguous':
      return '同じ名前・同じ大きさの動画が複数見つかったため、取り違えを避けてコピーして取り込みました';
    case 'content-mismatch':
      return '外付けの動画と中身が一致しなかったため、コピーして取り込みました';
    case 'unreadable':
    case 'search-failed':
      return '外付けの動画を確認できなかったため、コピーして取り込みました';
    case 'search-truncated':
      // 「見つからなかった」と同じ文言にしない。実際には在るのに諦めさせてしまう。
      return 'フォルダが大きすぎて探索を途中で打ち切りました（登録フォルダを絞ると見つかることがあります）。コピーして取り込みました';
    case 'link-failed':
      return 'リンクを作れなかったため、コピーして取り込みました';
    case 'no-candidate':
    default:
      return 'コピーして取り込みました';
  }
}
