/**
 * cat_spend.ts — Manual CAT2 spend bundle construction
 *
 * Builds and submits a Chia CAT v2 spend bundle without requiring wallet daemon
 * registration. Used as fallback when cat_spend RPC is unavailable.
 *
 * Architecture: ring-of-1 (single-coin) spend only. Fees are not supported
 * on the manual path (fee=0). Multi-coin ring support is future work.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { hexToBytes, bytesToHex } from './utils';
import { addressToPuzzleHash, syntheticPublicKey, syntheticPrivateKey } from './keys';
import type { CatCoin } from './cats';
import type { DerivedAddress } from './keys';

// ── Compiled CAT2 and P2 puzzle templates (uncurried, from chia_puzzles repo) ──

const CAT_MOD_HEX = 'ff02ffff01ff02ff5effff04ff02ffff04ffff04ff05ffff04ffff0bff34ff0580ffff04ff0bff80808080ffff04ffff02ff17ff2f80ffff04ff5fffff04ffff02ff2effff04ff02ffff04ff17ff80808080ffff04ffff02ff2affff04ff02ffff04ff82027fffff04ff82057fffff04ff820b7fff808080808080ffff04ff81bfffff04ff82017fffff04ff8202ffffff04ff8205ffffff04ff820bffff80808080808080808080808080ffff04ffff01ffffffff3d46ff02ff333cffff0401ff01ff81cb02ffffff20ff02ffff03ff05ffff01ff02ff32ffff04ff02ffff04ff0dffff04ffff0bff7cffff0bff34ff2480ffff0bff7cffff0bff7cffff0bff34ff2c80ff0980ffff0bff7cff0bffff0bff34ff8080808080ff8080808080ffff010b80ff0180ffff02ffff03ffff22ffff09ffff0dff0580ff2280ffff09ffff0dff0b80ff2280ffff15ff17ffff0181ff8080ffff01ff0bff05ff0bff1780ffff01ff088080ff0180ffff02ffff03ff0bffff01ff02ffff03ffff09ffff02ff2effff04ff02ffff04ff13ff80808080ff820b9f80ffff01ff02ff56ffff04ff02ffff04ffff02ff13ffff04ff5fffff04ff17ffff04ff2fffff04ff81bfffff04ff82017fffff04ff1bff8080808080808080ffff04ff82017fff8080808080ffff01ff088080ff0180ffff01ff02ffff03ff17ffff01ff02ffff03ffff20ff81bf80ffff0182017fffff01ff088080ff0180ffff01ff088080ff018080ff0180ff04ffff04ff05ff2780ffff04ffff10ff0bff5780ff778080ffffff02ffff03ff05ffff01ff02ffff03ffff09ffff02ffff03ffff09ff11ff5880ffff0159ff8080ff0180ffff01818f80ffff01ff02ff26ffff04ff02ffff04ff0dffff04ff0bffff04ffff04ff81b9ff82017980ff808080808080ffff01ff02ff7affff04ff02ffff04ffff02ffff03ffff09ff11ff5880ffff01ff04ff58ffff04ffff02ff76ffff04ff02ffff04ff13ffff04ff29ffff04ffff0bff34ff5b80ffff04ff2bff80808080808080ff398080ffff01ff02ffff03ffff09ff11ff7880ffff01ff02ffff03ffff20ffff02ffff03ffff09ffff0121ffff0dff298080ffff01ff02ffff03ffff09ffff0cff29ff80ff3480ff5c80ffff01ff0101ff8080ff0180ff8080ff018080ffff0109ffff01ff088080ff0180ffff010980ff018080ff0180ffff04ffff02ffff03ffff09ff11ff5880ffff0159ff8080ff0180ffff04ffff02ff26ffff04ff02ffff04ff0dffff04ff0bffff04ff17ff808080808080ff80808080808080ff0180ffff01ff04ff80ffff04ff80ff17808080ff0180ffff02ffff03ff05ffff01ff04ff09ffff02ff56ffff04ff02ffff04ff0dffff04ff0bff808080808080ffff010b80ff0180ff0bff7cffff0bff34ff2880ffff0bff7cffff0bff7cffff0bff34ff2c80ff0580ffff0bff7cffff02ff32ffff04ff02ffff04ff07ffff04ffff0bff34ff3480ff8080808080ffff0bff34ff8080808080ffff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff2effff04ff02ffff04ff09ff80808080ffff02ff2effff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ffff04ffff04ff30ffff04ff5fff808080ffff02ff7effff04ff02ffff04ffff04ffff04ff2fff0580ffff04ff5fff82017f8080ffff04ffff02ff26ffff04ff02ffff04ff0bffff04ff05ffff01ff808080808080ffff04ff17ffff04ff81bfffff04ff82017fffff04ffff02ff2affff04ff02ffff04ff8204ffffff04ffff02ff76ffff04ff02ffff04ff09ffff04ff820affffff04ffff0bff34ff2d80ffff04ff15ff80808080808080ffff04ff8216ffff808080808080ffff04ff8205ffffff04ff820bffff808080808080808080808080ff02ff5affff04ff02ffff04ff5fffff04ff3bffff04ffff02ffff03ff17ffff01ff09ff2dffff02ff2affff04ff02ffff04ff27ffff04ffff02ff76ffff04ff02ffff04ff29ffff04ff57ffff04ffff0bff34ff81b980ffff04ff59ff80808080808080ffff04ff81b7ff80808080808080ff8080ff0180ffff04ff17ffff04ff05ffff04ff8202ffffff04ffff04ffff04ff78ffff04ffff0eff5cffff02ff2effff04ff02ffff04ffff04ff2fffff04ff82017fff808080ff8080808080ff808080ffff04ffff04ff20ffff04ffff0bff81bfff5cffff02ff2effff04ff02ffff04ffff04ff15ffff04ffff10ff82017fffff11ff8202dfff2b80ff8202ff80ff808080ff8080808080ff808080ff138080ff80808080808080808080ff018080';

const P2_MOD_HEX = 'ff02ffff01ff02ffff03ff0bffff01ff02ffff03ffff09ff05ffff1dff0bffff1effff0bff0bffff02ff06ffff04ff02ffff04ff17ff8080808080808080ffff01ff02ff17ff2f80ffff01ff088080ff0180ffff01ff04ffff04ff04ffff04ff05ffff04ffff02ff06ffff04ff02ffff04ff17ff80808080ff80808080ffff02ff17ff2f808080ff0180ffff04ffff01ff32ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff06ffff04ff02ffff04ff09ff80808080ffff02ff06ffff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080';

// sha256tree of the CAT2 module itself (used as first curried arg for self-reference)
const CAT_MOD_HASH = '37bef360ee858133b69d595a906dc45d01af50379dad515eb9518abb7c1d2a7a';

const MAINNET_AGG_SIG_ME = hexToBytes('ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb');

// ── CLVM SExp types ──────────────────────────────────────────────────────────

type SAtom = { t: 0; b: Uint8Array };
type SCons = { t: 1; l: SExp; r: SExp };
type SExp = SAtom | SCons;

const NIL: SExp = { t: 0, b: new Uint8Array(0) };
const mkAtom = (b: Uint8Array): SExp => ({ t: 0, b });
const mkCons = (l: SExp, r: SExp): SExp => ({ t: 1, l, r });
function mkList(...items: SExp[]): SExp {
  return items.reduceRight<SExp>((acc, item) => mkCons(item, acc), NIL);
}

// Positive bigint → minimal big-endian atom (with sign-bit padding if needed)
function intAtom(n: bigint): SExp {
  if (n === 0n) return NIL;
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const b = hexToBytes(hex);
  if (b[0] & 0x80) {
    const p = new Uint8Array(b.length + 1);
    p.set(b, 1);
    return mkAtom(p);
  }
  return mkAtom(b);
}

function bytes32Atom(hexStr: string): SExp {
  const h = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr;
  return mkAtom(hexToBytes(h));
}

// ── CLVM atom encoding ───────────────────────────────────────────────────────

function encodeAtomBytes(b: Uint8Array): Uint8Array {
  if (b.length === 0) return new Uint8Array([0x80]);
  if (b.length === 1 && b[0] <= 0x7f) return new Uint8Array([b[0]]);
  if (b.length <= 0x3F) {
    const r = new Uint8Array(1 + b.length);
    r[0] = 0x80 + b.length;
    r.set(b, 1);
    return r;
  }
  if (b.length <= 0x1FFF) {
    const r = new Uint8Array(2 + b.length);
    r[0] = 0xC0 | (b.length >> 8);
    r[1] = b.length & 0xFF;
    r.set(b, 2);
    return r;
  }
  throw new Error(`CLVM atom too large: ${b.length} bytes`);
}

function encodeSExp(s: SExp): Uint8Array {
  if (s.t === 0) return encodeAtomBytes(s.b);
  const l = encodeSExp(s.l), r = encodeSExp(s.r);
  const out = new Uint8Array(1 + l.length + r.length);
  out[0] = 0xFF;
  out.set(l, 1);
  out.set(r, 1 + l.length);
  return out;
}

// ── CLVM parsing ────────────────────────────────────────────────────────────

function parseSExp(bytes: Uint8Array, pos: number): [SExp, number] {
  const b = bytes[pos];
  if (b === 0xFF) {
    const [l, p1] = parseSExp(bytes, pos + 1);
    const [r, p2] = parseSExp(bytes, p1);
    return [mkCons(l, r), p2];
  }
  if (b === 0x80) return [NIL, pos + 1];
  if (b <= 0x7F) return [mkAtom(new Uint8Array([b])), pos + 1];
  let len: number, start: number;
  if (b < 0xC0) { len = b - 0x80; start = pos + 1; }
  else if (b < 0xE0) { len = ((b & 0x1F) << 8) | bytes[pos + 1]; start = pos + 2; }
  else throw new Error(`Unsupported CLVM size prefix 0x${b.toString(16)}`);
  return [mkAtom(bytes.slice(start, start + len)), start + len];
}

// ── sha256tree ───────────────────────────────────────────────────────────────

function sha256tree(s: SExp): Uint8Array {
  if (s.t === 0) {
    const d = new Uint8Array(1 + s.b.length);
    d[0] = 0x01;
    d.set(s.b, 1);
    return sha256(d);
  }
  const l = sha256tree(s.l), r = sha256tree(s.r);
  const d = new Uint8Array(65);
  d[0] = 0x02;
  d.set(l, 1);
  d.set(r, 33);
  return sha256(d);
}

// ── SExp curry ───────────────────────────────────────────────────────────────
// Builds (a (q . MOD) (c (q . A0) (c (q . A1) ... (c (q . An) 1) ...)))
// MOD is parsed from its serialised bytes so it is embedded as a SExp tree,
// not as a length-prefixed atom blob. Args likewise arrive as SExp values.
// This matches Chia's Python curry() exactly: every element is a quoted SExp.

function sexpCurry(modBytes: Uint8Array, args: SExp[]): SExp {
  const APPLY = mkAtom(new Uint8Array([0x02]));
  const CONS  = mkAtom(new Uint8Array([0x04]));
  const QUOTE = mkAtom(new Uint8Array([0x01]));

  const [mod] = parseSExp(modBytes, 0);
  // Start with path-1 (the whole environment), build the c-chain right to left
  let r: SExp = mkAtom(new Uint8Array([0x01]));
  for (let i = args.length - 1; i >= 0; i--) {
    r = mkList(CONS, mkCons(QUOTE, args[i]), r);
  }
  return mkList(APPLY, mkCons(QUOTE, mod), r);
}

// Navigate a curried puzzle to get the Nth argument (0-indexed).
// Structure: (a (q . MOD) (c (q . A0) (c (q . A1) ... (c (q . An) 1)...)))
function getCurryArg(root: SExp, n: number): SExp {
  if (root.t !== 1) throw new Error('not a curry');
  const afterMod = (root.r as SCons).r; // skip (q . MOD) → cons(c_chain, nil)
  let chain = (afterMod as SCons).l;    // c_chain = (c (q . A0) rest)
  for (let i = 0; i < n; i++) {
    // chain = (c (q . Ak) cons(next, nil))
    const chainR = (chain as SCons).r;          // cons((q.Ak), cons(next, nil))
    const restCons = (chainR as SCons).r;        // cons(next, nil)
    chain = (restCons as SCons).l;               // next chain
  }
  const qAn = ((chain as SCons).r as SCons).l;  // (q . An)
  return (qAn as SCons).r;                       // An
}

// ── BLS AugSchemeMPL signing ─────────────────────────────────────────────────

function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function blsAugSign(sk: Uint8Array, message: Uint8Array): Uint8Array {
  const skBig = bytesToBigint(sk);
  const pk = bls.G1.Point.BASE.multiply(skBig).toBytes(true); // 48-byte G1
  const augMsg = new Uint8Array(pk.length + message.length);
  augMsg.set(pk);
  augMsg.set(message, pk.length);
  // DST for AugSchemeMPL (Chia uses this scheme)
  const sigPoint = bls.G2.hashToCurve(augMsg, {
    DST: 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_AUG_',
  });
  return sigPoint.multiply(skBig).toBytes(true); // 96-byte G2 signature
}

// ── Node RPC helper ──────────────────────────────────────────────────────────

async function nodePost(nodeUrl: string, endpoint: string, body: string): Promise<any> {
  const url = `${nodeUrl.replace(/\/$/, '')}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || `${endpoint} failed`);
  return data;
}

// ── Main: manual CAT send ────────────────────────────────────────────────────

export async function sendCatManual(
  nodeUrl: string,
  coin: CatCoin,
  amount: bigint,
  recipientAddress: string,
  derivedAddresses: DerivedAddress[]
): Promise<void> {
  // 1. Find the derived address that controls this coin
  const innerPhHex = coin.innerPuzzleHash.startsWith('0x')
    ? coin.innerPuzzleHash.slice(2)
    : coin.innerPuzzleHash;
  const senderAddr = derivedAddresses.find(a => a.puzzleHashHex === innerPhHex);
  if (!senderAddr) throw new Error('Coin owner not found in derived addresses');

  // 2. Build P2 inner puzzle: curry(P2_MOD, syntheticPubKey)
  const synPk = syntheticPublicKey(senderAddr.publicKey);
  const synSk = syntheticPrivateKey(senderAddr.privateKey, senderAddr.publicKey);
  const innerPuzzleSExp = sexpCurry(hexToBytes(P2_MOD_HEX), [mkAtom(synPk)]);

  // 3. Build outer CAT puzzle: curry(CAT_MOD, MOD_HASH, assetId, innerPuzzle)
  // innerPuzzleSExp is passed as a SExp tree (not atom-encoded) so the quoted
  // curry arg is (q . <puzzle_sexp>), matching Chia's construct_cat_puzzle.
  const assetIdHex = coin.assetId.startsWith('0x') ? coin.assetId.slice(2) : coin.assetId;
  const outerPuzzleBytes = encodeSExp(sexpCurry(hexToBytes(CAT_MOD_HEX), [
    mkAtom(hexToBytes(CAT_MOD_HASH)),
    mkAtom(hexToBytes(assetIdHex)),
    innerPuzzleSExp,
  ]));

  // 4. Compute change
  const coinAmount = BigInt(coin.amount);
  const change = coinAmount - amount;
  const changePh = hexToBytes(innerPhHex); // change returns to same wallet address

  // 5. Fetch parent coin record (for lineage proof grandparent ID and amount)
  const parentId = coin.parentCoinInfo.startsWith('0x')
    ? coin.parentCoinInfo
    : `0x${coin.parentCoinInfo}`;
  const parentData = await nodePost(nodeUrl, 'get_coin_record_by_name',
    `{"name":"${parentId}"}`);
  const parentCoin = parentData.coin_record.coin;

  // 6. Extract parent's inner puzzle hash (only for non-genesis coins).
  // For genesis/eve coins (coin.isGenesis=true), the parent is an XCH coin, so the
  // CAT2 lineage proof uses 2-element form: (grandparent_id, parent_amount).
  let parentInnerPuzzleHash: Uint8Array | null = null;
  if (!coin.isGenesis) {
    if (!coin.parentPuzzleReveal) throw new Error('parentPuzzleReveal missing from coin');
    const parentRevealHex = coin.parentPuzzleReveal.startsWith('0x')
      ? coin.parentPuzzleReveal.slice(2)
      : coin.parentPuzzleReveal;
    const [parentPuzzleSExp] = parseSExp(hexToBytes(parentRevealHex), 0);
    // CAT curry args: [0]=CAT_MOD_HASH [1]=assetId [2]=inner_puzzle (a SExp, not an atom)
    const parentInnerPuzzle = getCurryArg(parentPuzzleSExp, 2);
    parentInnerPuzzleHash = sha256tree(parentInnerPuzzle);
  }

  // 7. Build delegated puzzle: (q . conditions)
  const recipientPh = addressToPuzzleHash(recipientAddress);
  const CREATE_COIN = intAtom(51n);
  // Include the inner puzzle hash as a memo/hint so the node indexes the coin
  // for get_coin_records_by_hint — without this the recipient and change coins
  // are invisible to hint-based discovery and appear to vanish after a send.
  const conditions: SExp[] = [
    mkList(CREATE_COIN, mkAtom(recipientPh), intAtom(amount), mkList(mkAtom(recipientPh))),
  ];
  if (change > 0n) {
    conditions.push(mkList(CREATE_COIN, mkAtom(changePh), intAtom(change), mkList(mkAtom(changePh))));
  }
  const delegatedPuzzle = mkCons(mkAtom(new Uint8Array([1])), mkList(...conditions));

  // 8. P2 inner solution: (nil delegated_puzzle nil)
  const innerSolution = mkList(NIL, delegatedPuzzle, NIL);

  // 9. Build CAT outer solution (7-element list):
  //    inner_solution | lineage_proof | prev_coin_id | this_coin_info |
  //    next_coin_proof | prev_subtotal | extra_delta
  const grandparentId = parentCoin.parent_coin_info as string;
  const parentAmount = BigInt(parentCoin.amount as number);

  // Eve/genesis: 2-element proof (grandparent_id, parent_amount)
  // Non-eve: 3-element proof (grandparent_id, parent_inner_ph, parent_amount)
  const lineageProof = coin.isGenesis || !parentInnerPuzzleHash
    ? mkList(bytes32Atom(grandparentId), intAtom(parentAmount))
    : mkList(bytes32Atom(grandparentId), mkAtom(parentInnerPuzzleHash), intAtom(parentAmount));

  const outerPuzzleHashHex = coin.puzzleHash.startsWith('0x')
    ? coin.puzzleHash.slice(2)
    : coin.puzzleHash;

  const thisCoinInfo = mkList(
    bytes32Atom(coin.parentCoinInfo),
    mkAtom(hexToBytes(outerPuzzleHashHex)),
    intAtom(coinAmount)
  );

  // next_coin_proof uses INNER puzzle hash (this coin's own inner puzzle hash)
  const nextCoinProof = mkList(
    bytes32Atom(coin.parentCoinInfo),
    mkAtom(hexToBytes(innerPhHex)),
    intAtom(coinAmount)
  );

  const coinIdBytes = hexToBytes(coin.coinId);

  const catSolution = mkList(
    innerSolution,
    lineageProof,
    mkAtom(coinIdBytes),  // prev_coin_id = self (ring of 1)
    thisCoinInfo,
    nextCoinProof,
    NIL,   // prev_subtotal = 0
    NIL    // extra_delta = 0
  );

  // 10. AGG_SIG_ME message: sha256tree(delegated_puzzle) || coin_id || additional_data
  const delegatedPuzzleHash = sha256tree(delegatedPuzzle);
  const sigMsg = new Uint8Array(96);
  sigMsg.set(delegatedPuzzleHash, 0);
  sigMsg.set(coinIdBytes, 32);
  sigMsg.set(MAINNET_AGG_SIG_ME, 64);

  const sig = blsAugSign(synSk, sigMsg);

  // 11. Submit spend bundle via push_tx
  const parentCoinInfo = coin.parentCoinInfo.startsWith('0x')
    ? coin.parentCoinInfo
    : `0x${coin.parentCoinInfo}`;
  const puzzleHashField = coin.puzzleHash.startsWith('0x')
    ? coin.puzzleHash
    : `0x${coin.puzzleHash}`;
  const puzzleRevealHex = '0x' + bytesToHex(outerPuzzleBytes);
  const solutionHex = '0x' + bytesToHex(encodeSExp(catSolution));
  const sigHex = '0x' + bytesToHex(sig);

  const spendBody = `{"spend_bundle":{"coin_spends":[{"coin":{"parent_coin_info":"${parentCoinInfo}","puzzle_hash":"${puzzleHashField}","amount":${coin.amount}},"puzzle_reveal":"${puzzleRevealHex}","solution":"${solutionHex}"}],"aggregated_signature":"${sigHex}"}}`;

  await nodePost(nodeUrl, 'push_tx', spendBody);
}
