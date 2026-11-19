import { expect, it } from 'vitest';
import { buildDraft, githubIssueUrl, mailtoUrl, prepareFeedbackText } from './feedbackDraft';
import { FEEDBACK_EMAIL, FEEDBACK_GITHUB_REPO } from './feedbackTarget';

it('keeps fixed context and removes sensitive fragments from the default draft', () => {
  const errorText = '試験案件 /Users/home/Private library/素材.mov\nC:\\Users\\home\\photo.png\n~/秘密.txt\nname@example.test\n0123456789abcdefghijklmnop\x00';
  const {body} = buildDraft({comment:'止まりました',appVersion:'0.8.0',os:'macOS 15',screen:'edit',errorText,projectName:'試験案件'});
  expect(body).toContain('止まりました');
  expect(body).toContain('0.8.0');
  expect(body).toContain('macOS 15');
  expect(body).toContain('編集');
  expect(body.match(/（伏せました）/g)).toHaveLength(6);
  for(const secret of ['試験案件','home','Private library','素材.mov','photo.png','秘密.txt','name@','abcdefghijklmnop','\x00'])expect(body).not.toContain(secret);
});

it('keeps all the text for copying but caps the external draft in Unicode characters', () => {
  const draft = prepareFeedbackText('😀'.repeat(1510));
  expect([...draft.body]).toHaveLength(1510);
  expect([...draft.linkBody]).toHaveLength(1500);
  expect(draft.linkBody.endsWith('…')).toBe(true);
  expect(draft.truncated).toBe(true);
});

it('encodes editable text and rejects absent or malformed destinations', () => {
  const title = '報告 #1&2', body = '画面 & 編集\n例 #1';
  const mail = new URL(mailtoUrl('owner@example.test',title,body)!);
  expect(mail.pathname).toBe('owner@example.test');
  expect(mail.searchParams.get('subject')).toBe(title);
  expect(mail.searchParams.get('body')).toBe(body);
  const github = new URL(githubIssueUrl('example/project',title,body)!);
  expect(github.origin+github.pathname).toBe('https://github.com/example/project/issues/new');
  expect(github.searchParams.get('title')).toBe(title);
  expect(github.searchParams.get('body')).toBe(body);
  expect(FEEDBACK_EMAIL).toBe('feedback@video-harness.app');
  expect(new URL(mailtoUrl(FEEDBACK_EMAIL,title,body)!).pathname).toBe(FEEDBACK_EMAIL);
  expect(mailtoUrl('',title,body)).toBeNull();
  expect(githubIssueUrl(FEEDBACK_GITHUB_REPO,title,body)).toBeNull();
  expect(mailtoUrl('a@example.test?bcc=b@example.test',title,body)).toBeNull();
  expect(githubIssueUrl('../example',title,body)).toBeNull();
});

it.each([
  ['読めません/Users/alice/Movies/a.mov', 'alice', 'Movies', 'a.mov'],
  ['Users/alice/Movies/ゴルフ 練習.mkv', 'alice', 'Movies', 'ゴルフ 練習'],
  ['~alice/x', 'alice'],
  ['読めません（~alice）、利用者を確認', 'alice'],
  ['ファイルの場所は $HOME。確認できません', '$HOME'],
  ['テロップ「1行目の内緒\n2行目の内緒」を描けません', '1行目の内緒', '2行目の内緒'],
  ['$HOME/Movies/p', '$HOME', 'Movies'],
  [String.raw`%USERPROFILE%\Videos\a.m4v`, 'USERPROFILE', 'Videos', 'a.m4v'],
  ['素材「swing01」が見つかりません', 'swing01'],
  ['テロップ「今日は晴れです」を描けません', '今日は晴れです'],
  ['台本『ここから内緒です』の取得に失敗', 'ここから内緒です'],
])('伏せ漏れを防ぐ (%s)', (errorText, ...secrets) => {
  const {body} = buildDraft({screen:'edit',errorText});
  expect(body).toContain('（伏せました）');
  for (const secret of secrets) expect(body).not.toContain(secret);
});

it.each(['mkv','avi','m4v','gif','flac','ogg','csv','ass'])('素材名の拡張子を広く扱う (%s)', extension => {
  const {body} = buildDraft({screen:'edit',errorText:`開けません: sunset clip.${extension}`});
  expect(body).not.toContain('sunset clip');
});
it('経路の後に続くエラー理由を残す', () => {
  expect(buildDraft({screen:'export',errorText:'ffmpeg: /Users/alice/My Movies/x.mov: No such file'}).body)
    .toContain('ffmpeg: （伏せました）: No such file');
});
it('案件名の大小文字を区別せず、短い名前を別の単語の途中では置き換えない', () => {
  const result = buildDraft({screen:'edit',projectName:'Go',errorText:'Go / go / good / GOAL'});
  expect(result.body).toContain('（伏せました）');
  expect(result.body).not.toMatch(/\bgo\b/i);
  expect(result.body).toContain('GOAL');
  expect(result.body).toContain('good');
});
it('メールの URL は 2000 文字以内で文字を分断せず、コピーは全文を使う', () => {
  const body = '😀'.repeat(1490);
  const url = mailtoUrl('owner@example.test', 'ご意見', body)!;
  expect(url.length).toBeLessThanOrEqual(2000);
  const decoded = new URL(url).searchParams.get('body')!;
  expect(decoded).toMatch(/^(?:😀)+…$/u);
  expect(prepareFeedbackText(body).body).toBe(body);
});

it.each([
  ['jobs/tanaka-taro/raw: not found', 'jobs', 'tanaka', 'raw'],
  ['cwd: ./jobs/案件A', 'jobs', '案件A'],
  ['読めません ../jobs/田中太郎/a', 'jobs', '田中太郎'],
  ['USER=bob LOGNAME=bob', 'bob'],
  ['env USERNAME=bob HOME=bob PWD=bob', 'bob'],
  ['HOME=/Users/bob/My Movies', 'bob', 'Movies'],
  ['user: bob', 'bob'],
  ['token ghp_abcdefghijklmnop', 'abcdefghijklmnop'],
  ['key sk-abc123 と gho_short1 と github_pat_abc と xoxb-123-abc', 'abc123', 'short1', 'github_pat_abc', 'xoxb'],
  ['project 田中太郎_ゴルフ を開けません', '田中太郎'],
  ['案件: 田中太郎_ゴルフ', '田中太郎'],
])('相対のパス・環境変数・短い鍵・案件名を伏せる (%s)', (errorText, ...secrets) => {
  const {body} = buildDraft({screen:'edit',errorText});
  expect(body).toContain('（伏せました）');
  for (const secret of secrets) expect(body).not.toContain(secret);
});

it.each([
  ['エラー: 書き出しに失敗', 'エラー: 書き出しに失敗'],
  ['3/4 まで進んだ', '3/4 まで進んだ'],
  ['2026/11/19 に失敗しました', '2026/11/19 に失敗しました'],
  ['project failed to load', 'project failed to load'],
])('普通の文は伏せ過ぎない (%s)', (errorText, expected) => {
  expect(buildDraft({screen:'export',errorText}).body).toContain(expected);
});
it('URL だけを伏せ、前後の文は残す', () => {
  const {body} = buildDraft({screen:'export',errorText:'取得に失敗 http://localhost:3000/api を確認'});
  expect(body).toContain('取得に失敗 （伏せました） を確認');
});
