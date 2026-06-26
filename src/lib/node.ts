/**
 * node.ts
 * Handles connecting to Chia full nodes via HTTP RPC
 * Includes preflight sync check before trusting any node
 */

export interface NodeConfig {
  url: string;          // e.g. "https://my-chia-node.com:8555"
  cert?: string;        // Optional client cert (for self-hosted nodes)
  label?: string;       // Human-readable name
}

export interface BlockchainState {
  peak_height: number;
  sync: {
    sync_mode: boolean;
    synced: boolean;
    sync_tip_height: number;
    sync_progress_height: number;
  };
  difficulty: number;
  node_id: string;
}

export interface CoinRecord {
  coin: {
    parent_coin_info: string;
    puzzle_hash: string;
    amount: number;
  };
  confirmed_block_index: number;
  spent_block_index: number;
  spent: boolean;
  coinbase: boolean;
  timestamp: number;
}

export interface NodeStatus {
  url: string;
  label: string;
  peakHeight: number;
  synced: boolean;
  latencyMs: number;
  trusted: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Core RPC call
// ---------------------------------------------------------------------------

async function rpc<T>(
  nodeUrl: string,
  endpoint: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const url = `${nodeUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`RPC ${endpoint} failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(`RPC ${endpoint} returned error: ${JSON.stringify(data.error || data)}`);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Preflight sync check — the core reliability fix
// ---------------------------------------------------------------------------

/**
 * Check if a node is synced and trustworthy before using it
 * Returns null if the node fails the check
 */
export async function checkNodeSync(nodeUrl: string, label = nodeUrl): Promise<NodeStatus> {
  const start = Date.now();

  try {
    const data = await rpc<{ blockchain_state: BlockchainState }>(
      nodeUrl,
      'get_blockchain_state'
    );

    const state = data.blockchain_state;
    const latencyMs = Date.now() - start;
    const synced = state.sync.synced && !state.sync.sync_mode;

    return {
      url: nodeUrl,
      label,
      peakHeight: state.peak?.height ?? state.peak_height ?? 0,
      synced,
      latencyMs,
      trusted: synced,
      error: synced ? undefined : `Node is syncing (at block ${state.peak_height})`,
    };
  } catch (err: any) {
    return {
      url: nodeUrl,
      label,
      peakHeight: 0,
      synced: false,
      latencyMs: Date.now() - start,
      trusted: false,
      error: err.message || 'Connection failed',
    };
  }
}

/**
 * Check multiple nodes and return ranked by sync state + latency
 * Nodes that are not synced or unreachable are marked untrusted
 */
export async function rankNodes(nodes: NodeConfig[]): Promise<NodeStatus[]> {
  const results = await Promise.all(
    nodes.map(n => checkNodeSync(n.url, n.label || n.url))
  );

  // Sort: synced nodes first, then by latency
  return results.sort((a, b) => {
    if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
    return a.latencyMs - b.latencyMs;
  });
}

/**
 * Pick the best available node from a list
 * Throws if no synced nodes are available
 */
export async function getBestNode(nodes: NodeConfig[]): Promise<NodeStatus> {
  const ranked = await rankNodes(nodes);
  const best = ranked.find(n => n.trusted);

  if (!best) {
    throw new Error(
      'No synced nodes available. ' +
      ranked.map(n => `${n.label}: ${n.error}`).join('; ')
    );
  }

  return best;
}

// ---------------------------------------------------------------------------
// Balance queries
// ---------------------------------------------------------------------------

/**
 * Get unspent coin records for a list of puzzle hashes
 */
export async function getCoinRecords(
  nodeUrl: string,
  puzzleHashes: string[],
  includeSpent = false
): Promise<CoinRecord[]> {
  const data = await rpc<{ coin_records: CoinRecord[] }>(
    nodeUrl,
    'get_coin_records_by_puzzle_hashes',
    {
      puzzle_hashes: puzzleHashes.map(h => (h.startsWith('0x') ? h : `0x${h}`)),
      include_spent_coins: includeSpent,
    }
  );

  return data.coin_records;
}

/**
 * Get total balance in mojo for a set of puzzle hashes
 */
export async function getBalance(
  nodeUrl: string,
  puzzleHashes: string[]
): Promise<{
  totalMojo: bigint;
  coins: CoinRecord[];
  confirmedCount: number;
}> {
  const coins = await getCoinRecords(nodeUrl, puzzleHashes, false);

  const totalMojo = coins.reduce(
    (sum, coin) => sum + BigInt(coin.coin.amount),
    BigInt(0)
  );

  return {
    totalMojo,
    coins,
    confirmedCount: coins.length,
  };
}

// ---------------------------------------------------------------------------
// Default public nodes (for MVP — swap with your own as they become available)
// ---------------------------------------------------------------------------

export const DEFAULT_NODES: NodeConfig[] = [
  {
    url: 'https://chia-node.speedfarmer.io',
    label: 'SpeedFarmer',
  },
  {
    url: 'https://node.chia.net',
    label: 'Chia Official',
  },
];

// Note: Most public Chia nodes don't expose HTTP RPC with CORS enabled.
// For development, run a local proxy:
//   npx cors-anywhere  (or use the proxy config in package.json)
// 
// For production, you'll need:
//   - Your own synced full node with CORS enabled in config.yaml
//   - OR a thin nginx proxy in front of a trusted node
//
// The wallet logic is identical either way — just swap the URL.