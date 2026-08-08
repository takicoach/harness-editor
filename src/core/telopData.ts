import { evalDataModule } from './dataModule';
import { replaceExportArray } from './sourceEdit';
import { formatMotion } from './motion';
import { ProjectFileError, type TelopSegment } from './types';

/**
 * ハーネス形式の telopData.ts を読み取り TelopSegment[] を返す。
 * telopData.ts は telopTypes と videoConfig を import するためスタブを渡す。
 */
export function parseTelopData(
  source: string,
  fps: number,
  durationFrames: number,
): TelopSegment[] {
  const m = evalDataModule(source, {
    './telopTypes': {},
    '../videoConfig': { FPS: fps, DURATION_FRAMES: durationFrames },
  });
  if (!Array.isArray(m.telopData)) {
    throw new ProjectFileError('telopData.ts', 'telopData 配列が見つかりません');
  }
  return m.telopData as TelopSegment[];
}

/** 文字列をダブルクオートの JS リテラルへ。改行は \n / \r、" と \ をエスケープ。 */
function jsString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** TelopSegment[] を telopData.ts の配列リテラル文字列へ整形する。 */
export function formatTelopArray(segments: TelopSegment[]): string {
  if (segments.length === 0) return '[]';
  const items = segments.map((s) => {
    const lines = [`    id: ${s.id},`];
    lines.push(`    startFrame: ${s.startFrame},`);
    lines.push(`    endFrame: ${s.endFrame},`);
    lines.push(`    text: ${jsString(s.text)},`);
    if (s.highlight !== undefined) lines.push(`    highlight: ${jsString(s.highlight)},`);
    if (s.style !== undefined) lines.push(`    style: ${jsString(s.style)},`);
    if (s.template !== undefined) lines.push(`    template: ${s.template},`);
    if (s.animation !== undefined) lines.push(`    animation: ${jsString(s.animation)},`);
    if (s.position !== undefined) {
      lines.push(`    position: { x: ${s.position.x}, y: ${s.position.y} },`);
    }
    if (s.scale !== undefined) lines.push(`    scale: ${s.scale},`);
    if (s.motion !== undefined) lines.push(`    motion: ${formatMotion(s.motion)},`);
    if (s.manual === true) lines.push(`    manual: true,`);
    // originalStart/originalEnd はペアで出力。片方だけ存在する不正なファイルを生成しない。
    if (s.originalStart !== undefined && s.originalEnd !== undefined) {
      lines.push(`    originalStart: ${s.originalStart},`);
      lines.push(`    originalEnd: ${s.originalEnd},`);
    }
    return `  {\n${lines.join('\n')}\n  }`;
  });
  return `[\n${items.join(',\n')},\n]`;
}

/** TelopSegment[] を originalSource の telopData 配列だけ差し替えて書き戻す。 */
export function serializeTelopData(originalSource: string, segments: TelopSegment[]): string {
  return replaceExportArray(originalSource, 'telopData', formatTelopArray(segments));
}
