import { lstatSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { HttpError } from './http';
import { VIDEO_EXTENSIONS } from './loadProjectFiles';
import { probeVideo, type ProbedVideo } from './createProject';
import { linkVideoIntoPlace, writeVideoLink } from './videoLink';

/**
 * 切れた（または別動画に差し替わった）リンクの接続先を選び直す。
 *
 * 外付けのボリューム名変更・フォルダ整理のあと、再接続しても元のパスには戻らない。
 * 張り直す導線が無いとプロジェクトが復旧不能になるため MVP に含める。
 */

export interface RelinkResult {
  /** 新しい接続先。 */
  target: string;
  /** videoConfig.ts と食い違う点（fps・尺・解像度）。空なら一致。 */
  warnings: string[];
}

/** 実測値と videoConfig の食い違いを人間向け文言で列挙する。 */
export function describeMismatch(
  probed: ProbedVideo,
  config: { fps: number; durationFrames: number; width: number; height: number },
): string[] {
  const out: string[] = [];
  const fps = Math.round(probed.fps * 1000) / 1000;
  if (Math.abs(fps - config.fps) > 0.01) {
    out.push(`fps が違います（プロジェクト ${config.fps} / 選んだ動画 ${fps}）`);
  }
  if (probed.width !== config.width || probed.height !== config.height) {
    out.push(
      `解像度が違います（プロジェクト ${config.width}×${config.height} / 選んだ動画 ${probed.width}×${probed.height}）`,
    );
  }
  const frames = Math.max(1, Math.round(probed.durationSeconds * fps));
  // 1 秒以上ずれていたら別素材とみなす（再エンコードでの端数ずれは許容する）。
  if (Math.abs(frames - config.durationFrames) > Math.max(1, Math.round(config.fps))) {
    out.push(`長さが違います（プロジェクト ${config.durationFrames} フレーム / 選んだ動画 ${frames} フレーム）`);
  }
  return out;
}

/**
 * リンクを張り替える。`force` が false のとき、videoConfig と食い違う動画は
 * 張り替えずに warnings だけを返す（UI で確認してから force: true で再実行する）。
 */
export function relinkVideo(
  projectDir: string,
  input: { targetPath: string; videoFile: string; force: boolean },
  config: { fps: number; durationFrames: number; width: number; height: number },
  deps: {
    probe?: (p: string) => ProbedVideo;
    link?: (target: string, linkPath: string) => void;
    stat?: (p: string) => { size: number; mtimeMs: number };
  } = {},
): RelinkResult {
  const ext = extname(input.targetPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    throw new HttpError(400, `動画ファイルを選んでください（対応: ${VIDEO_EXTENSIONS.join(' ')}）`);
  }
  const probe = deps.probe ?? probeVideo;
  const link = deps.link ?? ((t: string, p: string) => linkVideoIntoPlace(t, p));
  const stat = deps.stat ?? ((p: string) => statSync(p));

  const probed = probe(input.targetPath);
  const warnings = describeMismatch(probed, config);
  if (warnings.length > 0 && !input.force) {
    return { target: input.targetPath, warnings };
  }

  const linkPath = join(projectDir, 'public', input.videoFile);
  // 既存が「リンク」の時だけ差し替える。実体ファイルを消してしまう事故を防ぐ。
  let existing: { isSymbolicLink(): boolean } | null = null;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing !== null && !existing.isSymbolicLink()) {
    throw new HttpError(
      409,
      'このプロジェクトの動画はコピーで取り込まれています（リンクではないため張り替えできません）',
    );
  }
  if (existing !== null) rmSync(linkPath, { force: true });
  link(input.targetPath, linkPath);

  const st = stat(linkPath);
  writeVideoLink(projectDir, {
    target: input.targetPath,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    width: probed.width,
    height: probed.height,
    fps: Math.round(probed.fps * 1000) / 1000,
  });
  return { target: input.targetPath, warnings };
}
