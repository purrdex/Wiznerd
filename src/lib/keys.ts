/**
 * keys.ts — Chia HD key derivation
 * mnemonic → BLS keys → puzzle hashes → xch addresses
 *
 * Verified to produce identical addresses to the Chia reference wallet.
 *
 * Key implementation details:
 * 1. hkdfModR uses IETF BLS KeyGen spec:
 *    - info = I2OSP(48, 2) = 0x0030 appended to each HKDF expand block
 *    - salt starts as raw 'BLS-SIG-KEYGEN-SALT-', hashed AFTER each iteration
 * 2. All path levels m/12381/8444/2/{index} use UNHARDENED derivation
 * 3. curry_and_treehash uses full Chialisp CLVM keyword constants
 */

import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { mnemonicToSeedSync, generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bech32m } from 'bech32';

const BLS_ORDER = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001');
const L = 48;
const L_BYTES = new Uint8Array([0, L]); // I2OSP(48, 2)

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

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

function bigintToBytes32(n: bigint): Uint8Array {
  return hexToBytes(n.toString(16).padStart(64, '0'));
}

function bytesToBigint(b: Uint8Array): bigint {
  let v = BigInt(0);
  for (const byte of b) v = (v << BigInt(8)) | BigInt(byte);
  return v;
}

