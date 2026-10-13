/**
 * 待機役エージェントへ渡すプロンプト。クライアント（コピー用 UI）とサーバ
 * （待機開始ボタンの pty 投入）が共用するため src/shared/ に置く。
 * 文言を変えたら、利用者向けの手引き（docs/AI接続マニュアル.md の待機文言）も合わせて直す。
 */
import { AI_MODE_LABEL, type AiMode } from './aiFocus';

/** Human and AI edits must use the same open editor authority after native migration. */
export const EDITOR_REQUEST_WORKFLOW =
  'まず editor_projects と editor_read で指示の projectId に一致する編集画面と現在版を確認する。' +
  '接続先を省略して別案件を編集しない。documentFormat が sequence-v2 の案件では、' +
  'project.v2.json や旧編集ファイルを直接書き換えず、editor_read で得た ID・版・変更前本文・reference を使い、' +
  'カットや素材調整には section で clips・assets・tracks・cuts・transcripts を読み、changes は空配列、' +
  'sequence は documentId と型付き commands にして渡す。続きの取得には初回の revision を指定し、' +
  '同じ素材でも使用箇所を ID で区別する。字幕本文だけの修正は既存の changes も使える。' +
  'editor_validate、editor_apply の順で編集を依頼し、返った runId を editor_runs で確認する。' +
  '動画をメインの末尾に並べる依頼では、許可された場所（外付け・デスクトップ・ダウンロード・ムービー）にある動画の絶対パスを ' +
  'editor_import_media に渡し、返った batchId を editor_import_runs で確認して、束が confirmed になった場合だけ完了とする。' +
  'confirmed は開いている編集画面に並んだ状態で、保存は画面の自動保存か人の保存で行われる。' +
  '未保存・人の入力中・競合時は現在状態を確認し直す。結果不明の操作を新しい operationId で再実行しない。' +
  'editor_apply の編集は saved を確認した場合だけ完了とし（動画の取り込みは束の confirmed で完了）、利用可能な操作で実現できない依頼や編集画面が未接続の場合は、' +
  '理由を伝えて failed とする。旧形式であることを確認できた案件だけ、従来どおり projectDir 配下の編集ファイルを扱う。';

/**
 * スライド作成の約束（文書と編集の約束は Claude・Codex・貼り付けで共通）。スライドの画面が依頼文に付けて送る。
 * 文言は docs/MCP接続マニュアル.md の 7 節と同文を維持する（agentPrompts.slides.test.ts が照合する）。
 */
export const SLIDES_REQUEST_WORKFLOW =
  'スライドの依頼は slides_ で始まる道具だけで行い、.harness の中のファイルを直接書き換えない。' +
  'まず slides_read に projectId を渡して、documentId・sessionId・revision・台本の段落（p1 など。' +
  '多いときは offset で続きを読む）・レイアウト 6 種の入力型と文字数の上限・generation（runId と各ページの状態）を確かめる。' +
  '構成案を頼まれたら、全段落をどれか 1 ページだけに入れた構成案（schema は harness-slides-outline/1、表記をそろえる用語表 glossary 付き）を作り、slides_validate（kind=outline）で確かめてから slides_apply_outline で渡す。' +
  '渡したら本文は作らず、人が画面で構成案を確かめるのを待つと伝えて完了にする。' +
  '本文を頼まれたら、generation.pages のうち pending と failed のページを 6 ページまでずつ、全体の構成案と用語表に合わせて harness-slides-page/1 で作り、slides_validate（kind=pages）→ slides_apply_pages の順で渡す。' +
  '強調したい語は fields の文字の中で **語** と書く（強調は 1 ページ 1〜2 語まで。3 語以上は直す対象になる）。' +
  '返った pages の rejected は issues の位置と理由に沿って直し、そのページだけを送り直す（修復は 1 ページにつき 2 回まで。' +
  'failed になったページは人に任せる）。' +
  '作り直し・短くするを頼まれたら、指定の key だけを regenerate=true で送る（人が手で直したページは置き換え案になり、人が採用したときだけ置き換わる）。' +
  '毎回新しい operationId を付ける。' +
  '応答が途切れたら同じ operationId と同じ内容で送り直すか slides_runs で結果を確かめ、結果が分からない操作を新しい operationId で送り直さない。' +
  'REVISION_CONFLICT・SESSION_CHANGED・RUN_STATE などが返ったら recovery に従う（多くは slides_read で読み直す）。' +
  '画像枠は、この端末で使える画像生成の手段があれば PNG を作って imageSlots[].file に絶対パスで渡す。' +
  '作れなければ prompt だけ書いて枠を空けたまま完成させる。';
