import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('同じカテゴリは配列上で連続している（HelpModal は登場順にグループ化するため、離すと見出しが割れ key も重複する）', () => {
    const seen = new Set<string>();
    let prev: string | null = null;
    for (const t of HELP_TOPICS) {
      if (t.category !== prev) {
        expect(seen.has(t.category), `カテゴリ「${t.category}」が離れて2度出ています`).toBe(false);
        seen.add(t.category);
        prev = t.category;
      }
    }
  });

  it('no は配列順に 1 から連番', () => {
    expect(HELP_TOPICS.map((t) => t.no)).toEqual(HELP_TOPICS.map((_, i) => i + 1));
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
    // 本文にしか出ない語 + 大小文字違いで引く（タイトルは「AI と接続する」で codex を含まない）。
    const result = filterHelpTopics(HELP_TOPICS, 'codex', 'all');
    expect(result.map((t) => t.id)).toContain('mcp');
  });

  it('UI に存在しない「MCP」を図鑑の表題・本文に書かない（AI タブは MCP をユーザーへ露出しない）', () => {
    for (const t of HELP_TOPICS) {
      expect(`${t.title}${t.description}`, `topic ${t.id}`).not.toMatch(/MCP/i);
    }
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
    // 「編集」カテゴリにしか出てこない語を「基本」で引くと 0 件。
    // （「テロップ」は進行ボードの工程説明にも出るため AND の検体には使えない）
    const result = filterHelpTopics(HELP_TOPICS, 'シーン転換', '基本');
    expect(filterHelpTopics(HELP_TOPICS, 'シーン転換', 'all').length).toBeGreaterThan(0);
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

describe('画面の実表示との食い違い（spec 2026-09-25）', () => {
  const addButton = () => HELP_TOPICS.find((t) => t.id === 'add-button')!.description;
  it('道具列を「タイムライン上部」と書かない（2026-09-21 からプレビューの横）', () => {
    for (const t of HELP_TOPICS) expect(t.description, t.id).not.toContain('タイムライン上部');
    expect(addButton()).toContain('プレビューの左');
    expect(addButton()).toContain('マウスを乗せると名前が出ます');
    expect(HELP_TOPICS.find((t) => t.id === 'telop')!.description).toContain('プレビュー横の道具列の「＋ テロップ」');
  });
  it('道具列のボタン名は NativeAddBar の表示名と一致する', () => {
    const source = readFileSync('src/app/native/NativeAddBar.tsx', 'utf8');
    for (const name of ['＋ テロップ', '＋ タイトル', '＋ 図形', '＋ 画像', '＋ BGM', '＋ 効果音']) {
      expect(source, name).toContain(name);
      expect(addButton(), name).toContain(`「${name}」`);
    }
  });
});
