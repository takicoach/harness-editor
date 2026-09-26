/**
 * チュートリアル図鑑（HelpModal）のデータと純関数。
 * 現行の編集画面に合わせた14項目。
 *
 * **文言は実装に追随させること。**
 * 説明を変えた項目は `npm run docs:help-shots -- <topicId>` でスクリーンショットも撮り直す。
 */

export type HelpCategory = '基本' | 'AI' | '編集' | '仕上げ';

export const HELP_CATEGORIES: HelpCategory[] = ['基本', 'AI', '編集', '仕上げ'];

export interface HelpTopic {
  id: string;
  no: number;
  title: string;
  category: HelpCategory;
  description: string;
  /**
   * 機能世代タグ（例 '2026-08'）。現行世代（featureSeen.ts の CURRENT_FEATURE_GENERATION）と
   * 一致する項目には未読のあいだ NEW バッジが出る。新機能を足したらここに 1 行付けるだけでよい。
   */
  addedIn?: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'home',
    no: 1,
    title: 'ホーム画面',
    category: '基本',
    addedIn: '2026-08',
    description:
      'これがホーム画面です。作った動画がここに並んでいきます。動画を選ぶとすぐ編集画面が開きます。' +
      '各カードには「保存先」（パソコン上のどのフォルダにあるか）が出ます。ステータスバッジのメニューから「保存先を開く」を選ぶと、そのフォルダが Finder で開きます。' +
      '外付けドライブの動画をリンクで取り込んだ場合は「動画の実体」の行にリンク先が出て、未接続や差し替わりのときは赤で知らせます。',
  },
  {
    id: 'board',
    no: 2,
    title: '進行ボード',
    category: '基本',
    addedIn: '2026-08',
    description:
      'ホーム右上の表示切り替えで「進行ボード」にすると、動画ごとの進み具合をボードで見られます。' +
      'カードをドラッグして別の列へ動かすと、その状態に固定されて「手動」バッジが付きます（バッジメニューの「自動判定に戻す」で解除）。' +
      '各カードの下には「文字起こし→カット→テロップ→SE/BGM→書き出し」の工程の進み具合が自動表示されます。',
  },
  {
    id: 'create',
    no: 3,
    title: '動画を作成する',
    category: '基本',
    addedIn: '2026-08',
    description:
      'ホームの「＋ 動画を作成する」から動画ファイルを選ぶか、動画ファイルをホーム画面にドラッグ＆ドロップすると、新しいプロジェクトが作られます。' +
      'プロジェクト名を付けたら「作成」。取り込みには少し時間がかかることがあります。' +
      '取り込みは、同じ動画が登録済みのフォルダ（外付け・デスクトップ・ダウンロード・ムービー）にあれば、コピーせずリンクで繋ぎます（内蔵ストレージを使いません）。' +
      '必ずコピーしたいときは作成画面の「コピーして取り込む」にチェックを入れてください。外付けの動画を直接選びたいときは「フォルダから選ぶ」が使えます。' +
      '音声（ポッドキャスト）や画像からも作れます。画像は複数選ぶと、選んだ順に1枚5秒で並びます（複数の画像はコピーして取り込みます）。',
  },
  {
    id: 'mcp',
    no: 4,
    title: 'AI と接続する',
    category: 'AI',
    description:
      '右パネル上部の「AI で編集する」を押すと、AI に指示を出す画面が開きます。設定ファイルを書く必要はありません。' +
      'Claude が未導入なら「インストール」、Codex が未導入なら「導入手順を見る」から準備します。導入後は必要に応じてログインしてください。' +
      '複数の AI を入れている場合は、AI 画面の上部で「Claude」「Codex」を切り替えられます。',
  },
  {
    id: 'ai-tab',
    no: 5,
    title: 'AI に編集を頼む',
    category: 'AI',
    description:
      '右パネル上部の「AI で編集する」から、接続した AI に「ここをカットして」「テロップを赤に」など編集を頼めます。' +
      '接続後に「待機を開始（編集指示を受け付ける）」が表示されたら、そこから編集指示の待機を始められます。' +
      '「編集画面に戻る」を押すと、字幕一覧・台本・調整のパネルに戻ります。',
  },
  {
    id: 'ai-modes',
    no: 6,
    title: 'AI の作業を確認する',
    category: 'AI',
    description:
      '画面上部の「AIの作業」で、この動画に対する AI の処理状況や変更案を確認できます。' +
      '作業の結果と、人が確認・採用した内容は別々に表示されます。確認が必要な案内が出たときも、ここから内容を確認します。',
  },
  {
    id: 'materials',
    no: 7,
    title: '素材を追加する（左カラム）',
    category: '編集',
    description:
      '左パネルの「素材」には動画・画像・BGM・効果音が種類別に並びます。' +
      '動画や画像は「素材を追加」で元ファイルを参照し、「コピーして追加」で案件内にコピーできます。Finder からのドラッグ＆ドロップにも対応しています。' +
      '取り込んだ素材は「再生位置に置く」かダブルクリックで配置し、タイムラインへドラッグすると好きな位置に置けます。',
  },
  {
    id: 'timeline',
    no: 8,
    title: 'タイムラインで編集する',
    category: '編集',
    description:
      '画面下の「シーケンス」がタイムラインです。「選択」でクリップを動かし、「分割」で切れ目を入れ、「なぞってカット」で取り除く範囲を選びます。' +
      '「スナップ」は端や再生位置に合わせる補助、「詰める」は端を短くした範囲を全トラックから取り除いて詰める機能です。ズームで拡大し、「全体」で動画全体を表示できます。' +
      'シーン転換は画面上部の「仕上げ」から、右の「調整」にある「シーン転換」で設定します。',
  },
  {
    id: 'add-button',
    no: 9,
    title: 'テロップ・画像・音を追加する',
    category: '編集',
    description:
      'プレビューの左に、縦に並んだ道具列があります（プレビューの高さが足りないときは、プレビューの下に横一列で並びます）。' +
      '並びは「＋ テロップ」「＋ タイトル」「＋ 図形」「＋ 画像」「＋ BGM」「＋ 効果音」で、ボタンはアイコンだけなので、マウスを乗せると名前が出ます。' +
      'テロップとタイトルは再生位置に追加します。図形は種類を選び、プレビュー上でドラッグして描きます。' +
      '画像・BGM・効果音のボタンは左の素材パネルを開きます。使う素材を選んで「再生位置に置く」を押してください。動画も左の素材パネルから配置できます。',
  },
  {
    id: 'telop',
    no: 10,
    title: '字幕・テロップを編集する',
    category: '編集',
    description:
      '右の「字幕一覧」では、文字起こしのことばをなぞってカットする範囲を選び、一覧の行から本文を編集できます。' +
      '「＋ 字幕・テロップ」またはプレビュー横の道具列の「＋ テロップ」で追加できます。選んだ字幕のスタイルや配置は「調整」で変更します。' +
      '撮影台本を使うときは、隣の「台本」を開きます。',
  },
  {
    // 「編集」カテゴリのブロック内に置く（HelpModal はカテゴリを登場順にグループ化するため、
    // 末尾に足すと「編集」の見出しが2つに割れて React の key も重複する）。
    id: 'trash',
    no: 11,
    title: '削除とゴミ箱',
    category: '編集',
    addedIn: '2026-08',
    description:
      '素材は左パネルの「案件から外す」で取り除きます。使用中の素材は先に使用箇所を取り除いてください。外した素材に「ゴミ箱へ移す」が表示される場合は、そこからファイルも片付けられます。' +
      'プロジェクトはホームのカード右上のゴミ箱アイコン、またはバッジメニュー「ゴミ箱へ移動」から片付けられます。' +
      'まとめて片付けたいときは、ホーム上部の「選択」を押してカードをポチポチ選び、下に出るバーの「ゴミ箱へ移動」で一括移動できます（選択中はカードの並び替えや開く操作は止まります）。' +
      'ホーム上部の「ゴミ箱」で、移動したプロジェクトの復元や完全削除ができます。',
  },
  {
    id: 'save',
    no: 12,
    title: '保存',
    category: '仕上げ',
    description:
      '画面上部の「保存」で編集内容を保存します（⌘S／Ctrl+S でも保存できます）。' +
      'プロジェクト名の隣に「未保存の変更」「処理中…」「保存済み」と状態が表示されます。' +
      '「自動保存」の切り替えも画面上部にあります。ON にすると、編集の手が止まったあとに自動で保存されます。',
  },
  {
    id: 'render',
    no: 13,
    title: '書き出し',
    category: '仕上げ',
    description:
      '編集が終わったら「書き出し」で動画ファイルにします。投稿先に合わせたプリセットが3つ出ます——動画の向きに応じた「投稿用（高画質）」（縦なら ショート / Reels、横なら YouTube、正方形ならフィード）、「標準（画質とサイズのバランス）」、「軽量・確認用（720p・共有やX投稿に）」。' +
      '同じパネルで解像度と画質を個別に選ぶこともできます。開始すると編集内容が保存され、動画が書き出されます。完成後は「動画を保存」から受け取れます。過去の結果は「書き出し履歴」で確認できます。',
  },
  {
    id: 'layout',
    no: 14,
    title: '⚙ 設定（レイアウト・テーマほか）',
    category: '仕上げ',
    description:
      '画面上部の歯車から「設定」を開きます。テーマはシステム・ライト・ダーク、表示の密度はコンパクト・標準から選べます。' +
      '右パネルの「ふつう／縦長」と、タイムラインの「ふつう／全幅」で配置を切り替えられます。「確認」モードでは配置の切り替えはできません。' +
      'セーフエリア、再生速度の上限、スナップの初期状態、操作音もここで設定します。「すべてのキー」でショートカットを確認し、「使い方を見る」でこの図鑑を開けます。',
  },
];

