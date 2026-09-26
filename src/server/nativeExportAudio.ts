import { sec } from './ffmpegTime';
import { buildDuckGainExpr } from './duckGainExpr';
import type { DuckEnvelope } from '../core/types';

/** applyAudioMix に渡す1系統分（最終座標）。SE・BGM 共通。 */
export interface MixClip {
  startFrame: number;
  endFrame: number;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** 供給時のみ ducking ゲイン曲線を volume 式として挿入（clip 内相対 envelope）。 */
  ducking?: DuckEnvelope;
}

/**
 * filter_complex スクリプトへ音声ミックスを足す（nativeExport 音声工程・SE/BGM 共通）。
 * ベースの concat 出力 '[outa]'（最初の出現）を '[cuta]' に付け替え、各系統
 * （atrim→aresample→aformat→volume→afade→adelay）を amix
 * （normalize=0:dropout_transition=0:duration=first = spec 逐語）で合成して
 * '[outa]' を再構成する。-map '[outa]' は不変のまま。
 * clips は ExportTimeline の最終座標（attachAudio 済み）であること。入力 index は
 * main=0・clips は配列順に 1..N（extraInputs の並びと一致させるのは呼び出し側の責務）。
 *
 * 固定仕様（Remotion 経路との同値化・意図的な非「改善」）: BGM ループの継ぎ目はハードスプライス
 * （<Audio loop> と同値）・amix は非正規化（normalize=0、Remotion の非正規化ミックスと同値でクリップしうる）。
 * どちらも Remotion 経路と出力を一致させるために固定した仕様であり、クリッピング対策などの
 * "改善" はこの同値を壊すため行わない。
 */
export function applyAudioMix(baseScript: string, clips: readonly MixClip[], fps: number): string {
  if (clips.length === 0) return baseScript;
  const lines: string[] = [];
  const labels: string[] = [];
  clips.forEach((c, i) => {
    const durFrames = Math.max(1, c.endFrame - c.startFrame);
    const chain: string[] = [
      `atrim=0:${sec(durFrames, fps)}`,
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
    ];
    if (c.volume !== 1) chain.push(`volume=${c.volume}`);
    const fadeIn = c.fadeInFrames ?? 0;
    const fadeOut = c.fadeOutFrames ?? 0;
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${sec(fadeIn, fps)}`);
    if (fadeOut > 0) {
      const startFrame = Math.max(0, durFrames - 1 - fadeOut);
      const dFrames = Math.max(1, durFrames - 1 - startFrame); // 尺を超えるフェードは尺に収める（正典 bgmFadeVolume は lastFrame で必ず 0）
      chain.push(`afade=t=out:st=${sec(startFrame, fps)}:d=${sec(dFrames, fps)}`);
    }
    // volume 式（ducking）は asetpts=PTS-STARTPTS の後・adelay の前に置く（式の t はクリップ相対秒でなければ
    // ならない — adelay 後に置くと t が adelay 分ずれて duckFactorAt との同値が崩れる）。afade とは乗算合成
    // （fadeVolume * duckFactor と同値）で順序は可換なので、afade の直後・adelay の直前に挿入する。
    const duckExpr = buildDuckGainExpr(c.ducking, fps);
    if (duckExpr) chain.push(`volume='${duckExpr}':eval=frame`);
    chain.push(`adelay=${Math.round((c.startFrame / fps) * 1000)}:all=1`);
    lines.push(`[${i + 1}:a]${chain.join(',')}[mix${i}];`);
    labels.push(`[mix${i}]`);
  });
  const rewritten = baseScript.replace('[outa]', '[cuta]');
  return (
    rewritten.trimEnd() + ';\n' +
    lines.join('\n') + '\n' +
    `[cuta]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[cutn];\n` +
    `[cutn]${labels.join('')}amix=inputs=${clips.length + 1}:normalize=0:dropout_transition=0:duration=first[outa]\n`
  );
}