function hmacSha256(key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array {
  const h = hmac.create(sha256, key);
  for (const m of msgs) h.update(m);
  return h.digest();
}

// ─────────────────────────────────────────────────────────────────────────────
// IETF BLS KeyGen — hkdf_mod_r
// ─────────────────────────────────────────────────────────────────────────────

function hkdfModR(ikm: Uint8Array): Uint8Array {
  let salt: Uint8Array = new TextEncoder().encode('BLS-SIG-KEYGEN-SALT-');
  let sk = BigInt(0);
  const ikmZ = new Uint8Array(ikm.length + 1);
  ikmZ.set(ikm); // append zero byte

  while (sk === BigInt(0)) {
    const prk = hmacSha256(salt, ikmZ);
    let T = new Uint8Array(0);
    let okm = new Uint8Array(0);
    let counter = 1;
    while (okm.length < L) {
      T = hmacSha256(prk, T, L_BYTES, new Uint8Array([counter++]));
      const next = new Uint8Array(okm.length + T.length);
      next.set(okm); next.set(T, okm.length);
      okm = next;
    }
    sk = bytesToBigint(okm.slice(0, L)) % BLS_ORDER;
    salt = sha256(salt); // hash AFTER each iteration
  }

  return bigintToBytes32(sk);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unhardened BLS child key derivation
// child_sk = (parent_sk + sha256(parent_pk || index_4be)) mod r
// ─────────────────────────────────────────────────────────────────────────────

function deriveChildUnhardened(
  parentSk: Uint8Array,
  parentPk: Uint8Array,
  index: number
): { sk: Uint8Array; pk: Uint8Array } {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index);

  const combined = new Uint8Array(parentPk.length + 4);
  combined.set(parentPk);
  combined.set(indexBytes, parentPk.length);

  const offset = bytesToBigint(sha256(combined)) % BLS_ORDER;
  const childSk = bigintToBytes32((bytesToBigint(parentSk) + offset) % BLS_ORDER);
  const childPk = bls.G1.Point.fromHex(bytesToHex(parentPk))
    .add(bls.G1.Point.BASE.multiply(offset))
    .toBytes(true);

  return { sk: childSk, pk: childPk };
}

// ─────────────────────────────────────────────────────────────────────────────
// Master key and wallet key derivation
// Path: m/12381/8444/2/{index} — ALL UNHARDENED
// ─────────────────────────────────────────────────────────────────────────────

export function masterSkFromSeed(seed: Uint8Array): Uint8Array {
  return hkdfModR(seed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Puzzle hash derivation
// Uses exact Chialisp CLVM tree hash constants from Chia source
// ─────────────────────────────────────────────────────────────────────────────

// CLVM keyword tree hashes (precomputed constants from Chia source)
const Q_KW_TREEHASH  = hexToBytes('9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2');
const A_KW_TREEHASH  = hexToBytes('a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222');
const C_KW_TREEHASH  = hexToBytes('a8d5dd63fba471ebcb1f3e8f7c1e1879b7152a6e7298a91ce119a63400ade7c5');
const NIL_TREEHASH   = hexToBytes('4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a');
const ONE_TREEHASH   = hexToBytes('9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2');

// DEFAULT_HIDDEN_PUZZLE_HASH = tree hash of (=) in CLVM
const DEFAULT_HIDDEN_PUZZLE_HASH = hexToBytes(
  '711d6c4e32c92e53179b199484cf8c897542bc57f2b22582799f9d657eec4699'
);

// MOD_HASH = tree hash of compiled p2_delegated_puzzle_or_hidden_puzzle
const MOD_HASH = hexToBytes(
  'e9aaa49f45bad5c889b86ee3341550c155cfdd10c3a6757de618d20612fffd52'
);

function shatree_atom(data: Uint8Array): Uint8Array {
  const p = new Uint8Array(1 + data.length);
  p[0] = 0x01; p.set(data, 1);
  return sha256(p);
}

function shatree_pair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const p = new Uint8Array(1 + left.length + right.length);
  p[0] = 0x02; p.set(left, 1); p.set(right, 1 + left.length);
  return sha256(p);
}

// calculate_hash_of_quoted_mod_hash = shatree_pair(Q_KW_TREEHASH, mod_hash)
const HASH_OF_QUOTED_MOD_HASH = shatree_pair(Q_KW_TREEHASH, MOD_HASH);

/**
 * curried_values_tree_hash — matches Chia's Python implementation exactly
 */
function curriedValuesTreeHash(args: Uint8Array[]): Uint8Array {
  if (args.length === 0) return ONE_TREEHASH;
  return shatree_pair(
    C_KW_TREEHASH,
    shatree_pair(
      shatree_pair(Q_KW_TREEHASH, args[0]),
      shatree_pair(curriedValuesTreeHash(args.slice(1)), NIL_TREEHASH)
    )
  );
}

/**
 * curry_and_treehash — matches Chia's Python implementation exactly
 * puzzle_hash = shatree_pair(A_KW_TREEHASH, shatree_pair(hash_of_quoted_mod_hash,
 *                            shatree_pair(curried_values, NIL_TREEHASH)))
 */
function curryAndTreehash(hashOfQuotedModHash: Uint8Array, ...hashedArgs: Uint8Array[]): Uint8Array {
  const curriedValues = curriedValuesTreeHash(hashedArgs);
  return shatree_pair(
    A_KW_TREEHASH,
    shatree_pair(hashOfQuotedModHash, shatree_pair(curriedValues, NIL_TREEHASH))
  );
}

/**
 * Calculate synthetic public key
 * synthetic_pk = pk + G * (sha256(pk || DEFAULT_HIDDEN_PUZZLE_HASH) mod r)
 */
export function syntheticPublicKey(pk: Uint8Array): Uint8Array {
  const combined = new Uint8Array(pk.length + DEFAULT_HIDDEN_PUZZLE_HASH.length);
  combined.set(pk);
  combined.set(DEFAULT_HIDDEN_PUZZLE_HASH, pk.length);
  const offset = bytesToBigint(sha256(combined)) % BLS_ORDER;
  return bls.G1.Point.fromHex(bytesToHex(pk))
    .add(bls.G1.Point.BASE.multiply(offset))
    .toBytes(true);
}

/**
 * Compute puzzle hash for a public key
 * Matches Chia's puzzle_hash_for_pk() exactly
 */
export function puzzleHashFromPk(pk: Uint8Array): Uint8Array {
  const synPk = syntheticPublicKey(pk);
  const pkAtomHash = shatree_atom(synPk);
  return curryAndTreehash(HASH_OF_QUOTED_MOD_HASH, pkAtomHash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Address encoding
// ─────────────────────────────────────────────────────────────────────────────

export function puzzleHashToAddress(puzzleHash: Uint8Array, prefix = 'xch'): string {
  return bech32m.encode(prefix, bech32m.toWords(puzzleHash));
}

export function addressToPuzzleHash(address: string): Uint8Array {
  return new Uint8Array(bech32m.fromWords(bech32m.decode(address).words));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mnemonic helpers
// ─────────────────────────────────────────────────────────────────────────────

export function generateNewMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function validateMnemonicWords(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

export function seedFromMnemonic(mnemonic: string): Uint8Array {
  return mnemonicToSeedSync(mnemonic);
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch address derivation
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedAddress {
  index: number;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  puzzleHash: Uint8Array;
  puzzleHashHex: string;
  address: string;
}

export function deriveAddresses(
  mnemonic: string,
  count = 20,
  prefix = 'xch'
): DerivedAddress[] {
  const seed = seedFromMnemonic(mnemonic);
  const masterSk = masterSkFromSeed(seed);
  const masterPk = bls.G1.Point.BASE.multiply(bytesToBigint(masterSk)).toBytes(true);

  // Derive intermediate key m/12381/8444/2 (all unhardened)
  let current = { sk: masterSk, pk: masterPk };
  for (const step of [12381, 8444, 2]) {
    current = deriveChildUnhardened(current.sk, current.pk, step);
  }

  const addresses: DerivedAddress[] = [];
  for (let i = 0; i < count; i++) {
    const { sk, pk } = deriveChildUnhardened(current.sk, current.pk, i);
    const puzzleHash = puzzleHashFromPk(pk);
    const puzzleHashHex = bytesToHex(puzzleHash);
    const address = puzzleHashToAddress(puzzleHash, prefix);
    addresses.push({ index: i, privateKey: sk, publicKey: pk, puzzleHash, puzzleHashHex, address });
  }

  return addresses;
}