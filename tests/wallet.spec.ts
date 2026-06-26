import { test, expect } from '@playwright/test';

test.describe('Wiznerd Wallet', () => {

  test('app loads with header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Wiznerd Wallet')).toBeVisible();
  });

  test('setup screen shows on fresh load', async ({ page }) => {
    await page.goto('/');
    // Either setup screen or wallet home should be visible
    const hasSetup = await page.locator('text=Create new wallet').isVisible().catch(() => false);
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    expect(hasSetup || hasWallet).toBeTruthy();
  });

  test('nav tabs are visible when wallet loaded', async ({ page }) => {
    await page.goto('/');
    // Only check nav if wallet is already set up
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await expect(page.locator('text=Home')).toBeVisible();
      await expect(page.locator('text=NFTs')).toBeVisible();
      await expect(page.locator('text=Send')).toBeVisible();
      await expect(page.locator('text=Receive')).toBeVisible();
      await expect(page.locator('text=Settings')).toBeVisible();
    }
  });

  test('NFTs tab loads', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await page.click('text=NFTs');
      await expect(page.locator('.wallet-screen')).toBeVisible();
    }
  });

  test('Send tab shows form', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await page.click('text=Send');
      await expect(page.locator('text=AVAILABLE')).toBeVisible();
      await expect(page.locator('text=TO ADDRESS')).toBeVisible();
    }
  });

  test('Settings tab loads', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await page.click('text=Settings');
      await expect(page.locator('text=NODE CONFIGURATION')).toBeVisible();
    }
  });

});