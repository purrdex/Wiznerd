import { bech32m } from 'bech32';

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const b = new Uint8Array(clean.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function formatMojoToXch(mojo: bigint): string {
  const xch = Number(mojo) / 1_000_000_000_000;
  return xch.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 });
}

export function isValidXchAddress(address: string): boolean {
  try {
    const { prefix, words } = bech32m.decode(address);
    return prefix === 'xch' && words.length === 52;
  } catch { return false; }
}
