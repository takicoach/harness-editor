import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertBurnedInProject } from '../../src/server/convertProject';
import { writeVideoLink } from '../../src/server/videoLink';
import { copyLegacyTemplateProject } from './legacyTemplateProject';

/** Historical 1s/60fps fixture only. No project-creation API or package install. */
export function writeLegacyLinkedProjectFixture(directory: string, target: string): void {
  copyLegacyTemplateProject(directory);
  const file = join(directory, 'src/videoConfig.ts');
  const config = readFileSync(file, 'utf8');
  if (!config.includes('export const FPS = 30;') || !config.includes('export const DURATION_FRAMES = 1500;')) {
    throw new Error('Historical fixture config changed; review its fixed 1s/60fps assumptions');
  }
  writeFileSync(file, config.replace('export const FPS = 30;', 'export const FPS = 60;')
    .replace('export const DURATION_FRAMES = 1500;', 'export const DURATION_FRAMES = 60;'));
  mkdirSync(join(directory, 'public'));
  symlinkSync(target, join(directory, 'public/main.mp4'));
  convertBurnedInProject(directory);
  writeFileSync(join(directory, 'transcript.json'), JSON.stringify({
    engine: 'none', language: 'ja', duration_ms: 1000, words: [], segments: [],
  }));
  const stat = statSync(target);
  writeVideoLink(directory, { target, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, width: 320, height: 240, fps: 60 });
}
