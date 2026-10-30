import { expect, test, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/touch-primitives-harness.html';

/** The test id of whatever element a tap at (x, y) would land on. */
function hitAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) =>
      document
        .elementFromPoint(px, py)
        ?.closest('[data-testid]')
        ?.getAttribute('data-testid') ?? null,
    [x, y],
  );
}

async function box(page: Page, testId: string) {
  const rect = await page.getByTestId(testId).boundingBox();
  if (!rect) throw new Error(`${testId} is not rendered`);
  return rect;
}

const computed = (page: Page, testId: string, property: string) =>
  page
    .getByTestId(testId)
    .evaluate(
      (node, prop) => getComputedStyle(node).getPropertyValue(prop),
      property,
    );

test.describe('on a phone (Pixel 7)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS_PATH);
  });

  test('an icon-sm button keeps its 28px face but takes taps over 44×44', async ({
    page,
  }) => {
    const b = await box(page, 'single');
    expect(b.width).toBe(28);
    expect(b.height).toBe(28);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // 8px outside the visible box on every side still hits the button.
    expect(await hitAt(page, b.x - 8, cy)).toBe('single');
    expect(await hitAt(page, b.x + b.width + 7.5, cy)).toBe('single');
    expect(await hitAt(page, cx, b.y - 8)).toBe('single');
    expect(await hitAt(page, cx, b.y + b.height + 7.5)).toBe('single');
    expect(await hitAt(page, b.x - 10, cy)).toBeNull();
  });

  test('hitSlop={false} keeps the hit area to the visible box', async ({
    page,
  }) => {
    const b = await box(page, 'no-slop');
    expect(await hitAt(page, b.x + 1, b.y + b.height / 2)).toBe('no-slop');
    expect(await hitAt(page, b.x - 4, b.y + b.height / 2)).toBeNull();
  });

  test('neighbouring buttons never steal taps from each other’s face', async ({
    page,
  }) => {
    const left = await box(page, 'left');
    const right = await box(page, 'right');
    const cy = left.y + left.height / 2;
    expect(await hitAt(page, left.x + left.width - 0.5, cy)).toBe('left');
    expect(await hitAt(page, right.x + 0.5, cy)).toBe('right');
    // The gap between them belongs to the left one, which reaches over it.
    expect(await hitAt(page, right.x - 1, cy)).toBe('left');
    // The outer edges still extend.
    expect(await hitAt(page, left.x - 8, cy)).toBe('left');
    expect(await hitAt(page, right.x + right.width + 7.5, cy)).toBe('right');
  });

  test('an absolutely placed button stays where its caller put it', async ({
    page,
  }) => {
    expect(await computed(page, 'corner', 'position')).toBe('absolute');
    const b = await box(page, 'corner');
    expect(await hitAt(page, b.x + b.width + 4, b.y + b.height / 2)).toBe(
      'corner',
    );
  });

  test('text fields are 16px, single-line ones 44px tall', async ({ page }) => {
    for (const id of ['input', 'textarea', 'select', 'command-input']) {
      expect(await computed(page, id, 'font-size'), id).toBe('16px');
    }
    expect((await box(page, 'input')).height).toBe(44);
    expect((await box(page, 'select')).height).toBe(44);
  });

  test('tabs and command items are at least 40px tall', async ({ page }) => {
    expect((await box(page, 'tab')).height).toBeGreaterThanOrEqual(40);
    expect((await box(page, 'command-item')).height).toBeGreaterThanOrEqual(40);
  });

  test('a press on a ghost button dims it', async ({ page }) => {
    const b = await box(page, 'single');
    await page.mouse.move(b.x + 14, b.y + 14);
    await page.mouse.down();
    expect(Number(await computed(page, 'single', 'opacity'))).toBeCloseTo(0.7);
    await page.mouse.up();
    expect(await computed(page, 'single', 'opacity')).toBe('1');
  });

  test('a tap on an InfoTip trigger shows its content', async ({ page }) => {
    await page.getByRole('button', { name: '未完成' }).tap();
    await expect(page.getByRole('dialog')).toHaveText('尚未完成的回复');
  });

  test('a segmented control fades only the clipped edge, and only when it overflows', async ({
    page,
  }) => {
    const mask = (name: string) =>
      page
        .getByRole('group', { name, exact: true })
        .evaluate((node) => getComputedStyle(node).maskImage);
    expect(await mask('短')).toBe('none');
    expect(await mask('长')).toMatch(/^linear-gradient\(to left/);

    await page
      .getByRole('group', { name: '长', exact: true })
      .evaluate((node) => node.scrollTo({ left: 10_000 }));
    await expect
      .poll(() => mask('长'))
      .toMatch(
        /^linear-gradient\(to right, rgba\(0, 0, 0, 0\), rgb\(0, 0, 0\) 24px\)$/,
      );
  });
});

test.describe('on iPad portrait (touch, phone layout, md breakpoint)', () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    isMobile: true,
    hasTouch: true,
  });

  test('text fields stay at 16px over md:text-sm', async ({ page }) => {
    await page.goto(HARNESS_PATH);
    expect(await computed(page, 'input', 'font-size')).toBe('16px');
    expect(await computed(page, 'textarea', 'font-size')).toBe('16px');
  });
});

test.describe('with a mouse', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('sizes, hit areas and presses are unchanged', async ({ page }) => {
    await page.goto(HARNESS_PATH);
    const b = await box(page, 'single');
    expect(await hitAt(page, b.x - 4, b.y + b.height / 2)).toBeNull();
    expect(await computed(page, 'input', 'font-size')).toBe('14px');
    expect((await box(page, 'input')).height).toBe(32);
    expect((await box(page, 'select')).height).toBe(28);
    expect((await box(page, 'command-item')).height).toBe(36);

    await page.mouse.move(b.x + 14, b.y + 14);
    await page.mouse.down();
    expect(await computed(page, 'single', 'opacity')).toBe('1');
    await page.mouse.up();
  });

  test('an InfoTip is a hover tooltip', async ({ page }) => {
    await page.goto(HARNESS_PATH);
    await page.getByRole('button', { name: '未完成' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('尚未完成的回复');
  });
});
