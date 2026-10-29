import { expect, test, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/app-shell-harness.html';

// The harness mocks the stores the shell reads. Requests the chat view or a
// dialog still makes are answered locally, so a backend behind the dev proxy
// (whose 401 sends the API client to /login) cannot influence the run.
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: 'not mocked' } }),
  );
});

async function openShell(
  page: Page,
  route: string,
  options: { billing?: boolean } = {},
) {
  const query = new URLSearchParams({ route });
  if (options.billing) query.set('billing', '1');
  await page.goto(`${HARNESS_PATH}?${query}`);
}

const routeProbe = (page: Page) => page.getByTestId('route');
const workspaceItem = (page: Page, folder: string) =>
  page.locator(`[data-phone-workspace="${folder}"]`);
const workspaceToggle = (page: Page, folder: string) =>
  workspaceItem(page, folder).locator('button[aria-expanded]').first();

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone navigation');

  test('the home is one list: workspace headers with their sessions under them', async ({
    page,
  }) => {
    await openShell(page, '/chat');
    // No bottom tab bar on phones.
    await expect(page.locator('.floating-nav')).toHaveCount(0);

    const sections = page.locator('[data-hc-phone-workspace-list] > section');
    await expect(sections.nth(0)).toHaveAttribute('aria-label', '已固定');
    await expect(sections.nth(0)).toContainText('Beta 工作区');
    await expect(sections.nth(1)).toHaveAttribute('aria-label', '主智能体');
    await expect(sections.nth(2)).toHaveAttribute('aria-label', '自定义智能体');

    // Sessions sit directly under their workspace, main conversation first.
    const alpha = workspaceItem(page, 'alpha');
    const rows = alpha.locator('ul > li');
    await expect(rows.nth(0)).toContainText('当前对话');
    await expect(rows.nth(1)).toContainText('alpha 会话 1');
    // Five sessions, then the rest behind 显示更多.
    await expect(
      alpha.getByRole('button', { name: '显示更多（2）' }),
    ).toBeVisible();
    await alpha.getByRole('button', { name: '显示更多（2）' }).click();
    await expect(
      alpha.getByText('alpha 会话 7', { exact: true }),
    ).toBeVisible();

    // Geometry and type after cindy's list: 56px headers, 78px rows.
    const header = workspaceToggle(page, 'alpha').locator('..');
    expect((await header.boundingBox())!.height).toBe(56);
    const row = rows.nth(1).locator('> div');
    expect((await row.boundingBox())!.height).toBe(78);
    const title = rows
      .nth(1)
      .getByRole('button', { name: 'alpha 会话 1', exact: true });
    const titleStyle = await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(titleStyle).toEqual(['18px', '28px', '500']);
    const preview = rows.nth(1).getByText(/的最后一条消息/);
    const previewStyle = await preview.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.whiteSpace];
    });
    expect(previewStyle).toEqual(['15px', '26px', 'nowrap']);
    // The time sits at the top right, on the title's line.
    const time = rows.nth(1).getByText('3 分钟前');
    const timeBox = (await time.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    expect(timeBox.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);
    expect(
      Math.abs(
        timeBox.y + timeBox.height / 2 - (titleBox.y + titleBox.height / 2),
      ),
    ).toBeLessThan(4);

    // The store counts unread replies per workspace: the dot is on its header.
    await expect(
      alpha.getByRole('img', { name: '2 条未读回复' }),
    ).toBeVisible();
    await expect(
      workspaceItem(page, 'beta').getByRole('img', { name: /未读回复/ }),
    ).toHaveCount(0);
  });

  test('a collapsed workspace stays collapsed after a reload', async ({
    page,
  }) => {
    await openShell(page, '/chat');
    const toggle = workspaceToggle(page, 'beta');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('beta 会话 1', { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(workspaceToggle(page, 'beta')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByText('beta 会话 1', { exact: true })).toHaveCount(0);
    await expect(workspaceToggle(page, 'alpha')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  test('a session opens from its row and the chat’s back returns to the list', async ({
    page,
  }) => {
    await openShell(page, '/chat');
    await page
      .getByRole('button', { name: 'alpha 会话 1', exact: true })
      .click();
    await expect(routeProbe(page)).toHaveText('/chat/alpha?agent=alpha-s1');
    await expect(page.locator('[data-hc-phone-home]')).toHaveCount(0);

    // The chat's back used to open the session list (?sessions=1); on a
    // phone that level is the home list with the workspace open.
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(routeProbe(page)).toHaveText('/chat');
    await expect(page.locator('[data-hc-session-sidebar]')).toHaveCount(0);
    await expect(workspaceToggle(page, 'alpha')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  test('the ?sessions=1 deep link opens the list with that workspace expanded', async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        'happyclaw:sidebar-expanded-workspaces:v2',
        JSON.stringify({ 'web:bill2': false }),
      ),
    );
    await openShell(page, '/chat/bill2?sessions=1');
    await expect(routeProbe(page)).toHaveText('/chat');
    await expect(workspaceToggle(page, 'bill2')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(workspaceItem(page, 'bill2')).toBeInViewport();
    await expect(page.getByText('bill2 会话 1', { exact: true })).toBeVisible();
    // ChatView's own session list never shows on a phone.
    await expect(page.locator('[data-hc-session-sidebar]')).toHaveCount(0);

    // Other chat deep links still open the chat.
    await openShell(page, '/chat/beta?agent=beta-s2');
    await expect(routeProbe(page)).toHaveText('/chat/beta?agent=beta-s2');
    await expect(page.locator('[data-hc-phone-home]')).toHaveCount(0);
  });

  test('the new-conversation button starts one in the home workspace', async ({
    page,
  }) => {
    await openShell(page, '/chat');
    const fab = page.getByRole('button', { name: '新对话', exact: true });
    const box = (await fab.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBe(55);
    expect(box.height).toBe(55);
    expect(viewport.width - (box.x + box.width)).toBe(16);
    expect(viewport.height - (box.y + box.height)).toBe(8);

    // Even after visiting another workspace, it targets the home one.
    await page
      .getByRole('button', { name: 'alpha 会话 2', exact: true })
      .click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(routeProbe(page)).toHaveText('/chat');
    const workspaces = await page.locator('[data-phone-workspace]').count();

    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(routeProbe(page)).toHaveText('/chat/main?agent=main-new');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    // A conversation, not a workspace.
    await expect(page.locator('[data-phone-workspace]')).toHaveCount(
      workspaces,
    );
  });

  test('the press feedback and drawer follow reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShell(page, '/chat');
    const fab = page.getByRole('button', { name: '新对话', exact: true });
    expect(
      await fab.evaluate(
        (element) => getComputedStyle(element).transitionProperty,
      ),
    ).toBe('none');
    await page.getByRole('button', { name: '打开菜单' }).click();
    const drawer = page.getByTestId('nav-drawer');
    await expect(drawer).toBeVisible();
    expect(
      await drawer.evaluate((element) => element.getAnimations().length),
    ).toBe(0);
  });

  test('every page is two taps away through the drawer', async ({ page }) => {
    await openShell(page, '/chat', { billing: true });
    const pages = [
      ['智能体', '/agent-profiles'],
      ['能力库', '/capabilities'],
      ['自动化', '/automations'],
      ['用量', '/usage'],
      ['记忆', '/memory'],
      ['账单', '/billing'],
      ['设置', '/settings'],
      ['工作台', '/chat'],
    ] as const;
    for (const [label, path] of pages) {
      await page.getByRole('button', { name: '打开菜单' }).click();
      const drawer = page.getByTestId('nav-drawer');
      await drawer
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: label, exact: true })
        .click();
      await expect(routeProbe(page)).toHaveText(path);
      await expect(drawer).toHaveCount(0);
    }
  });

  test('the drawer holds search, new conversation and the account', async ({
    page,
  }) => {
    await openShell(page, '/automations');
    await page.getByRole('button', { name: '打开菜单' }).click();
    const drawer = page.getByTestId('nav-drawer');
    const nav = drawer.getByRole('navigation', { name: '主导航' });
    // Billing is off: no 账单, as in the desktop sidebar.
    await expect(nav.getByRole('link')).toHaveText([
      '工作台',
      '智能体',
      '能力库',
      '自动化',
      '用量',
      '记忆',
      '设置',
    ]);
    await expect(nav.getByRole('link', { name: '自动化' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await drawer.getByRole('button', { name: '账户菜单' }).click();
    await expect(
      page.getByRole('menuitem', { name: '个人设置' }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: '退出登录' }),
    ).toBeVisible();
    await page.getByRole('menuitem', { name: '个人设置' }).click();
    await expect(routeProbe(page)).toHaveText('/settings?tab=profile');
    await expect(drawer).toHaveCount(0);

    await page.getByRole('button', { name: '打开菜单' }).click();
    await page
      .getByTestId('nav-drawer')
      .getByRole('button', { name: '搜索' })
      .click();
    await expect(
      page.getByPlaceholder('搜索页面、工作区、会话或操作…'),
    ).toBeVisible();
    await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
  });

  test('pages put the hamburger in a top bar; Settings keeps one bar', async ({
    page,
  }) => {
    await openShell(page, '/automations');
    const bar = page.getByTestId('phone-top-bar');
    await expect(bar.getByRole('button', { name: '打开菜单' })).toBeVisible();
    // The page's own heading names it, right under the bar.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '页面 /automations',
    );

    await openShell(page, '/settings?tab=profile');
    await expect(page.getByTestId('phone-top-bar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(1);
    await page.getByRole('button', { name: '设置分区' }).click();
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
  });

  test('a settings save bar sits on the bottom edge without a tab bar', async ({
    page,
  }) => {
    await openShell(page, '/save-bar');
    const bar = page.locator('[data-slot="settings-sticky-save-bar"]');
    await expect(bar).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    // Only the 56px row: no room is left for a tab bar under it.
    expect(Math.round(box.height)).toBe(57);
  });

  test('row menus keep create, rename, delete and binding', async ({
    page,
  }) => {
    await openShell(page, '/chat');
    const beta = workspaceItem(page, 'beta');

    await beta.getByRole('button', { name: 'Beta 工作区的更多操作' }).click();
    await page.getByRole('menuitem', { name: '新建会话' }).click();
    await expect(routeProbe(page)).toHaveText('/chat/beta?agent=beta-new');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(routeProbe(page)).toHaveText('/chat');

    await beta.getByRole('button', { name: 'beta 会话 1的更多操作' }).click();
    await page.getByRole('menuitem', { name: '重命名' }).click();
    const dialog = page.getByRole('dialog', { name: '重命名对话' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();

    await beta.getByRole('button', { name: 'beta 会话 1的更多操作' }).click();
    await page.getByRole('menuitem', { name: '删除' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '删除' })
      .click();
    await expect(beta.getByText('beta 会话 1', { exact: true })).toHaveCount(0);

    await beta.getByRole('button', { name: 'beta 会话 2的更多操作' }).click();
    await page.getByRole('menuitem', { name: '会话绑定' }).click();
    await expect(page.getByRole('dialog', { name: /绑定/ })).toBeVisible();
    await expect(routeProbe(page)).toHaveText('/chat');
  });
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout guard');

  test('a desktop window keeps the sidebar and no phone chrome', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openShell(page, '/chat/alpha');
    const sidebar = page.getByRole('navigation', { name: '主导航' });
    await expect(sidebar).toBeVisible();
    expect((await sidebar.boundingBox())!.width).toBe(256);
    await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(0);
    await expect(page.getByTestId('phone-top-bar')).toHaveCount(0);
    await expect(page.locator('[data-hc-phone-home]')).toHaveCount(0);
    await expect(page.locator('.floating-nav')).toBeHidden();
    // The canvas floats 8px inside the shell, right of the sidebar.
    const canvas = page.locator('main[data-app-scroll-root]').locator('..');
    expect(await canvas.boundingBox()).toEqual({
      x: 256,
      y: 8,
      width: 1280 - 256 - 8,
      height: 800 - 16,
    });

    await openShell(page, '/settings?tab=profile');
    await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '设置分区' })).toHaveCount(0);
  });

  test('a narrow desktop window keeps the tab bar and the session list level', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await openShell(page, '/chat');
    const tabs = page.locator('.floating-nav a');
    await expect(tabs).toHaveText([
      '工作台',
      '智能体',
      '能力库',
      '自动化',
      '设置',
    ]);
    await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新对话' })).toHaveCount(0);
    await expect(page.locator('[data-hc-phone-home]')).toHaveCount(0);
    // The workspace list opens a workspace's session list, as before.
    await page
      .getByRole('button', { name: 'Alpha 工作区', exact: true })
      .click();
    await expect(routeProbe(page)).toHaveText('/chat/alpha?sessions=1');
    await expect(page.locator('[data-hc-session-sidebar]')).toBeVisible();

    // The settings header keeps its section menu on the left.
    await openShell(page, '/settings?tab=profile');
    await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
    await expect(page.getByRole('button', { name: '设置分区' })).toHaveCount(0);

    // The save bar still extends behind the tab bar.
    await openShell(page, '/save-bar');
    const bar = page.locator('[data-slot="settings-sticky-save-bar"]');
    await expect(bar).toBeAttached();
    expect(
      await bar.evaluate((element) => getComputedStyle(element).paddingBottom),
    ).toBe('90px');
  });
});