export type SlidesRequestKind = 'outline' | 'pages' | 'regenerate' | 'shorten';
/** 画面のボタンの依頼文（短い 1 行）。手順は AI が editor_guide('slides') で読むので付けない。 */
export function slidesRequestText(kind: SlidesRequestKind, keys: readonly string[] = []): string {
  const pages = keys.join('・');
  const what = kind === 'outline' ? '構成案を作って'
    : kind === 'pages' ? (keys.length ? `ページ ${pages} の本文を作って` : '本文がまだのページを全部作って')
    : kind === 'regenerate' ? `ページ ${pages} を作り直して`
    : `ページ ${pages} の文字を短くして作り直して`;
  return `スライド: ${what}`;
}
/** 入力欄に貼る時に依頼番号を末尾に付ける（AI はこの番号で report_instruction_status を返す）。 */
export function withRequestNumber(text: string, id: string): string {
  return `${text}（依頼 #${id.replace(/^inst-/, '')}）`;
}
/** 環境別（Claude の AI タブ）。外部の MCP を読み込まない設定で動くので、画像生成は端末で使える手段があるときだけ。 */
export const SLIDES_CLAUDE_NOTE =
  'スライドの依頼（「スライド:」で始まる指示）は、指示文の手順どおり slides_ の道具で行う（subagent に任せてよい）。' +
  'この AI タブでは外部の MCP を読み込まないので、画像は端末で使える画像生成の手段があるときだけ作る。';
/** 環境別（Codex の AI タブ）。隔離した設定で動くので、画像は内蔵の画像生成が使えるときだけ。 */
export const SLIDES_CODEX_NOTE =
  'スライドの依頼（「スライド:」で始まる指示）は、指示文の手順どおり slides_ の道具で自分で行う。' +
  '画像は内蔵の画像生成が使えるときだけ PNG を作り、使えなければ枠を空けたまま完成させる。';

/** 全体待機・並列版。非推奨: AI タブは待機しない。別ターミナルで get_next_instruction を使う人のために 1 版残す。 */
export const AGENT_LOOP_PROMPT =
  'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら、その場では編集せず' +
  'バックグラウンドの subagent に委譲して、すぐ次の get_next_instruction を呼びに戻る。' +
  'subagent には次の編集手順と、元の指示 ID・projectId を渡す。' + EDITOR_REQUEST_WORKFLOW +
  '完了したら report_instruction_status を元の指示 ID に対して done（失敗なら failed）で一言返答する。' +
  'empty が返ったら再度呼んで待ち続ける。' + SLIDES_CLAUDE_NOTE;

/** 動画専属。非推奨（AGENT_LOOP_PROMPT と同じ理由で 1 版残す）。 */
export function dedicatedLoopPrompt(projectId: string): string {
  return (
    `sme-editor の get_next_instruction を projectId: ${JSON.stringify(projectId)} で呼んで編集指示を待つ。` +
    '指示が返ったら次の手順で編集する。' + EDITOR_REQUEST_WORKFLOW + '完了したら report_instruction_status を ' +
    'done / failed で一言返答する。empty が返ったら再度呼んで待ち続ける。'
  );
}

/**
 * 直列版。非推奨（AGENT_LOOP_PROMPT と同じ理由で 1 版残す）。
 * AGENT_LOOP_PROMPT は「バックグラウンドの subagent に委譲して並列で回す」前提の文面で
 * Claude Code の運用に寄っているため、指示を1件ずつ自分で片付けて次を取りに戻る形にする。
 */
export const SERIAL_LOOP_PROMPT =
  'sme-editor の get_next_instruction を呼んで編集指示を待つ。指示が返ったら次の手順で編集する。' +
  EDITOR_REQUEST_WORKFLOW + '完了したら ' +
  'report_instruction_status を done（失敗なら failed）で一言返答し、すぐ次の ' +
  'get_next_instruction を呼びに戻る。empty が返ったら再度呼んで待ち続ける。' + SLIDES_CODEX_NOTE;

/**
 * AI タブの土台: AI が最初に読む短い説明書。MCP の初期化時の説明（instructions）と最初の依頼の両方に入れる。
 * 安全に関わること（別の案件へ書かない）はサーバが TARGET_NOT_REQUESTED で守る。ここは案内だけ。
 * 文言は docs/MCP接続マニュアル.md の 0 節と同文を維持する（agentPrompts.slides.test.ts が照合する）。
 */
export const EDITOR_BRIEF =
  'このエディタ（Harness Editor）では、動画・スライド・サムネを MCP の sme-editor の道具で編集できる。' +
  '依頼を受けたら毎回、最初に editor_context を呼び、利用者が今見ている案件とモード、依頼した時点の案件を確かめる。' +
  'switchedSinceRequest が true なら、どちらの案件を直すか利用者に確かめてから進める。' +
  'screen が null なら推測で案件を決めず、案件を開いてもらう。' +
  'モード別の手順は editor_guide（mode に video・slides・thumbnail）で読む。' +
  '書き込みが TARGET_NOT_REQUESTED で断られたら、利用者に対象を確かめる。' +
  '依頼文の末尾に「（依頼 #番号）」がある依頼は、終わったら report_instruction_status に id（#番号）と結果（done か failed と一言）を返す。' +
  '返事は日本語で短く。';

