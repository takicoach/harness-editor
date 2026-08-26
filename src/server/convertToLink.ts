import { basename, join } from 'node:path';
import { lstatSync, readFileSync, rmSync, statSync } from 'node:fs';
import { parseVideoConfigStatic } from '../core';
import { HttpError } from './http';
import { assertBrowsablePath, browseRoots, canCreateSymlink, type BrowseRoot } from './browsePaths';
import { probeSymlinkSupport } from './symlinkProbe';
import { findLinkTarget, type MatchOutcome } from './matchVideoSource';
import { linkVideoIntoPlace, projectVideoFile, readVideoLink, writeVideoLink } from './videoLink';
import { emptyTrash, moveToTrash, restoreFromTrash } from './trashStore';

/**
 * 既存の「コピー取り込み」プロジェクトを、外付け等の同一実体へのリンクへ張り替える（容量回収）。
 *
 * 取り込み時（autoLinkImport）と同じマッチングを使うが、**名前では照合できない** —
 * コピーは `public/main.mp4` にリネームされており元のファイル名を失っているため。
 * そのぶんサイズ完全一致 ＋ 先頭/末尾チャンクのハッシュ一致を必須にし、
 * 候補が複数なら変換しない（取り違えたら別の動画で編集を続けることになる）。
 *
 * 置換は「消してから作る」をしない。
 *   ① 実体一致を再検証（クライアントから候補パスを受け取らない）
 *   ② コピーを `.trash/` へ tombstone として退避（既存 trashStore を再利用）
 *   ③ symlink 作成 ＋ `.sme/videoLink.json` 記録
 *   ④ ③で失敗したら symlink を撤去してコピーを復元する
 *   ⑤ ③まで通ったら退避を**破棄**する
 * ②で消さずに退避するのは、④の復元先を必ず用意しておくため。
 * ⑤で破棄するのは、この機能が「容量を回収する」ものだから — 退避したままだと
 * 実バイトは 1 バイトも減らないのに「N GB を回収しました」と表示することになる。
 * 破棄に失敗しても巻き戻さない（リンクは既に成立している）。回収 0 として正直に返す。
 */

export interface ConvertDeps {
  roots?: BrowseRoot[];
  chunkBytes?: number;
  symlinkOk?: () => boolean;
  match?: typeof findLinkTarget;
  link?: (target: string, linkPath: string) => void;
  writeLink?: typeof writeVideoLink;
  /** 退避 tombstone の破棄（既定は emptyTrash）。テストで失敗系を作るための seam。 */
  discard?: (dir: string, entryId: string) => void;
  /** 作りかけ symlink の除去（既定は rmSync）。テストで失敗系を作るための seam。 */
  rm?: (path: string) => void;
}

interface MainVideo {
  videoFile: string;
  linkPath: string;
  relPath: string;
  sizeBytes: number;
}

/** メイン動画が「変換できるコピー実体」であることを確かめ、その情報を返す。 */
function resolveCopiedMainVideo(dir: string): MainVideo {
  const videoFile = projectVideoFile(dir);
  if (videoFile === null) {
    throw new HttpError(500, 'videoConfig.ts を読み取れませんでした');
  }
  // videoConfig.ts は人が触れるファイル。ベース名以外は join に渡さない。
  if (videoFile === '' || basename(videoFile) !== videoFile) {
    throw new HttpError(400, `不正な動画ファイル名です: ${videoFile}`);
  }
  if (readVideoLink(dir) !== null) {
    throw new HttpError(409, 'このプロジェクトはすでにリンクで取り込まれています');
  }
  const linkPath = join(dir, 'public', videoFile);
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(linkPath);
  } catch {
    throw new HttpError(404, `メイン動画が見つかりません: public/${videoFile}`);
  }
  if (st.isSymbolicLink()) {
    throw new HttpError(409, 'このプロジェクトの動画はすでにリンクです（コピー実体ではありません）');
  }
  if (!st.isFile()) {
    throw new HttpError(409, 'メイン動画が通常のファイルではありません');
  }
  return { videoFile, linkPath, relPath: join('public', videoFile), sizeBytes: st.size };
}

/**
 * このプロジェクトのコピー実体と同一のファイルが、起点配下にあるかを探す。
 * 見つからない・曖昧な場合は matched:false を返す（例外にしない）。
 */
export function findConvertCandidate(root: string, dir: string, deps: ConvertDeps = {}): MatchOutcome {
  return matchForMainVideo(root, resolveCopiedMainVideo(dir), deps);
}

/**
 * 検証済みのメイン動画情報から候補を探す。
 * 変換本体は `resolveCopiedMainVideo` を 1 回だけ呼ぶ— 2 回呼ぶと、その間に
 * 実体が差し替わった場合に「検証した対象」と「置き換える対象」が別物になり得る。
 */
function matchForMainVideo(root: string, main: MainVideo, deps: ConvertDeps): MatchOutcome {
  const match = deps.match ?? findLinkTarget;
  return match(
    { path: main.linkPath, name: null, sizeBytes: main.sizeBytes },
    deps.roots ?? browseRoots(),
    {
      // プロジェクト置き場が起点配下にあると、自分のコピーそのものが候補になる。
      exclude: [root],
      ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }),
    },
  );
}

