import type { ReactNode } from 'react';

interface SubtitlePanelProps {
  /** 選択字幕の設定（SettingsTab）。文字起こしの隣に縦 1 列で表示する。 */
  settings: ReactNode;
}

/**
 * 字幕編集モードの設定側パネル。選択中の字幕の SettingsTab を、文字起こし（テキストベース編集）の
 * 右隣に全高で並べて表示する。字幕一覧・プレビュー・設定を同時に見ながら編集できる。
 */
export function SubtitlePanel({ settings }: SubtitlePanelProps) {
  return (
    <div className="subpanel">
      <div className="subpanel-head">字幕の設定</div>
      <div className="subpanel-body">{settings}</div>
    </div>
  );
}
