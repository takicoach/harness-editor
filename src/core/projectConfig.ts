import { ProjectFileError, type ProjectConfig } from './types';

/** project-config.json を読み取る。任意ファイルなので呼び出し側で null を扱う。 */
export function parseProjectConfig(json: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProjectFileError('project-config.json', 'JSON として解析できません');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectFileError('project-config.json', 'オブジェクトではありません');
  }
  return parsed as ProjectConfig;
}
