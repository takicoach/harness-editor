// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiFocusView } from '../../shared/aiFocus';
import { AiFocusBar, aiFocusBarText } from './AiFocusBar';

const view = (over: Partial<AiFocusView> = {}): AiFocusView => ({
  primary: { pageId: 'page-aaaa', updatedAt: 1, screen: { projectId: 'a', projectName: '10月の講義', mode: 'thumbnail', target: null, playheadSec: null, selection: [], materials: '' } },
  request: null, lastRead: null, ...over });
afterEach(cleanup);

describe('AI タブ上部の表示', () => {
  it('画面と AI の確認を分けて出し、AI がまだ読んでいなければそう書く', () => {
    expect(aiFocusBarText(view())).toEqual({ screen: '画面: 10月の講義／サムネ', read: 'AI はまだ画面を確認していません', stale: false });
  });
  it('AI が最後に確認した画面を出す。今の画面と違えば stale', () => {
    const same = aiFocusBarText(view({ lastRead: { projectId: 'a', projectName: '10月の講義', mode: 'thumbnail', at: Date.UTC(2026, 9, 8, 3, 4) } }));
    expect(same.read).toMatch(/^AI が最後に確認: 10月の講義／サムネ（\d{1,2}:\d{2}）$/);
    expect(same.stale).toBe(false);
    expect(aiFocusBarText(view({ lastRead: { projectId: 'a', projectName: '10月の講義', mode: 'video', at: 0 } })).stale).toBe(true);
  });
  it('主画面が無い・ホーム', () => {
    expect(aiFocusBarText(null).screen).toBe('画面: AI タブを開いている画面がありません');
    expect(aiFocusBarText(view({ primary: { pageId: 'p', updatedAt: 1, screen: null } })).screen).toBe('画面: ホーム');
  });
  it('画面が変わった後は「次の依頼で AI が確かめます」と添える', () => {
    render(<AiFocusBar view={view({ lastRead: { projectId: 'a', projectName: '10月の講義', mode: 'video', at: 0 } })} />);
    expect(screen.getByLabelText('AI が見ている画面').textContent).toContain('次の依頼で AI が確かめます');
  });
});