/** サムネの AI の手順（editor_guide('thumbnail')）。設計の「AI の手順」。計画 1 の範囲。 */
export const THUMBNAIL_REQUEST_WORKFLOW =
  '1. 依頼文に「（依頼 #番号）」があればその番号が requestId。無ければ（端末に直接頼まれた）thumbnail_begin を呼ぶ。新しい案で案が 3 つなら、先に入れ替える案を利用者に聞いて replacePageId に入れる。直す時は pageId に editor_context の screen.target.pageId。' +
  'projectId は依頼を受けた時の editor_context の request.projectId を最後まで使う（利用者が別の案件を開いても変えない）。' +
  '2. thumbnail_read で今の案・依頼の対象・使える動画・字幕の行を読む。' +
  '3. 競合の調べ物と人物の切り抜きの道具はまだ無い。新しい案でも「競合を調べますか？」とは聞かない。切り抜きが「あり」の依頼は、まだ切り抜けないことを伝え、切り抜きなしで進めるか聞いて答えを待つ。' +
  '4. 字幕の行から見どころの秒を選び、thumbnail_frames で見て（path の画像を開く）背景のコマを決める。' +
  '5. 文字は感情のフックにする（検索語はタイトルに回す）。タイトル案も端末に 1 つ添え、サムネの文字と同じ言葉が無いことを確かめる。' +
  '6. ops で組む。種類は add-layer・update-layer・delete-layers・reorder-layer・set-layer-flags・rename-page・shift-page-hue だけ。pageId は 直す: 対象の案の ID、新しい案: "new"（案の追加・入れ替え・メインはサーバが行う）。' +
  'add-layer の layer は { id, name?, visual?: { position: { x, y }（中心原点・±1 が端）, scale, rotation, opacity }, content }。' +
  'content: 文字 { kind: "text", text, style: double-outline|white-red|band|shadow|black-white|neon, fontSize }、背景のコマ { kind: "video-frame", frameId }、' +
  '暗くする帯 { kind: "gradient", side: left|right|top|bottom, amount: 0〜1, color: "#000000" }、図形 { kind: "shape", shape: { kind: rect|ellipse|arrow|line, width, height, color, strokeWidth, cornerRadius, fill: null } }。' +
  'layers は先頭が最背面（背景のコマを最初に足す）。コマを別のコマに替える時は update-layer、種類の違う差し替えは delete-layers と add-layer。' +
  '7. thumbnail_preview で見て、文字の読みやすさ・はみ出し・顔への重なりを直す（見直しは 2 回まで）。' +
  '8. thumbnail_apply（baseRevision は thumbnail_read の document.revision）で 1 回だけ確定する。REVISION_CONFLICT なら読み直して新しい operationId で出し直す。TARGET_CHANGED・OUT_OF_REQUEST・PAGE_LIMIT は利用者に確かめる。応答が途切れたら thumbnail_runs。' +
  '確定の後にさらに直したい時は、利用者に「直す」で頼み直してもらう。' +
  '9. 「（依頼 #番号）」の依頼は report_instruction_status に結果を返す。';

/** editor_guide(mode) が返す詳しい手順。スライドの手順（SLIDES_REQUEST_WORKFLOW）はボタンの依頼文から外してここで渡す。 */
export function editorGuide(mode: AiMode): string {
  if (mode === 'slides') return 'スライド: projectId は editor_context の screen.projectId を使う。' + SLIDES_REQUEST_WORKFLOW;
  if (mode === 'thumbnail') return 'サムネ: ' + THUMBNAIL_REQUEST_WORKFLOW;
  return '動画: editor_context の screen.target.editorSessionId を editor_read・editor_validate・editor_apply・editor_import_media の sessionId に使う。' + EDITOR_REQUEST_WORKFLOW;
}

/** 起動の引数で 1 回だけ渡す最初の依頼。改行を入れない（端末の入力として 1 行で扱われるように）。 */
export function firstPrompt(screen: { projectName: string; mode: AiMode } | null): string {
  const label = screen ? `${screen.projectName}（${AI_MODE_LABEL[screen.mode]}）` : null;
  const where = label ? `利用者はいま「${label}」を開いている。` : '利用者はいまホーム（案件を開いていない画面）にいる。';
  const greeting = label ? `「${label}を見ています。何をしましょう？」` : '「ホームにいます。直したい案件を開いてから頼んでください。」';
  return `${EDITOR_BRIEF}${where}まだ何も編集しない。日本語 1 行で${greeting}とあいさつして、利用者の依頼を待つ。`;
}
