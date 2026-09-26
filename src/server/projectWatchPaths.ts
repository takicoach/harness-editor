import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseVideoConfigStatic } from '../core/videoConfig';
import { previewProxyName } from './previewProxy';

/**
 * 監視対象ファイルの一覧と、その「いまのディスクの姿」の指紋。
 *
 * watchProject が chokidar に渡すパターンと、自己書込の内容判定（selfWrite の
 * contentSignature）が **同じ一覧** を見る必要があるため、1 か所に置く。
 * 片方だけにファイルが増えると「監視しているのに指紋に出ない（＝自分の書込と誤判定して
 * 外部変更を握り潰す）」という取りこぼしが生まれる。
 */

/** 監視・指紋の対象（プロジェクトからの相対パス断片）。 */
const WATCH_REL_SEGMENTS: readonly (readonly string[])[] = [
  ['shooting-script.json'],
  ['editor-timeline.json'],
  ['transcript.json'],
  ['src', 'テロップテンプレート', 'telopData.ts'],
  ['cutData.ts'],
  ['src', 'cutData.ts'],
  ['src', 'テロップテンプレート', 'cutData.ts'],
  ['src', 'SoundEffects', 'seData.ts'],
  ['src', 'InsertImage', 'insertImageData.ts'],
  ['src', 'InsertVideo', 'insertVideoData.ts'],
  ['src', 'Bgm', 'bgmData.ts'],
  ['src', 'Title', 'titleData.ts'],
  ['src', 'InsertShape', 'shapeData.ts'],
  ['src', 'Transition', 'transitionData.ts'],
  ['src', 'speedData.ts'],
  ['src', 'mainLayoutData.ts'],
  ['src', 'videoConfig.ts'],
];

/** 監視対象の絶対パス群（存在しないパスも含む: chokidar は生成時の add を拾うため）。 */
export function projectWatchPaths(projectDir: string): string[] {
  const paths = WATCH_REL_SEGMENTS.map((segs) => join(projectDir, ...segs));
  try {
    const config = parseVideoConfigStatic(readFileSync(join(projectDir, 'src', 'videoConfig.ts'), 'utf8'));
    const publicDir = resolve(projectDir, 'public');
    for (const file of [config.videoFile, previewProxyName(config.videoFile)]) {
      const path = resolve(publicDir, file);
      const rel = relative(publicDir, path);
      // Source symlinks are supported, but config cannot add arbitrary outside paths.
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        paths.push(path);
      }
    }
  } catch {
    // A partially written config must not stop static watches. Its next event retries.
  }
  return [...new Set(paths)];
}

/**
 * 監視対象ファイル群の指紋。存在しないファイルは `-`。
 *
 * 保存直後に記録しておき、watch イベントの再評価時にもう一度取って比べる。
 * 一致＝ディスクは自分が書いたままで、外部の書き換えは起きていない。
 * ctime/identity も含め、同じサイズ・mtime に復元された置換を区別する。
 * 照合入力の内容保証は別途 collector の SHA256 が担う。
 */
export function projectContentSignature(projectDir: string): string {
  return projectWatchPaths(projectDir)
    .map((abs) => {
      try {
        const st = statSync(abs);
        return `${abs}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.dev}:${st.ino}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${abs}:-`;
        throw error;
      }
    })
    .join('\n');
}
