import { test, expect } from '@playwright/test';
import { textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { createThumbnailProject, openThumbnailMode, thumbnailState } from './thumbnailHelpers';

// 外から続けて 2 回書かれ、変更の通知が 2 回届く。1 回目の状態の取得（版 1）が、2 回目の取得（版 2）が出ている間に返っても、
// 画面は最後の版（2 つ目の文字が描かれた状態）まで追い付く。取得を重ねて先に返った方で後の方を捨てると、画面が版 1 のまま止まる。
test('変更の通知が続けて届いて状態の取得が重なっても、画面は最後の版まで追い付く', async ({ page, request }) => {
  test.setTimeout(60_000);
  const project = createThumbnailProject('e2e-thumb-refresh');
  const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
  const heldFirst = defer(), secondIssued = defer(), firstDone = defer();
  let calls = 0;
  try {
    await openThumbnailMode(page, project.id);
    const state = await thumbnailState(request, project.id), pageId = state.document.pages[0]!.id;
    // 1 回目の取得は、サーバの答え（版 1）を持ったまま、2 回目の取得が出るまで返さない。2 回目は 1 回目が返った後に返す。
    // （取得が重ならない作りなら 2 回目はまだ出ないので、1 回目は待ち時間で返す。）
    await page.route('**/api/thumbnail/session/status*', async route => {
      const index = ++calls, response = await route.fetch();
      if (index === 1) { heldFirst.resolve(); await Promise.race([secondIssued.promise, wait(1500)]); await route.fulfill({ response }); firstDone.resolve(); }
      else if (index === 2) { secondIssued.resolve(); await Promise.race([firstDone.promise, wait(3000)]); await route.fulfill({ response }); }
      else await route.fulfill({ response });
    });
    const first = await request.post(`/api/thumbnail/command?id=${project.id}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(),
      command: { type: 'add-layer', pageId, layer: textLayer('one', '一') } } });
    expect(first.ok(), await first.text()).toBe(true);
    await heldFirst.promise;
    const revision = (await first.json()).document.revision as number;
    const second = await request.post(`/api/thumbnail/command?id=${project.id}`, { data: { sessionId: state.sessionId, expectedRevision: revision, executionId: crypto.randomUUID(),
      command: { type: 'add-layer', pageId, layer: textLayer('two', '二') } } });
    expect(second.ok(), await second.text()).toBe(true);
    const frame = page.frameLocator('.native-thumbnail iframe[data-native-preview]');
    await expect(frame.locator('[data-native-clip="two"]')).toBeAttached({ timeout: 10_000 });
    await expect(frame.locator('[data-native-clip="one"]')).toBeAttached();
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
