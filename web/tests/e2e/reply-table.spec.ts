import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/chat-render-harness.html';

/** The transcript's Markdown reply, once its lazy pipelines have loaded. */
async function openMarkdown(page: import('@playwright/test').Page) {
  await page.goto(`${HARNESS_PATH}?scenario=markdown`);
  const sink = page
    .locator('.group', { has: page.locator('h1', { hasText: '一级标题' }) })
    .first();
  await expect(sink.locator('h2', { hasText: '代码' })).toBeVisible();
  await expect(page.locator('[data-markdown-pending]')).toHaveCount(0);
  return sink;
}

test.describe('reply tables', () => {
  test('copy as spreadsheet cells, save as CSV, and a pinned first column on a phone', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const sink = await openMarkdown(page);
    const block = sink.locator('[data-md-table]', { hasText: '窄 selector' });
    const tools = block.locator('[data-md-table-tools]');
    // Hidden until the table is hovered or a tool has focus; always shown to touch.
    const copyButton = tools.getByRole('button', { name: /复制表格/ });
    if (page.viewportSize()!.width >= 640) {
      await expect(tools).toHaveCSS('opacity', '0');
      await copyButton.focus();
    }
    await expect(tools).toHaveCSS('opacity', '1');

    await tools.getByRole('button', { name: /复制表格/ }).click();
    await expect(tools).toContainText('已复制');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const header = (await block.locator('th').allTextContents()).map((h) =>
      h.trim(),
    );
    expect(copied.split('\n')[0]).toBe(header.join('\t'));
    const row = (
      await block
        .locator('tr', { hasText: '窄 selector' })
        .locator('td')
        .allTextContents()
    ).map((cell) => cell.trim());
    expect(copied).toContain(row.join('\t'));

    const downloading = page.waitForEvent('download');
    await tools.getByRole('button', { name: '下载为 CSV' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^表格-\d{8}-\d{4}\.csv$/);
    const csv = await (await download.createReadStream())
      .toArray()
      .then((chunks) => Buffer.concat(chunks).toString('utf8'));
    expect(csv.startsWith(`\ufeff${header.join(',')}\r\n`)).toBe(true);

    const first = block.locator('td').first();
    const narrow = page.viewportSize()!.width < 640;
    await expect(first).toHaveCSS('position', narrow ? 'sticky' : 'static');
  });

  test('a streaming table holds its tools hidden until the reply settles', async ({
    page,
  }) => {
    await page.goto(`${HARNESS_PATH}?scenario=markdown-streaming&cut=table`);
    // The transcript's settled copy of the table comes first; the streaming
    // reply's is the last on the page.
    const live = page
      .locator('[data-md-table]', { hasText: '列 1 Column' })
      .last();
    await expect(live).toBeVisible();
    await expect(live.locator('[data-md-table-tools]')).toBeHidden();
  });
});
