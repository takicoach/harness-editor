/**
 * watch を張る 2 か所が内容判定（isSelfContent）を必ず渡していることの pin。
 *
 * isSelfContent は任意引数なので、片方の呼び出し面で外れても型検査も既存テストも通り、
 * その経路だけ「自分の保存で外部変更バナーが出る」状態へ静かに戻る（配線の silent OFF）。
 * 実配線の挙動テスト（watchProjectSelfWrite.test.ts）は eventsApi と同じ形の 1 面しか
 * 通らないため、面の網羅はここで固定する。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8');

describe('watchProject を張る呼び出し面の isSelfContent 配線', () => {
  it('/api/events の watch チャネルは現ディスク指紋で判定する', () => {
    const src = read('eventsApi.ts');
    expect(src).toContain(
      'isSelfContent: () => isSelfWriteContent(projectId, writerId, projectContentSignature(dir)),',
    );
  });

  it('/api/watch（deprecated）も同じ判定を渡す', () => {
    const src = read('plugin.ts');
    expect(src).toContain(
      'isSelfContent: () => isSelfWriteContent(id, undefined, projectContentSignature(dir)),',
    );
  });

  it('保存ルートは書き終えた指紋を記録する（記録が無いと判定材料が生まれない）', () => {
    const src = read('plugin.ts');
    expect(src).toContain('recordSelfWriteContent(id, projectContentSignature(dir));');
  });
});
