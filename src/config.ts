/**
 * BlockchainAnalyzer Configuration
 *
 * Chain registry, cost limits, and schema family definitions.
 */

export type SchemaFamily = 'evm' | 'utxo' | 'solana' | 'beacon' | 'custom';

export interface ChainConfig {
  id: string;
  name: string;
  project: string;
  dataset: string;
  family: SchemaFamily;
  nativeToken: string;
  totalSizeGB: number;
}

/**
 * All supported blockchain datasets with their BigQuery locations
 */
export const CHAINS: Record<string, ChainConfig> = {
  // === EVM Family ===
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    project: 'bigquery-public-data',
    dataset: 'crypto_ethereum',
    family: 'evm',
    nativeToken: 'ETH',
    totalSizeGB: 18670,
  },
  ethereum_classic: {
    id: 'ethereum_classic',
    name: 'Ethereum Classic',
    project: 'bigquery-public-data',
    dataset: 'crypto_ethereum_classic',
    family: 'evm',
    nativeToken: 'ETC',
    totalSizeGB: 141,
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    project: 'public-data-finance',
    dataset: 'crypto_polygon',
    family: 'evm',
    nativeToken: 'MATIC',
    totalSizeGB: 49722,
  },

  // === UTXO Family ===
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin',
    project: 'bigquery-public-data',
    dataset: 'crypto_bitcoin',
    family: 'utxo',
    nativeToken: 'BTC',
    totalSizeGB: 2260,
  },
  bitcoin_cash: {
    id: 'bitcoin_cash',
    name: 'Bitcoin Cash',
    project: 'bigquery-public-data',
    dataset: 'crypto_bitcoin_cash',
    family: 'utxo',
    nativeToken: 'BCH',
    totalSizeGB: 946,
  },
  litecoin: {
    id: 'litecoin',
    name: 'Litecoin',
    project: 'bigquery-public-data',
    dataset: 'crypto_litecoin',
    family: 'utxo',
    nativeToken: 'LTC',
    totalSizeGB: 602,
  },
  dogecoin: {
    id: 'dogecoin',
    name: 'Dogecoin',
    project: 'bigquery-public-data',
    dataset: 'crypto_dogecoin',
    family: 'utxo',
    nativeToken: 'DOGE',
    totalSizeGB: 619,
  },
  dash: {
    id: 'dash',
    name: 'Dash',
    project: 'bigquery-public-data',
    dataset: 'crypto_dash',
    family: 'utxo',
    nativeToken: 'DASH',
    totalSizeGB: 131,
  },
  zcash: {
    id: 'zcash',
    name: 'Zcash',
    project: 'bigquery-public-data',
    dataset: 'crypto_zcash',
    family: 'utxo',
    nativeToken: 'ZEC',
    totalSizeGB: 109,
  },

  // === Solana ===
  solana: {
    id: 'solana',
    name: 'Solana',
    project: 'solana-data-sandbox',
    dataset: 'crypto_solana_mainnet_us',
    family: 'solana',
    nativeToken: 'SOL',
    totalSizeGB: 1572360,
  },

  // === Beacon Chain ===
  ethereum2: {
    id: 'ethereum2',
    name: 'Ethereum Beacon Chain',
    project: 'public-data-finance',
    dataset: 'crypto_ethereum2',
    family: 'beacon',
    nativeToken: 'ETH',
    totalSizeGB: 10649,
  },

  // === Custom Schema Chains ===
  band: {
    id: 'band',
    name: 'Band Protocol',
    project: 'public-data-finance',
    dataset: 'crypto_band',
    family: 'custom',
    nativeToken: 'BAND',
    totalSizeGB: 682,
  },
  iotex: {
    id: 'iotex',
    name: 'IoTeX',
    project: 'public-data-finance',
    dataset: 'crypto_iotex',
    family: 'custom',
    nativeToken: 'IOTX',
    totalSizeGB: 148,
  },
  tezos: {
    id: 'tezos',
    name: 'Tezos',
    project: 'public-data-finance',
    dataset: 'crypto_tezos',
    family: 'custom',
    nativeToken: 'XTZ',
    totalSizeGB: 278,
  },
  theta: {
    id: 'theta',
    name: 'Theta',
    project: 'public-data-finance',
    dataset: 'crypto_theta',
    family: 'custom',
    nativeToken: 'THETA',
    totalSizeGB: 134,
  },
  zilliqa: {
    id: 'zilliqa',
    name: 'Zilliqa',
    project: 'public-data-finance',
    dataset: 'crypto_zilliqa',
    family: 'custom',
    nativeToken: 'ZIL',
    totalSizeGB: 35,
  },
  multiversx: {
    id: 'multiversx',
    name: 'MultiversX',
    project: 'bigquery-public-data',
    dataset: 'crypto_multiversx_mainnet_eu',
    family: 'custom',
    nativeToken: 'EGLD',
    totalSizeGB: 1742,
  },
};

/**
 * Get fully qualified BigQuery table reference
 */
export function getTableRef(chainId: string, table: string): string {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain: ${chainId}`);
  return `\`${chain.project}.${chain.dataset}.${table}\``;
}

/**
 * Get chain config or throw
 */
export function getChain(chainId: string): ChainConfig {
  const chain = CHAINS[chainId];
  if (!chain) {
    const available = Object.keys(CHAINS).join(', ');
    throw new Error(`Unknown chain: ${chainId}. Available: ${available}`);
  }
  return chain;
}

/**
 * List chains filtered by family
 */
export function listChains(family?: SchemaFamily): ChainConfig[] {
  const chains = Object.values(CHAINS);
  if (family) return chains.filter(c => c.family === family);
  return chains;
}
