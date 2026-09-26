import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir, validateSaveRequest } from './saveProject';

const owned: string[] = [];
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'main-audio-root-audit-'));
  owned.push(path);
  cpSync(resolve(__dirname, '__fixtures__/sample-project'), path, { recursive: true });
  return path;
}
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('independent main-audio save compatibility audit', () => {
  it('preserves other exports and forward fields in an existing unchanged non-default module', () => {
    const dir = fixture();
    const data = join(dir, 'src/mainAudioData.ts');
    const source = 'export const MAIN_AUDIO={gainDb:6,futureSetting:"retained"};\nexport const USED_ELSEWHERE=true;\n';
    writeFileSync(data, source);
    const { project, save } = loadProjectFromDir(dir);
    saveProjectToDir(dir, validateSaveRequest({ project, fingerprint: save.fingerprint }));
    expect(readFileSync(data, 'utf8')).toBe(source);
  });

  it('does not delete an existing identity data module imported by MainVideo during an unrelated save', () => {
    const dir = fixture();
    const data = join(dir, 'src/mainAudioData.ts');
    writeFileSync(data, 'export const MAIN_AUDIO={gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0};');
    const main = join(dir, 'src/MainVideo.tsx');
    writeFileSync(main, `import {MAIN_AUDIO} from './mainAudioData';\n${readFileSync(main, 'utf8')}\nvoid MAIN_AUDIO;`);
    const { project, save } = loadProjectFromDir(dir);
    project.telops[0]!.text = '音声を変えずに字幕だけ修正';
    saveProjectToDir(dir, validateSaveRequest({ project, fingerprint: save.fingerprint }));
    expect(existsSync(data), 'a retained import must still resolve after saving').toBe(true);
    expect(loadProjectFromDir(dir).project.telops[0]!.text).toBe(project.telops[0]!.text);
  });

  it('normalizes property defaults consistently between request validation and save equality', () => {
    const dir = fixture();
    const { project, save } = loadProjectFromDir(dir);
    const request = validateSaveRequest({ project: { ...project, mainAudio: {} }, fingerprint: save.fingerprint });
    // Omitted properties are explicitly accepted as defaults by the public data schema.
    expect(() => saveProjectToDir(dir, request)).not.toThrow();
    expect(existsSync(join(dir, 'src/mainAudioData.ts'))).toBe(false);
  });
});
