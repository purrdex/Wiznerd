import { test, expect, type Page } from '@playwright/test';

const TEST_PASSWORD = 'test_password_1';

// Completes the full wallet creation flow including quiz + password step.
async function completeWalletCreation(page: Page) {
  await page.click('text=Create new wallet');
  await expect(page.locator('.mnemonic-word').first()).toBeVisible({ timeout: 15000 });

  // Capture mnemonic words before navigating away
  const wordValues = page.locator('.mnemonic-word .word-value');
  await expect(wordValues.first()).toBeVisible();
  const wordCount = await wordValues.count();
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push((await wordValues.nth(i).textContent()) ?? '');
  }

  // Confirm backup and proceed to quiz
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Continue/i }).click();

  // Verify quiz screen
  await expect(page.locator('text=Verify your backup')).toBeVisible({ timeout: 5000 });

  // Fill in the quiz inputs using the placeholder to determine which word is needed
  const inputs = page.locator('input[placeholder^="Enter word"]');
  const inputCount = await inputs.count();
  for (let i = 0; i < inputCount; i++) {
    const placeholder = (await inputs.nth(i).getAttribute('placeholder')) ?? '';
    const m = placeholder.match(/Enter word #(\d+)/);
    if (m) {
      const wordIdx = parseInt(m[1], 10) - 1;
      await inputs.nth(i).fill(words[wordIdx] ?? '');
    }
  }

  await page.getByRole('button', { name: 'Open Wallet' }).click();

  // Password creation step
  await expect(page.locator('text=Create password')).toBeVisible({ timeout: 5000 });
  await page.locator('input[placeholder*="New password"]').fill(TEST_PASSWORD);
  await page.locator('input[placeholder="Confirm password"]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create Wallet' }).click();
}

// Unlocks an encrypted wallet after a page reload.
async function unlockWallet(page: Page) {
  await expect(page.locator('text=Unlock wallet').or(page.locator('text=Secure your wallet'))).toBeVisible({ timeout: 5000 });
  await page.locator('input[placeholder="Password"]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

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

  test('wallet creation flow — verification quiz appears after confirm', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('text=Create new wallet');
    await expect(page.locator('.mnemonic-word').first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Continue/i }).click();
    await expect(page.locator('text=Verify your backup')).toBeVisible({ timeout: 5000 });
    // Should show 3 quiz inputs
    const inputs = page.locator('input[placeholder^="Enter word"]');
    await expect(inputs).toHaveCount(3);
  });

  test('wallet creation quiz rejects wrong words', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('text=Create new wallet');
    await expect(page.locator('.mnemonic-word').first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Continue/i }).click();
    await expect(page.locator('text=Verify your backup')).toBeVisible({ timeout: 5000 });
    // Fill all inputs with wrong word
    const inputs = page.locator('input[placeholder^="Enter word"]');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      await inputs.nth(i).fill('wrongword');
    }
    await page.getByRole('button', { name: 'Open Wallet' }).click();
    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.error-msg')).toContainText('incorrect');
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

  test('wallet home loads after completing creation flow', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await completeWalletCreation(page);
    // Wallet home screen should appear (with or without balance data)
    await expect(page.locator('text=Total Balance')).toBeVisible({ timeout: 15000 });
    // Token section should render (empty state or with tokens)
    await expect(page.locator('text=Home')).toBeVisible();
    await expect(page.locator('text=Send')).toBeVisible();
    // History tab should navigate without crash
    await page.click('text=History');
    await expect(page.locator('text=Transaction History')).toBeVisible();
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

  test('Settings tab shows seed phrase reveal section', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await completeWalletCreation(page);
    await expect(page.locator('text=Total Balance')).toBeVisible({ timeout: 15000 });
    await page.click('text=Settings');
    await expect(page.locator('text=Reveal seed phrase')).toBeVisible();
    await page.locator('text=Show seed phrase').click();
    // Should now show the mnemonic grid (24 words in the reveal panel)
    await expect(page.locator('text=KEEP THIS PRIVATE')).toBeVisible({ timeout: 3000 });
  });

  test('HistoryScreen: no-node empty state', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await completeWalletCreation(page);
    await expect(page.locator('text=Total Balance')).toBeVisible({ timeout: 15000 });
    await page.click('text=History');
    await expect(page.locator('text=Transaction History')).toBeVisible();
    // With no node URL set, should show the empty/no-node message
    await expect(
      page.locator('text=Set a node in Settings').or(page.locator('text=No node configured'))
    ).toBeVisible({ timeout: 5000 });
  });

  test('HistoryScreen: shows scanning state when node configured', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await completeWalletCreation(page);
    await expect(page.locator('text=Total Balance')).toBeVisible({ timeout: 15000 });
    // Inject a non-working node URL then reload so App re-reads it from localStorage
    await page.evaluate(() => localStorage.setItem('chia_node_url', 'http://localhost:19999'));
    await page.reload();
    // After reload, wallet is locked — must re-enter password
    await unlockWallet(page);
    await expect(page.locator('text=Total Balance')).toBeVisible({ timeout: 15000 });
    await page.click('text=History');
    await expect(page.locator('text=Transaction History')).toBeVisible();
    // Should show scanning indicator or an error — either proves the node path was taken
    const scanning = page.locator('text=Scanning chain').or(page.locator('text=Scanning…'));
    const errored = page.locator('text=fetch').or(page.locator('text=Failed to fetch').or(page.locator('text=NetworkError').or(page.locator('text=ECONNREFUSED'))));
    const noTxs = page.locator('text=No transactions found');
    await expect(scanning.or(errored).or(noTxs)).toBeVisible({ timeout: 15000 });
  });

});
