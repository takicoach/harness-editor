import { describe, expect, it } from 'vitest';
import { createScriptDocument, parseScriptDocumentData, serializeScriptDocumentData } from './scriptDocumentData';

describe('scriptDocumentData', () => {
  it('原文とUTF-16位置を保ち、LF/CRLF/空行から非空行だけを文章にする', () => {
    const text = '一行目😀\r\n  \r\n  二行目  \n';
    const document = createScriptDocument(text, { documentId: 'shooting', revision: 'revision-1' });
    expect(document.text).toBe(text);
    expect(document.passages).toEqual([
      { id: 'passage-1', range: { start: 0, end: 5 } },
      { id: 'passage-2', range: { start: 11, end: 18 } },
    ]);
    expect(document.passages.map(({ range }) => text.slice(range.start, range.end))).toEqual(['一行目😀', '  二行目  ']);
  });

  it('空白だけを拒否し、壊れたsurrogateやunknown keyをstrictに拒否する', () => {
    expect(() => createScriptDocument(' \n\t', { documentId: 'shooting', revision: 'revision-1' })).toThrow('SCRIPT_EMPTY');
    const valid = createScriptDocument('本文', { documentId: 'shooting', revision: 'revision-1' });
    expect(() => parseScriptDocumentData(JSON.stringify({ ...valid, accepted: true }))).toThrow('SCRIPT_DOCUMENT_INVALID');
    expect(() => createScriptDocument('\ud800', { documentId: 'shooting', revision: 'revision-1' })).toThrow();
  });

  it('正典JSONをround-tripする', () => {
    const document = createScriptDocument('A 12.5%\nB -3', { documentId: 'shooting', revision: 'revision-1' });
    const source = serializeScriptDocumentData(document);
    expect(source.endsWith('\n')).toBe(true);
    expect(parseScriptDocumentData(source)).toEqual(document);
  });
});
