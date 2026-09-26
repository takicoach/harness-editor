import { evalDataModule } from './dataModule';
import { ProjectFileError } from './types';
import {
  DEFAULT_MAIN_AUDIO,
  isDefaultMainAudio,
  normalizeMainAudioSettings,
  type MainAudioSettings,
} from './mainAudio';

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseMainAudioData(source: string | null): MainAudioSettings {
  if (source === null) return { ...DEFAULT_MAIN_AUDIO };
  let moduleValue: Record<string, unknown>;
  try {
    moduleValue = evalDataModule(source, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectFileError('mainAudioData.ts', `ソースを読み取れません: ${message}`);
  }
  if (!hasOwn(moduleValue, 'MAIN_AUDIO')) {
    throw new ProjectFileError('mainAudioData.ts', 'MAIN_AUDIO exportがありません');
  }
  try {
    return normalizeMainAudioSettings(moduleValue.MAIN_AUDIO);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectFileError('mainAudioData.ts', message);
  }
}

export function serializeMainAudioData(settings: MainAudioSettings | undefined): string | null {
  const value = normalizeMainAudioSettings(settings ?? DEFAULT_MAIN_AUDIO);
  if (isDefaultMainAudio(value)) return null;
  return `// Harness Editor が生成・更新します（元動画の音声）\n\nexport const MAIN_AUDIO = {\n  gainDb: ${value.gainDb},\n  muted: ${value.muted},\n  fadeInFrames: ${value.fadeInFrames},\n  fadeOutFrames: ${value.fadeOutFrames},\n};\n`;
}
