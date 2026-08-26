// src/server/trashVideo.ts
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http';
import { isContained } from './projectRoot';
import { isTrashEntryId, listTrash, TRASH_DIR } from './trashStore';
import { projectVideoFile, readVideoLink } from './videoLink';
import { resolvePreviewVideoPath } from './previewProxy';

/**
 * ゴミ箱カードのサムネイル用に、tombstone 内のメイン動画パスを解決する。
 *
 * 封じ込めの正本はここ 1 箇所。**クライアントからはパスを一切受け取らない**
 * （entryId だけ受け取り、実パスは manifest 検証済み entry ＋ tombstone 内の
 * videoConfig.ts からサーバが導出する）。受け取れば任意のローカルファイルを
 * 配信させられる。検査は 4 段:
 *  ① entryId は UUID 形式のみ（manifest を引く前に弾く）
 *  ② entry は readManifest の検証を通ったもの（name はベース名・kind は 'project'）
 *  ③ videoConfig.ts の VIDEO_FILE もベース名のみ（設定ファイル経由のトラバーサル拒否）
 *  ④ 実体は `.trash` の外へ出ない。例外はリンク取り込み
 *     （`.sme/videoLink.json` を持ち、**記録された接続先の実体とリンク先の実体が一致する**
 *     symlink）だけで、これはホームの `/api/video` が既に同じ実体を配信している経路と同値。
 *     記録が無い／記録と食い違うリンクは配信しない（記録の「有無」だけを見ると、
 *     videoLink.json を残したままリンクを張り替えれば任意ファイルを配信できる）。
 * さらに `statSync().isFile()` で FIFO・ディレクトリを弾く。配信は軽量プレビュー
 * プロキシ（`public/<base>.preview.mp4`）があればそちらを優先し、検査は**選んだ後の
 * パス**に掛けたうえで realpath 済みのパスを返す（検査と配信で別のパスを使わない）。
 *
 * 動画が無い・リンク切れ・設定が読めない場合は 404/400 を投げる。呼び出し側（UI）は
 * サムネイルをプレースホルダへ落とすだけで、一覧・復元・完全削除には影響しない。
 */
export function resolveTrashVideoPath(root: string, entryId: string): string {
  if (!isTrashEntryId(entryId)) {
    throw new HttpError(400, `不正なゴミ箱の項目 ID です: ${entryId}`);
  }
  const entry = listTrash(root).find((e) => e.id === entryId);
  if (entry === undefined) {
    throw new HttpError(404, `ゴミ箱に見つかりません: ${entryId}`);
  }
  if (entry.kind !== 'project') {
    throw new HttpError(400, 'プロジェクト以外のゴミ箱項目にはサムネイルがありません');
  }
  const projectDir = join(root, TRASH_DIR, entry.id, entry.name);
  const videoFile = projectVideoFile(projectDir);
  if (videoFile === null) {
    throw new HttpError(404, '動画設定（videoConfig.ts）を読み取れません');
  }
  if (
    videoFile === '' ||
    videoFile.includes('/') ||
    videoFile.includes('\\') ||
    videoFile.includes('..')
  ) {
    throw new HttpError(400, `不正な動画ファイル名です: ${videoFile}`);
  }
  // 軽量プレビュープロキシ（public/<base>.preview.mp4）があれば優先する。
  // ホームの /api/video と同じ扱い。ゴミ箱は重い HEVC が溜まる画面なので条件はむしろ悪い。
  // `?v=`（版ピン）は不要 — 削除済みプロジェクトの実体はもう変化せず、配信中に
  // プロキシが生成されて実体が入れ替わる競合が起きないため。
  // **以降の検査（lstat / realpath / isFile）は選んだ後のパスに掛ける**（検査したパスと
  // 配信するパスを一致させる）。
  const videoPath = resolvePreviewVideoPath(join(projectDir, 'public'), videoFile);

  let link;
  try {
    link = lstatSync(videoPath);
  } catch {
    throw new HttpError(404, `動画ファイルが見つかりません: public/${videoFile}`);
  }
  // 検査したパスをそのまま返す（realpath 済み）。呼び出し側が join を組み直して
  // もう一度リンクを辿る TOCTOU 窓を残さない。
  let real: string;
  try {
    real = realpathSync(videoPath);
  } catch {
    throw new HttpError(404, '動画の実体が見つかりません（接続先が外れている可能性があります）');
  }
  if (link.isSymbolicLink()) {
    // 外付けからのリンク取り込みだけが symlink を持つ。記録が無ければ「誰かが置いた
    // リンク」であり、たどると .trash の外の任意ファイルを配信できてしまう。
    // **記録の「有無」だけでは足りない**: videoLink.json を残したまま
    // リンクだけ別の実体へ張り替えれば同じ抜け道になる。記録された接続先の実体と
    // リンク先の実体が一致することまで要求する。
    const record = readVideoLink(projectDir);
    if (record === null) {
      throw new HttpError(400, 'リンク記録の無いリンクは配信できません');
    }
    let realTarget: string;
    try {
      // 外付けが未接続だと、この realpath でファイルシステムの同期待ちに入り得る。
      realTarget = realpathSync(record.target);
    } catch {
      throw new HttpError(404, '動画の実体が見つかりません（接続先が外れている可能性があります）');
    }
    if (realTarget !== real) {
      throw new HttpError(400, '記録された接続先と異なるリンクは配信できません');
    }
  } else {
    // 途中のディレクトリが外を指す symlink でも脱出させない（字面の join では見抜けない）。
    let realTrash: string;
    try {
      realTrash = realpathSync(join(root, TRASH_DIR));
    } catch {
      throw new HttpError(404, `動画ファイルが見つかりません: public/${videoFile}`);
    }
    if (!isContained(real, realTrash)) {
      throw new HttpError(400, 'ゴミ箱の外を指すため配信できません');
    }
  }

  let st;
  try {
    st = statSync(real);
  } catch {
    throw new HttpError(404, '動画の実体が見つかりません（接続先が外れている可能性があります）');
  }
  if (!st.isFile()) {
    throw new HttpError(400, '通常ファイルではありません');
  }
  return real;
}