/** 変換できなかった理由の説明（非エンジニア向け）。UI がそのまま表示する。 */
export function describeLinkMissReason(reason: Extract<MatchOutcome, { matched: false }>['reason']): string {
  switch (reason) {
    case 'ambiguous':
      return '同じ大きさ・同じ中身の動画が複数見つかったため、取り違えを避けてリンク化しませんでした';
    case 'content-mismatch':
      return '同じ大きさの動画は見つかりましたが、中身が一致しませんでした';
    case 'unreadable':
      return '動画を読み取れなかったため、リンク化できませんでした';
    case 'search-truncated':
      // 「見つからなかった」と言い切らない（実際には在るのに諦めさせない）。
      return 'フォルダが大きすぎて探索を途中で打ち切りました（登録フォルダを絞ると見つかることがあります）';
    case 'no-candidate':
    default:
      return '同じ動画が、登録済みのフォルダ（外付け・デスクトップ・ダウンロード・ムービー）に見つかりませんでした';
  }
}

/**
 * コピー実体をリンクへ張り替える。成功したら回収できた容量（バイト）を返す。
 * 対象パスは**サーバ側の探索結果のみ**を使う（クライアントから受け取らない）。
 */
export function convertProjectToLink(
  root: string,
  dir: string,
  deps: ConvertDeps = {},
): { target: string; freedBytes: number; keptCopyPath?: string } {
  const main = resolveCopiedMainVideo(dir);
  const outcome = matchForMainVideo(root, main, deps);
  if (!outcome.matched) {
    throw new HttpError(409, describeLinkMissReason(outcome.reason));
  }
  // 探索結果でも取り込みの入口の封じ込め（起点配下のみ・realpath 解決）を必ず通す。
  const target = assertBrowsablePath(outcome.target, deps.roots ?? browseRoots());

  const symlinkOk =
    deps.symlinkOk ?? (() => canCreateSymlink(() => probeSymlinkSupport(join(dir, '.sme'))).ok);
  if (!symlinkOk()) {
    throw new HttpError(400, 'この環境ではリンクを作れないため、リンク化できません');
  }

  // videoConfig.ts の値をそのまま記録に使う。実体はバイト単位で同一だと確認済みなので、
  // ffprobe を掛け直しても同じ値になる（19GB 級の素材で無駄な解析を走らせない）。
  const vc = parseVideoConfigStatic(readFileSync(join(dir, 'src', 'videoConfig.ts'), 'utf8'));

  const link = deps.link ?? ((t: string, p: string) => linkVideoIntoPlace(t, p));
  const writeLink = deps.writeLink ?? writeVideoLink;

  // コピーは直接削除しない。復元先を用意したまま置換する。
  // 退避〜symlink〜記録の間、`public/main.*` は一瞬だけ存在しない。この区間は
  // **同期 API だけで組む**（間に await を入れない）。await を挟むと Node が他の
  // ハンドラを走らせ、動画配信・書き出し・一覧走査がその瞬間に「動画が無い」を見る。
  const entry = moveToTrash(dir, main.relPath, 'video');
  try {
    link(target, main.linkPath);
    const st = statSync(main.linkPath);
    writeLink(dir, {
      target,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      width: vc.resolution.width,
      height: vc.resolution.height,
      fps: vc.fps,
    });
  } catch (err) {
    // 作りかけの symlink を消してからコピーを戻す（戻し先が塞がっていると
    // uniqueRestoreName が main-2.mp4 を作り、videoConfig と食い違う）。
    const rm = deps.rm ?? ((p: string) => rmSync(p, { force: true }));
    let linkRemains = false;
    try {
      if (lstatSync(main.linkPath).isSymbolicLink()) rm(main.linkPath);
    } catch (rmErr) {
      // lstat が落ちた＝そこには何も無い（＝復元へ進んでよい）。rm が落ちた場合だけ
      // symlink が残る。両者を取り違えないよう、実物をもう一度見て判定する。
      try {
        linkRemains = lstatSync(main.linkPath).isSymbolicLink();
      } catch {
        linkRemains = false;
      }
      if (linkRemains) {
        // 復元すると main-2.mp4 が生まれて videoConfig と食い違う。戻さずに
        // 「今どういう状態か」を必ず伝える。黙って復元する方が危ない。
        throw new HttpError(
          500,
          `リンク化に失敗し、public/${main.videoFile} が中途半端なリンクのまま残りました。` +
            `元の動画は ${join('.trash', entry.id, entry.name)} にあります` +
            `（${(err as Error).message} / ${(rmErr as Error).message}）`,
        );
      }
    }
    try {
      restoreFromTrash(dir, entry.id);
    } catch (restoreErr) {
      // 復元まで失敗した場合、動画は .trash の中に残っている。場所を必ず伝える。
      throw new HttpError(
        500,
        `リンク化に失敗し、元の動画の復元にも失敗しました。動画は ${join('.trash', entry.id, entry.name)} にあります（${(restoreErr as Error).message}）`,
      );
    }
    throw new HttpError(500, `リンク化に失敗しました（${(err as Error).message}）`);
  }
  // ここから先は巻き戻さない（リンクは成立済み・復元先はもう塞がっている）。
  // 退避を破棄して初めて容量が戻る。失敗しても操作は成功として返し、
  // 「回収できていない」ことと残骸の場所を呼び出し側へ持ち帰る。
  const discard = deps.discard ?? ((d: string, id: string) => { emptyTrash(d, id); });
  try {
    discard(dir, entry.id);
  } catch (e) {
    const keptCopyPath = join('.trash', entry.id, entry.name);
    console.warn(`[sme] リンク化後のコピー破棄に失敗しました: ${join(dir, keptCopyPath)}`, e);
    return { target, freedBytes: 0, keptCopyPath };
  }
  return { target, freedBytes: main.sizeBytes };
}
