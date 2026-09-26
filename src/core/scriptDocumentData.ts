import { scriptDocumentSchema, type ScriptDocument } from './scriptAlignment';

export interface CreateScriptDocumentOptions {
  documentId: string;
  revision: string;
}

/**
 * 台本の原文を変えず、空白だけではない各行を UTF-16 範囲へ切り出す。
 * passage ID は同じ原文内の非空行順で決まり、document revision が変われば
 * packet 全体も変わるため、行の追加・削除後の古い提案は再利用されない。
 */
export function createScriptDocument(text: string, options: CreateScriptDocumentOptions): ScriptDocument {
  if (text.trim() === '') throw new Error('SCRIPT_EMPTY: 台本は空白だけにできません');
  const passages: ScriptDocument['passages'] = [];
  let lineStart = 0;
  let passageNumber = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const atEnd = index === text.length;
    const isLineBreak = !atEnd && (text[index] === '\n' || text[index] === '\r');
    if (!atEnd && !isLineBreak) continue;
    const lineEnd = index;
    if (text.slice(lineStart, lineEnd).trim() !== '') {
      passageNumber += 1;
      passages.push({ id: `passage-${passageNumber}`, range: { start: lineStart, end: lineEnd } });
    }
    if (!atEnd) {
      index += text[index] === '\r' && text[index + 1] === '\n' ? 1 : 0;
      lineStart = index + 1;
    }
  }
  return scriptDocumentSchema.parse({
    schemaVersion: 1,
    documentId: options.documentId,
    revision: options.revision,
    text,
    passages,
  });
}

/** shooting-script.json を strict schema で読み取る。 */
export function parseScriptDocumentData(json: string): ScriptDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('SCRIPT_DOCUMENT_INVALID: shooting-script.json をJSONとして読み取れません');
  }
  try {
    return scriptDocumentSchema.parse(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SCRIPT_DOCUMENT_INVALID: shooting-script.json が不正です: ${detail}`);
  }
}

/** 新規作成・本文変更時の正典JSON。未変更ファイルのbyte保持はserver保存層が担う。 */
export function serializeScriptDocumentData(document: ScriptDocument): string {
  return `${JSON.stringify(scriptDocumentSchema.parse(document), null, 2)}\n`;
}