/** 検索語（タイトル・本文の部分一致・大小文字無視）とカテゴリで絞り込む純関数。 */
export function filterHelpTopics(
  topics: HelpTopic[],
  query: string,
  category: HelpCategory | 'all',
): HelpTopic[] {
  const q = query.trim().toLowerCase();
  return topics.filter((t) => {
    if (category !== 'all' && t.category !== category) return false;
    if (q === '') return true;
    return t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });
}

/** 現在の絞り込み結果内で id が指す項目の index（無ければ -1）。 */
export function indexOfTopic(topics: HelpTopic[], id: string | null): number {
  if (id === null) return -1;
  return topics.findIndex((t) => t.id === id);
}

/**
 * 選択中 id が現在の絞り込み結果に含まれていればそのまま、含まれなければ
 * 先頭項目（無ければ null）へフォールバックする、選択解決の純関数。
 */
export function resolveSelection(topics: HelpTopic[], selectedId: string | null): string | null {
  if (selectedId !== null && topics.some((t) => t.id === selectedId)) return selectedId;
  return topics[0]?.id ?? null;
}

/** 前へ（先頭では null＝無効）。 */
export function prevTopicId(topics: HelpTopic[], selectedId: string | null): string | null {
  const i = indexOfTopic(topics, selectedId);
  if (i <= 0) return null;
  return topics[i - 1]?.id ?? null;
}

/** 次へ（末尾では null＝無効）。 */
export function nextTopicId(topics: HelpTopic[], selectedId: string | null): string | null {
  const i = indexOfTopic(topics, selectedId);
  if (i < 0 || i >= topics.length - 1) return null;
  return topics[i + 1]?.id ?? null;
}
