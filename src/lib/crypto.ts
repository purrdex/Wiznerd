/**
 * crypto.ts — PBKDF2 + AES-256-GCM wallet encryption
 *
 * Mnemonics are never stored in plaintext. The derived CryptoKey lives only
 * in memory for the session; the user re-enters their password after a page reload.
 *
 * Layout per wallet entry:
 *   encryptedMnemonic = JSON.stringify({ iv: base64, ct: base64 })
 *
 * Layout in localStorage:
 *   chia_vault_salt  = base64(32-byte PBKDF2 salt)  — not secret, unique per install
 */

export const VAULT_SALT_KEY = 'chia_vault_salt';
const PBKDF2_ITERATIONS = 600_000;

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

/** Generate a fresh 32-byte PBKDF2 salt and store it in localStorage. */
export function generateAndStoreSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(32) as Uint8Array<ArrayBuffer>);
  const b64 = toBase64(salt);
  localStorage.setItem(VAULT_SALT_KEY, b64);
  return b64;
}

/** Return the stored salt (base64), or generate+store one if absent. */
export function getOrCreateSalt(): string {
  return localStorage.getItem(VAULT_SALT_KEY) || generateAndStoreSalt();
}

/** Derive an AES-256-GCM CryptoKey from the user's password + stored salt. */
export async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromBase64(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a mnemonic string. Returns a JSON-encoded base64 blob. */
export async function encryptMnemonic(mnemonic: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12) as Uint8Array<ArrayBuffer>);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(mnemonic));
  return JSON.stringify({ iv: toBase64(iv), ct: toBase64(ciphertext) });
}

/** Decrypt an encrypted mnemonic blob. Throws DOMException on wrong password. */
export async function decryptMnemonic(encrypted: string, key: CryptoKey): Promise<string> {
  const { iv, ct } = JSON.parse(encrypted) as { iv: string; ct: string };
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ct),
  );
  return new TextDecoder().decode(plaintext);
}
