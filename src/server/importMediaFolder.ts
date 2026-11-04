import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { HttpError } from './http';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './loadProjectFiles';
import { sanitizeProjectName } from './projectCreationChecks';
import { createEmptySequenceProject } from './sequence/create';

/**
 * 素材フォルダの取り込み（ホーム画面へのフォルダドロップ）。
 * フォルダ1つにつき作品を1つ作り、**フォルダの中身（サブフォルダ込み）を全部その作品の素材**として扱う。
 * 素材フォルダ本体は作品直下の `素材` シンボリックリンクで参照し（コピーしない）、
 * 見つけたメディアの一覧を `.sme/materials.json` に残す。
 */

/**
 * 台本の形式（Word・PDF・テキスト・Markdown・字幕）。素材フォルダに一緒に入ってくる書類。
 * 中身は読まず（docx/pdf は解析しない）、在りかを一覧に残して編集者と AI が開けるようにする。
 */
export const DOCUMENT_EXTENSIONS = ['.docx', '.pdf', '.txt', '.md', '.srt'];

/** 走査の上限。深い共有フォルダ・外付けを渡されても固まらないための保険。 */
export const MAX_SCAN_DEPTH = 5;
export const MAX_SCAN_FILES = 20000;

export interface ScannedMedia {
  /** 絶対パス */
  path: string;
  /** 走査起点からの相対パス（サブフォルダ込み） */
  relativePath: string;
  /** 起点直下が 0 */
  depth: number;
  size: number;
}

/**
 * フォルダを再帰的に走査してメディアを集める。
 * 撮影素材のフォルダは「撮影日ごと」「提出用」などサブフォルダに分かれているのが普通なので、
 * 直下だけでなく下層まで見る。ディレクトリへのシンボリックリンクは辿らない（循環防止）。
 */
export function scanMediaFiles(
  folder: string,
  extensions: readonly string[],
  options: { maxDepth?: number; maxFiles?: number } = {},
): ScannedMedia[] {
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH;
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const found: ScannedMedia[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // リンク先がディレクトリなら辿らない。ファイルならメディアとして扱う。
        let target: ReturnType<typeof statSync>;
        try {
          target = statSync(abs);
        } catch {
          continue;
        }
        if (target.isDirectory()) continue;
      } else if (!entry.isFile()) {
        continue;
      }
      if (!extensions.includes(extname(entry.name).toLowerCase())) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        size = 0;
      }
      found.push({ path: abs, relativePath: relative(folder, abs), depth, size });
    }
  };
  walk(folder, 0);
  return found;
}

/**
 * AIタブ（cwd=作品フォルダで Claude Code を起動する）が自動で読む案内。
 * 素材がどこにあるか・入れ子なので再帰で探すことだけを伝える。
 */
