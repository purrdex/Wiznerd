import { test, expect } from '@playwright/test';

test.describe('Wiznerd Wallet', () => {

  test('app loads with header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Wiznerd Wallet')).toBeVisible();
  });

  test('setup screen shows on fresh load', async ({ page }) => {
    await page.goto('/');
    const hasSetup = await page.locator('text=Create new wallet').isVisible().catch(() => false);
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    expect(hasSetup || hasWallet).toBeTruthy();
  });

  test('setup screen has import and create buttons', async ({ page }) => {
    // Clear any stored wallet to guarantee setup screen
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('text=Create new wallet')).toBeVisible();
    await expect(page.locator('text=Import existing wallet')).toBeVisible();
  });

  test('wallet creation flow shows mnemonic screen', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('text=Create new wallet');
    await expect(page.locator('text=Save your')).toBeVisible();
    // Mnemonic grid should show 24 words
    const words = page.locator('.mnemonic-word');
    await expect(words).toHaveCount(24);
    // Copy button should be present
    await expect(page.locator('text=Copy seed phrase')).toBeVisible();
  });

  test('mnemonic import shows validation error', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: 'Import existing wallet' }).click();
    await expect(page.locator('textarea')).toBeVisible();
    await page.getByRole('button', { name: 'Import Wallet' }).click();
    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.error-msg')).toContainText('Invalid mnemonic');
  });

  test('nav tabs are visible when wallet loaded', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await expect(page.locator('text=Home')).toBeVisible();
      await expect(page.locator('text=NFTs')).toBeVisible();
      await expect(page.locator('text=Send')).toBeVisible();
      await expect(page.locator('text=Receive')).toBeVisible();
      await expect(page.locator('text=Settings')).toBeVisible();
    } else {
      // No wallet — confirm we're on setup screen
      await expect(page.locator('text=Create new wallet')).toBeVisible();
    }
  });

  test('NFTs tab loads', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await page.click('text=NFTs');
      await expect(page.locator('.wallet-screen')).toBeVisible();
    } else {
      await expect(page.locator('text=Create new wallet')).toBeVisible();
    }
  });

  test('Send tab shows form', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await page.click('text=Send');
      await expect(page.locator('text=AVAILABLE')).toBeVisible();
      await expect(page.locator('text=TO ADDRESS')).toBeVisible();
    } else {
      await expect(page.locator('text=Create new wallet')).toBeVisible();
    }
  });

  test('Settings tab loads', async ({ page }) => {
    await page.goto('/');
    const hasWallet = await page.locator('text=Total Balance').isVisible().catch(() => false);
    if (hasWallet) {
      await page.click('text=Settings');
      await expect(page.locator('text=NODE CONFIGURATION')).toBeVisible();
    } else {
      await expect(page.locator('text=Create new wallet')).toBeVisible();
    }
  });

});
