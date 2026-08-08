import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../core';
import { applyCuts } from '../core/cutEngine';
import { isCutsOnly } from '../shared/cutsOnly';
import type { RenderOptions } from '../shared/renderPreset';
import { targetResolution } from '../shared/renderPreset';
import { readProjectFiles } from './loadProjectFiles';
import { probeFrameCount } from './probeFrames';
import {
  verifyCutFrames,
  buildCutFilterScript,
  buildFastCutArgs,
  expectedCutFrames,
  scaleFilterFor,
  type KeptSegment,
} from './fastCutRender';

/**
 * 「カットしただけ」の書き出しを ffmpeg 直結で行う計画を立てる。
 * 条件を満たさない・読み取りに失敗した場合は null（通常の Remotion 経路へ落ちる）。
 */
export interface FastCutPlan {
  args: string[];
  /** 書き出し後の検算（出力フレーム数 vs 想定）。 */
  verify: (output: string, expectedFrames: number) => string | null;
  /** 出力されるはずのフレーム数（進捗の分母＋書き出し後の検算）。 */
  totalFrames: number;
  /** 出力解像度（表示用）。 */
  target: { width: number; height: number };
}

export function planFastCut(
  projectDir: string,
  options: RenderOptions,
  output: string,
  deps: { hardware?: boolean; writeFile?: (p: string, data: string) => void } = {},
): FastCutPlan | null {
  const hardware = deps.hardware ?? process.platform === 'darwin';
  const write = deps.writeFile ?? ((p: string, data: string) => writeFileSync(p, data, 'utf8'));

  let project;
  try {
    project = loadProject(readProjectFiles(projectDir));
  } catch {
    return null; // 読めないなら通常経路（そちらでエラーになる）
  }
  if (!isCutsOnly(project)) return null;

  const { videoConfig } = project;
  const segments: KeptSegment[] = applyCuts(videoConfig.durationFrames, project.cutRegions)
    .map((s) => ({ start: s.originalStart, end: s.originalEnd }));
  const totalFrames = expectedCutFrames(segments);
  if (totalFrames <= 0) return null;

  let script: string;
  try {
    script = buildCutFilterScript(segments, videoConfig.fps);
  } catch {
    return null;
  }
  const source = { width: videoConfig.resolution.width, height: videoConfig.resolution.height };
  const scale = scaleFilterFor(options, source);
  if (scale !== null) {
    // 縮小は concat のあとに 1 回だけ掛ける（区間ごとに掛けると無駄が大きい）。
    script = script.replace('[outv][outa]', '[catv][outa];\n[catv]' + scale + '[outv]');
  }
  const filterScript = join(projectDir, 'out', 'cut-filter.txt');
  write(filterScript, script);

  const target = targetResolution(source.width, source.height, options.resolution);
  return {
    verify: (out, expected) => verifyCutFrames(out, expected, probeFrameCount),
    args: buildFastCutArgs({
      input: join(projectDir, 'public', videoConfig.videoFile),
      filterScript,
      output,
      options,
      target,
      hardware,
    }),
    totalFrames,
    target,
  };
}