function materialsGuide(v: {
  materialsDir: string;
  videoCount: number;
  audioCount: number;
  imageCount: number;
  documents: string[];
}): string {
  return [
    '# この作品について（素材フォルダから作成）',
    '',
    'フォルダの中身をまるごと素材として受け取った、タイムラインが空の作品。',
    '',
    '| 項目 | 値 |',
    '| --- | --- |',
    `| 素材フォルダ | \`${v.materialsDir}\`（作品直下の \`素材\` でも開ける） |`,
    `| 素材 | 動画 ${v.videoCount} 本 / 音声 ${v.audioCount} 本 / 画像 ${v.imageCount} 枚 |`,
    ...(v.documents.length > 0
      ? [`| 台本・書類 | ${v.documents.map((item) => `\`素材/${item}\``).join(' / ')} |`]
      : []),
    '| 素材の一覧 | `.sme/materials.json` の `materials.videos` / `audio` / `images` / `documents` |',
    '',
    '## 注意',
    '',
    '- 素材フォルダは**サブフォルダに入れ子**。直下の glob では拾えないので再帰で列挙する。',
    '- 相対パスは素材フォルダ基準。`素材/<relativePath>` でそのまま開ける。',
    '- 素材は元の場所を参照しているだけ（コピーしていない）。元を消すと開けなくなる。',
    '- 台本・構成の書類があれば先に読む（`materials.documents`）。構成・文言・並び順は',
    '  そこに書かれている指示を正とし、無い部分だけ自分で決める。',
    '',
  ].join('\n');
}

export interface ImportMediaFolderInput {
  /** 取り込む素材フォルダ（呼び出し側で browse 権限を確認済みの絶対パス）。 */
  folderPath: string;
  /** 作品名。既定はフォルダ名。 */
  name?: string;
}

export interface ImportMediaFolderResult {
  id: string;
  materialsDir: string;
  counts: { videos: number; audio: number; images: number; documents: number };
}

/**
 * 素材フォルダから作品を1つ作る。
 * - 作品は素材なしの作品（`createEmptySequenceProject`）として作る
 * - `素材` はフォルダ本体へのシンボリックリンク（実体コピーなし）
 * - `.sme/materials.json` に素材フォルダと見つけたメディアの相対パスを記録する
 * 途中で失敗したら、この要求で作った作品を消してロールバックする。
 */
export async function importMediaFolder(
  root: string,
  input: ImportMediaFolderInput,
): Promise<ImportMediaFolderResult> {
  const folder = input.folderPath;
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(folder);
  } catch {
    throw new HttpError(400, `フォルダが見つかりません: ${folder}`);
  }
  // 画面はこのメッセージを見て、ファイルドロップの通常の作成へ戻す。
  if (!info.isDirectory()) throw new HttpError(400, 'not-a-directory');

  const videos = scanMediaFiles(folder, VIDEO_EXTENSIONS);
  const audio = scanMediaFiles(folder, AUDIO_EXTENSIONS);
  const images = scanMediaFiles(folder, IMAGE_EXTENSIONS);
  // 台本・構成などの書類も素材として一覧に残す（中身は読まない）。
  const documents = scanMediaFiles(folder, DOCUMENT_EXTENSIONS);
  if (videos.length === 0 && audio.length === 0 && images.length === 0) {
    throw new HttpError(
      400,
      `フォルダに動画・音声・画像が見つかりません（サブフォルダも${MAX_SCAN_DEPTH}階層まで探しました）`,
    );
  }

  const name = sanitizeProjectName(input.name ?? basename(folder));
  if (existsSync(join(root, name))) {
    throw new HttpError(409, `同じ名前の作品がすでにあります: ${name}`);
  }
  const created = await createEmptySequenceProject(root, { name });
  const directory = join(root, created.id);
  try {
    if (!existsSync(join(directory, '素材'))) symlinkSync(folder, join(directory, '素材'));
    mkdirSync(join(directory, '.sme'), { recursive: true });
    writeFileSync(
      join(directory, '.sme', 'materials.json'),
      JSON.stringify(
        {
          materialsDir: folder,
          // 素材はサブフォルダに入れ子になっているので、素材フォルダからの相対パスで全件残す
          // （`素材/<relativePath>` で開ける）。
          materials: {
            videoCount: videos.length,
            audioCount: audio.length,
            imageCount: images.length,
            documentCount: documents.length,
            videos: videos.map((item) => item.relativePath),
            audio: audio.map((item) => item.relativePath),
            images: images.map((item) => item.relativePath),
            documents: documents.map((item) => item.relativePath),
          },
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    writeFileSync(
      join(directory, 'CLAUDE.md'),
      materialsGuide({
        materialsDir: folder,
        videoCount: videos.length,
        audioCount: audio.length,
        imageCount: images.length,
        documents: documents.map((item) => item.relativePath),
      }),
      'utf8',
    );
  } catch (error) {
    // この要求で作った作品なので、途中で失敗したら消して何も残さない。
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    id: created.id,
    materialsDir: folder,
    counts: { videos: videos.length, audio: audio.length, images: images.length, documents: documents.length },
  };
}
