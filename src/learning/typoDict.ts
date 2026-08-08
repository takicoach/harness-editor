import type { TypoDict } from './types';

/** 空の typo_dict を返す。 */
export function emptyTypoDict(): TypoDict {
  return { replace: {}, fillers: { remove: [], keep_in_context: [] }, preserve: [] };
}

/** typo_dict.json をパースする。欠けたキーは既定値で補う。 */
export function parseTypoDict(json: string): TypoDict {
  const base = emptyTypoDict();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('typo_dict.json を JSON として解析できません');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('typo_dict.json はオブジェクトではありません');
  }
  const parsedObj = parsed as Record<string, unknown>;
  const fillers = (parsedObj.fillers ?? {}) as Record<string, unknown>;
  return {
    replace: { ...base.replace, ...((parsedObj.replace as Record<string, string>) ?? {}) },
    fillers: {
      remove: Array.isArray(fillers.remove) ? (fillers.remove as string[]) : [],
      keep_in_context: Array.isArray(fillers.keep_in_context)
        ? (fillers.keep_in_context as string[])
        : [],
    },
    preserve: Array.isArray(parsedObj.preserve) ? (parsedObj.preserve as string[]) : [],
  };
}

/** typo_dict を JSON 文字列へ整形する（末尾改行つき）。 */
export function serializeTypoDict(dict: TypoDict): string {
  return `${JSON.stringify(dict, null, 2)}\n`;
}
