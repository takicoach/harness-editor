import { describe, it, expect } from 'vitest';
import {
  HELP_TOPICS,
  filterHelpTopics,
  indexOfTopic,
  resolveSelection,
  prevTopicId,
  nextTopicId,
  type HelpTopic,
} from './helpTopics';

describe('HELP_TOPICS', () => {
  it('id が重複しない', () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('全 topic に対応する PNG が img/ に存在する', () => {
    const files = import.meta.glob('./img/*.png', { eager: true }) as Record<string, unknown>;
    for (const t of HELP_TOPICS) {
      expect(files[`./img/${t.id}.png`], `img/${t.id}.png がありません`).toBeDefined();
    }
  });

  it('helpImageFor が全 topic の画像 URL を解決できる（描画側と同一の glob 規約）', async () => {
    const { helpImageFor } = await import('./HelpModal');
    for (const t of HELP_TOPICS) {
      expect(helpImageFor(t.id), `helpImageFor('${t.id}') が undefined`).toBeDefined();
    }
  });
});

describe('filterHelpTopics', () => {
  it('検索語なし・カテゴリ all は全件を返す', () => {
    expect(filterHelpTopics(HELP_TOPICS, '', 'all')).toHaveLength(HELP_TOPICS.length);
  });

  it('タイトルの部分一致で絞り込む', () => {
    const result = filterHelpTopics(HELP_TOPICS, 'テロップ', 'all');
    expect(result.map((t) => t.id)).toContain('telop');
  });

  it('本文の部分一致でも絞り込む（大小文字無視）', () => {
    const result = filterHelpTopics(HELP_TOPICS, 'MCP', 'all');
    expect(result.map((t) => t.id)).toContain('mcp');
  });

  it('該当なしの検索語は空配列', () => {
    expect(filterHelpTopics(HELP_TOPICS, 'ｚｚｚ存在しない語', 'all')).toHaveLength(0);
  });

  it('カテゴリで絞り込む', () => {
    const result = filterHelpTopics(HELP_TOPICS, '', '編集');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => t.category === '編集')).toBe(true);
  });

  it('検索語とカテゴリを両方適用する（AND）', () => {
    const result = filterHelpTopics(HELP_TOPICS, 'テロップ', '基本');
    expect(result).toHaveLength(0);
  });
});

describe('indexOfTopic / resolveSelection', () => {
  it('存在する id の index を返す', () => {
    expect(indexOfTopic(HELP_TOPICS, 'save')).toBe(HELP_TOPICS.findIndex((t) => t.id === 'save'));
  });

  it('存在しない id は -1', () => {
    expect(indexOfTopic(HELP_TOPICS, 'nope')).toBe(-1);
  });

  it('null は -1', () => {
    expect(indexOfTopic(HELP_TOPICS, null)).toBe(-1);
  });

  it('resolveSelection: 選択中 id が絞り込み結果内ならそのまま', () => {
    const subset: HelpTopic[] = HELP_TOPICS.filter((t) => t.category === '編集');
    const first = subset[0]!;
    expect(resolveSelection(subset, first.id)).toBe(first.id);
  });

  it('resolveSelection: 選択中 id が絞り込み結果外なら先頭へフォールバック', () => {
    const subset: HelpTopic[] = HELP_TOPICS.filter((t) => t.category === '仕上げ');
    expect(resolveSelection(subset, 'home')).toBe(subset[0]!.id);
  });

  it('resolveSelection: 絞り込み結果が空なら null', () => {
    expect(resolveSelection([], 'home')).toBeNull();
  });
});

describe('prevTopicId / nextTopicId', () => {
  it('先頭は前へ無効（null）', () => {
    expect(prevTopicId(HELP_TOPICS, HELP_TOPICS[0]!.id)).toBeNull();
  });

  it('末尾は次へ無効（null）', () => {
    expect(nextTopicId(HELP_TOPICS, HELP_TOPICS[HELP_TOPICS.length - 1]!.id)).toBeNull();
  });

  it('中間項目は前後の id を返す', () => {
    const i = 3;
    const id = HELP_TOPICS[i]!.id;
    expect(prevTopicId(HELP_TOPICS, id)).toBe(HELP_TOPICS[i - 1]!.id);
    expect(nextTopicId(HELP_TOPICS, id)).toBe(HELP_TOPICS[i + 1]!.id);
  });

  it('選択なし（null）は前後とも null', () => {
    expect(prevTopicId(HELP_TOPICS, null)).toBeNull();
    expect(nextTopicId(HELP_TOPICS, null)).toBeNull();
  });
});
