export const FEEDBACK_TITLE = 'Harness Editor へのご意見・不具合報告';
export const FEEDBACK_LINK_LIMIT = 1500;

const SCREEN_LABELS = { home:'ホーム', edit:'編集', export:'書き出し', other:'その他' } as const;
export type FeedbackScreen = keyof typeof SCREEN_LABELS;
const MASK = '（伏せました）';

export interface FeedbackDraftInput {
  screen: FeedbackScreen;
  appVersion?: string;
  os?: string;
  comment?: string;
  errorText?: string;
  projectName?: string;
}

export type FeedbackEnvironment = Pick<FeedbackDraftInput,'appVersion'|'os'>;

function cleanText(value: string): string {
  return value.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g,'')
    .replace(/[\uD800-\uDFFF]/gu,'\uFFFD');
}

function redactDiagnostic(value: string, projectName?: string): string {
  const safe = cleanText(value)
    .replace(/「[^」]*(?:」|$)|『[^』]*(?:』|$)/gu,MASK)
    .replace(/(?:(?:ユーザー名|素材名|台本|テロップ|字幕)\s*[:：][^\n]*)/g,MASK)
    .replace(/\b(?:https?|file):\/\/[^\s、。〕」』"'<>]+/gi,MASK)
    // Keep a diagnostic after ": " even when the path contains spaces. Match a slash next to Japanese text too.
    // A relative path (./x, ../x) goes whole, including the leading dot.
    .replace(/(?<![\p{L}\p{N}_])\.{1,2}[\\/](?:(?!:\s)[^\n"'<>\[\]()、。〕」』])*/gu,MASK)
    // A slash right after a letter or digit is a relative path (handled below), not an absolute one.
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|(?:\$HOME|\$\{HOME\}|%[\w]+%|~[\w.-]*)[\\/]|\bUsers[\\/]|(?<![A-Za-z0-9_.-])\/(?![\s、。]))(?:(?!:\s)[^\n"'<>\[\]()、。〕」』])*/giu,MASK)
    // jobs/x/raw: the whole thing goes. Dates and fractions (3/4, 2026/11/19) start with a digit and stay.
    .replace(/(?<![\p{L}\p{N}_.-])(?!\d+[\\/])[\p{L}\p{N}_.-]+(?:[\\/][^\s\\/:"'<>\[\]()、。〕」』]+)+/gu,MASK)
    .replace(/\b(?:USER|LOGNAME|USERNAME|HOME|PWD)\s*=\s*[^\s,;]+/g,MASK)
    .replace(/\b(?:user(?:name)?|login)\s*[:：]\s*[^\s,;、。]+/gi,MASK)
    .replace(/(?:\bproject(?:\s*name)?|案件名?|プロジェクト名?)\s*[:：=]\s*[^\s,;、。]+/giu,MASK)
    .replace(/\bproject\s+(?=[^\s、。,;]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[^\s、。,;]+/giu,MASK)
    // Tokens with a well-known prefix go whatever their length.
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[bapors]-[A-Za-z0-9-]+)/g,MASK)
    .replace(/(?:\$HOME|\$\{HOME\}|%USERPROFILE%|~[\w.-]+)(?![\w.-])/giu,MASK)
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g,MASK)
    .replace(/[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.[A-Za-z0-9]{2,6}\b/gu,MASK)
    .replace(/[A-Za-z0-9_+/=.-]{24,}/g,MASK);
  const name = projectName ? cleanText(projectName).trim() : '';
  if (!name) return safe;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return safe.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'giu'),MASK);
}

export function prepareFeedbackText(value: string) {
  const body = cleanText(value);
  const characters = [...body];
  const truncated = characters.length > FEEDBACK_LINK_LIMIT;
  const linkBody = truncated ? characters.slice(0, FEEDBACK_LINK_LIMIT - 1).join('') + '…' : body;
  return {body, linkBody, truncated};
}

export function buildDraft({comment, appVersion, os, screen, errorText, projectName}: FeedbackDraftInput) {
  const error = errorText ? redactDiagnostic(errorText,projectName).trim() : '';
  return prepareFeedbackText([
    comment?.trim(),
    `アプリの版：${appVersion || '不明'}\nOS：${os || '不明'}\n画面：${SCREEN_LABELS[screen]}`,
    error ? `お知らせ：\n${error}` : undefined,
  ].filter(Boolean).join('\n\n'));
}

export function mailtoUrl(email: string, title: string, body: string): string | null {
  if (!/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(email)) return null;
  const prefix = `mailto:${email}?subject=${encodeURIComponent(cleanText(title).replace(/[\n\u2028\u2029]/g,' '))}&body=`;
  const limit = 2000;
  const {linkBody} = prepareFeedbackText(body);
  const encoded = encodeURIComponent(linkBody);
  if (prefix.length + encoded.length <= limit) return prefix + encoded;

  const ellipsis = encodeURIComponent('…');
  const budget = limit - prefix.length - ellipsis.length;
  if (budget < 0) return null;
  let fragment = '';
  for (const character of linkBody) {
    const next = encodeURIComponent(character);
    if (fragment.length + next.length > budget) break;
    fragment += next;
  }
  return prefix + fragment + ellipsis;
}

export function githubIssueUrl(repository: string, title: string, body: string): string | null {
  if (!/^[\w-]+\/[\w-][\w.-]*$/.test(repository)) return null;
  return `https://github.com/${repository}/issues/new?title=${encodeURIComponent(cleanText(title))}&body=${encodeURIComponent(prepareFeedbackText(body).linkBody)}`;
}
