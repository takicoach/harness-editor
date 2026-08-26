/**
 * チュートリアル図鑑（HelpModal）のデータと純関数。
 * 初回チュートリアル（tutorialSteps.ts）の15ステップから、進行専用ステップ
 * （welcome/telop-done/finish 等）を除き AI 待機の解説と削除/ゴミ箱を加えた14項目を、文脈非依存の静的説明文へ
 * 書き直したもの。ここが図鑑の文言の正本で、HelpModal.tsx は描画だけを担う。
 *
 * **文言は実装に追随させること。** 実在しない UI（撤去済みの在席欄・専属待機の案内、
 * 実在しないプリセット名など）を案内しないよう、UI を変えたら本文も同じ作業の中で直す。
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
      '必ずコピーしたいときは作成画面の「コピーして取り込む」にチェックを入れてください。外付けの動画を直接選びたいときは「フォルダから選ぶ」が使えます。',
  },
  {
    id: 'mcp',
    no: 4,
    title: 'AI と接続する',
    category: 'AI',
    description:
      'このエディタは AI 動画編集に対応しています。編集画面の「AI」タブを開くと、AI（Claude Code）がこのタブの中で直接立ち上がります。設定ファイルを書く必要はありません。' +
      'まだ AI が入っていないパソコンでは「AI と接続する（Claude Code を導入）」ボタンが出るので、それを押して導入 → ログインまで済ませてください。すでに入っていれば、タブを開くだけでそのまま繋がります。' +
      '複数の AI を入れている場合は、タブ上部で「Claude」「Codex」を切り替えられます。',
  },
  {
    id: 'ai-tab',
    no: 5,
    title: 'AI タブに頼む',
    category: 'AI',
    description:
      '編集画面の「AI」タブから、接続した AI エージェントに「ここをカットして」「テロップを赤に」など編集を頼めます。やりたいことがあったら、まず何でも聞いてみましょう。',
  },
  {
    id: 'ai-modes',
    no: 6,
    title: 'AI に待機してもらう',
    category: 'AI',
    description:
      'AI エージェントの待機のしかたは2つあります。「A. 全体待機」（推奨）は、AI タブの下にある「待機を開始（編集指示を受け付ける）」を押すだけで始まり、1つの待機役がすべての動画を担当し、指示ごとに裏で助手（subagent）へ任せるので、複数の動画を同時に進められます（ボタンはターミナルが繋がっている間だけ出ます）。' +
      '「B. この動画専属」は、その動画の指示だけを処理する集中モードで、別ターミナルの Claude Code に専属の待機プロンプト（AI接続マニュアルの付録にひな形）を貼り付けて使います。' +
      '同じ動画に両方いる時は専属が優先され、専属の反応が約3分途絶えると全体待機が自動で引き継ぎます。',
  },
  {
    id: 'materials',
    no: 7,
    title: '素材を追加する（左カラム）',
    category: '編集',
    description:
      '編集画面左の「素材」タブから効果音・画像・BGM・サブ動画を追加できます。Finder からのドラッグ＆ドロップでも追加できます。',
  },
  {
    id: 'timeline',
    no: 8,
    title: 'タイムラインとシーン転換',
    category: '編集',
    description:
      '画面下がタイムラインです。シーン転換は「◇（ひし形）」のマークで表します。' +
      '探す場所は動画のトラックの上ではなく、タイムラインのいちばん上——時間の目盛り（ルーラー）に重なる高さです。' +
      'カットが1つも無くても、動画の先頭と末尾には必ず ◇ が出ています。カットすると、その切れ目にも ◇ が増えます。' +
      '◇ をクリックすると右の設定パネルが「シーン転換設定」に変わり、フェード（暗転／白転／色指定）・クロスフェード・スライド・ワイプなどを選べます（先頭と末尾はフェードのみ）。' +
      '転換を設定した ◇ はピンク（コーラル）に塗られるので、どこに付けたか一目で分かります。クリックして選んでいる間はオレンジに変わり、少し大きくなります。' +
      '書き出しに反映させるには、設定パネルに出る「シーン転換を導入（書き出しに反映）」を一度押してください（導入済みならボタンは出ません）。',
  },
  {
    id: 'add-button',
    no: 9,
    title: '＋ 追加ボタン',
    category: '編集',
    description:
      '字幕・テロップ・効果音・画像・BGM・サブ動画——何かを足したいときは、ぜんぶタイムラインの「＋ 追加」からです。迷ったらココ！' +
      '追加される位置は再生ヘッド（いま止まっているところ）です。素材がまだ1つも無い種類は灰色で押せません。',
  },
  {
    id: 'telop',
    no: 10,
    title: 'テロップ',
    category: '編集',
    description: '「＋ 追加」からテロップを追加し、右の設定パネルで文言の書き換えやスタイルの変更ができます。',
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
      '素材は「素材」タブの各アイテムにマウスを乗せると出るゴミ箱アイコンから、プロジェクトはホーム（一覧・進行ボードとも）のカード右上に出るゴミ箱アイコン、またはバッジメニュー「ゴミ箱へ移動」から削除できます。' +
      'まとめて片付けたいときは、ホーム上部の「選択」を押してカードをポチポチ選び、下に出るバーの「ゴミ箱へ移動」で一括移動できます（選択中はカードの並び替えや開く操作は止まります）。' +
      'ホーム上部の「ゴミ箱」を押すと、削除したプロジェクトがサムネイル付きのカード一覧で開き、「元の保存先」と削除日時を見ながら、1 件ずつ「復元」「完全削除」、まとめて「ゴミ箱を空にする」ができます（「戻る」でホームへ）。' +
      'タイムラインで使用中の素材を消そうとすると、使用箇所数つきの警告が出ます。',
  },
  {
    id: 'save',
    no: 12,
    title: '保存',
    category: '仕上げ',
    description:
      'ツールバーの保存ボタンを押すと、ここまでの編集が保存されます（⌘S でも OK）。' +
      'ボタンは状態で表示が変わり、未保存なら「保存 (⌘S)」、保存が済むと「保存済み ✓」になって押せなくなります。' +
      'ふだんは ⚙ 設定の「自動保存」が入っているので、編集の手が止まると自動でも保存されます。',
  },
  {
    id: 'render',
    no: 13,
    title: '書き出し',
    category: '仕上げ',
    description:
      '編集が終わったら「書き出し」で動画ファイルにします。投稿先に合わせたプリセットが3つ出ます——動画の向きに応じた「投稿用（高画質）」（縦なら ショート / Reels、横なら YouTube、正方形ならフィード）、「標準（画質とサイズのバランス）」、「軽量・確認用（720p・共有やX投稿に）」。' +
      '「詳細設定」を開くと解像度と画質を個別に選べます。書き出しを始めると未保存の編集は自動で保存され、完成したらツールバーの「Finderで表示」ですぐ確認できます。',
  },
  {
    id: 'layout',
    no: 14,
    title: '⚙ 設定（レイアウト・テーマほか）',
    category: '仕上げ',
    description:
      '画面レイアウトは ⚙ 設定から変えられます（標準／全高／字幕／波形）。' +
      '同じメニューに、喋っている間だけ BGM を下げる「ダッキング」（弱・中・強）、波形の高さ、自動保存の ON/OFF、ライト⇄ダークの切り替えがまとまっています。' +
      'このチュートリアル図鑑を開き直すのも、いちばん下の「チュートリアル図鑑」からです。',
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
