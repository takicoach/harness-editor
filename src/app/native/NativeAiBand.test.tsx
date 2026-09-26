/** @vitest-environment jsdom */
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeAiBand} from './NativeAiBand';

afterEach(cleanup);

it('閉じているときは「✦ AI で編集する」で、押すと開く',()=>{
  const onOpen=vi.fn(),onBack=vi.fn();
  const view=render(<NativeAiBand open={false} disabled={false} onOpen={onOpen} onBack={onBack}/>);
  const button=view.getByRole('button',{name:'✦ AI で編集する'});
  expect(button.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledTimes(1);expect(onBack).not.toHaveBeenCalled();
});
it('開いているときは「編集画面に戻る」で、押すと直前のタブへ戻す',()=>{
  const onBack=vi.fn();
  const view=render(<NativeAiBand open disabled={false} onOpen={vi.fn()} onBack={onBack}/>);
  const button=view.getByRole('button',{name:'編集画面に戻る'});
  expect(button.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(button);
  expect(onBack).toHaveBeenCalledTimes(1);
});
it('帯の見出しを持ち、aria-controls は付けない',()=>{
  const view=render(<NativeAiBand open={false} disabled={false} onOpen={vi.fn()} onBack={vi.fn()}/>);
  expect(view.container.querySelector('.native-ai-band')!.textContent).toContain('AI に頼む');
  expect(view.getByRole('button',{name:'✦ AI で編集する'}).getAttribute('aria-controls')).toBeNull();
});
it('busy の間は押せない',()=>{
  const view=render(<NativeAiBand open={false} disabled onOpen={vi.fn()} onBack={vi.fn()}/>);
  expect((view.getByRole('button',{name:'✦ AI で編集する'}) as HTMLButtonElement).disabled).toBe(true);
});

const workspace=readFileSync('src/app/native/NativeWorkspace.tsx','utf8');
it('DOCK_TABS は 3 件で、AI 表示中はタブへ null を渡す',()=>{
  expect(workspace).not.toContain("{value:'ai',label:'AI',controls:'native-panel-ai'}");
  expect(workspace).toContain("value={rightTab==='ai'?null:rightTab}");
  expect(workspace).toContain('native-panel-ai');
});

it('Task 8b: 帯そのものが button で、aria-label が状態で切り替わる',()=>{
  const view=render(<NativeAiBand open={false} disabled={false} onOpen={vi.fn()} onBack={vi.fn()}/>);
  const closedBand=view.container.querySelector('.native-ai-band')!;
  expect(closedBand.tagName).toBe('BUTTON');
  expect(closedBand.getAttribute('aria-label')).toBe('✦ AI で編集する');
  view.rerender(<NativeAiBand open disabled={false} onOpen={vi.fn()} onBack={vi.fn()}/>);
  expect(view.container.querySelector('.native-ai-band')!.getAttribute('aria-label')).toBe('編集画面に戻る');
});

const restorationCss=readFileSync('src/app/native/native-restoration.css','utf8');
it('Task 8b: キラキラの keyframes と、開いた時／reduced-motion での停止規則が CSS にある',()=>{
  expect(restorationCss).toMatch(/@keyframes native-ai-twinkle\s*\{/);
  expect(restorationCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.native-ai-band-star\s*\{animation:none/);
});

it('修正ラウンド1: 帯専用の :focus-visible 規則がある',()=>{
  expect(restorationCss).toMatch(/\.native-ai-band:focus-visible\s*\{/);
});

it('Task 8c: sheen は廃止され、開いた「[」型のアクセント線も無い',()=>{
  expect(restorationCss).not.toMatch(/native-ai-sheen/);
  const openRule=restorationCss.match(/\.native-ai-band\[aria-expanded="true"\]\s*\{[^}]*\}/)?.[0]??'';
  expect(openRule).not.toContain('border-left');
});

it('Task 8c: 開いた状態でも星の animation は止まっていない（reduced-motion では止まる）',()=>{
  const openStarRule=restorationCss.match(/\.native-ai-band\[aria-expanded="true"\]\s+\.native-ai-band-star\s*\{[^}]*\}/)?.[0]??'';
  expect(openStarRule).not.toBe('');
  expect(openStarRule).not.toContain('animation:none');
  const reducedRule=restorationCss.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\}\s*\}/)?.[0]??'';
  expect(reducedRule).toMatch(/\.native-ai-band-star\s*\{animation:none/);
});

it('Task 8c: 帯の中に星が5つある',()=>{
  const view=render(<NativeAiBand open={false} disabled={false} onOpen={vi.fn()} onBack={vi.fn()}/>);
  expect(view.container.querySelectorAll('.native-ai-band-star').length).toBe(5);
});
