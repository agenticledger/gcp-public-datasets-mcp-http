/**
 * BlockchainAnalyzer MCP Tool Definitions
 *
 * 23 tools across 6 categories:
 * - Discovery (3): list_chains, get_schema, get_cost_estimate
 * - EVM (8): evm_transactions, block_stats, transaction_summary, token_transfers, top_addresses, contract_info, eth_balance, token_info
 * - UTXO (4): utxo_transactions, utxo_block_stats, utxo_transaction_summary, utxo_address_activity
 * - Solana (4): sol_transactions, sol_block_stats, sol_token_transfers, sol_transaction_summary
 * - Beacon (2): beacon_validator_info, beacon_block_stats
 * - Query (2): build_and_run_query, run_raw_sql
 *
 * DESCRIPTION GUIDELINES (for LLM token efficiency):
 * - Tool description: max 60 chars
 * - Parameter .describe(): max 15 chars
 */

import { z } from 'zod';
import { BlockchainAnalyzerClient } from './api-client.js';
import { CHAINS, getChain, getTableRef, listChains } from './config.js';
import { buildSQL, validatePlan, type QueryPlan } from './query-builder.js';
import { sanitizeSQL, validateReadOnly } from './sql-sanitizer.js';

// Prevent TS2589 with 20+ tools
interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  handler: (client: BlockchainAnalyzerClient, args: any) => Promise<any>;
}

// ===== Shared Zod Schemas =====

const chainIdSchema = z.string().describe('chain ID');
const dateFromSchema = z.string().describe('start date ISO');
const dateToSchema = z.string().describe('end date ISO');
const addressSchema = z.string().describe('wallet address');
const limitSchema = z.number().optional().describe('max results');

// ===== Tool Definitions =====

export const tools: ToolDef[] = [
  // ==========================================
  // === DISCOVERY TOOLS ===
  // ==========================================

  {
    name: 'list_chains',
    description: 'List available blockchain datasets',
    inputSchema: z.object({
      family: z.enum(['evm', 'utxo', 'solana', 'beacon', 'custom']).optional().describe('filter by family'),
    }),
    handler: async (_client: BlockchainAnalyzerClient, args: { family?: string }) => {
      const chains = listChains(args.family as any);
      return chains.map(c => ({
        id: c.id,
        name: c.name,
        family: c.family,
        nativeToken: c.nativeToken,
        dataset: `${c.project}.${c.dataset}`,
        totalSizeGB: c.totalSizeGB,
      }));
    },
  },

  {
    name: 'get_schema',
    description: 'Get table and column details for a chain',
    inputSchema: z.object({
      chain: chainIdSchema,
      table: z.string().optional().describe('table name'),
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; table?: string }) => {
      const chain = getChain(args.chain);
      if (args.table) {
        return client.getTableSchema(chain.project, chain.dataset, args.table);
      }
      return client.getDatasetInfo(chain.project, chain.dataset);
    },
  },

  {
    name: 'get_cost_estimate',
    description: 'Estimate query cost without executing',
    inputSchema: z.object({
      sql: z.string().describe('SQL query'),
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { sql: string }) => {
      const sanitized = sanitizeSQL(args.sql);
      const readOnlyCheck = validateReadOnly(sanitized);
      if (!readOnlyCheck.valid) return { error: readOnlyCheck.error };
      return client.dryRun(sanitized);
    },
  },

  // ==========================================
  // === EVM TOOLS (Ethereum, Polygon, ETC) ===
  // ==========================================

  {
    name: 'evm_block_stats',
    description: 'EVM block stats for date range',
    inputSchema: z.object({
      chain: chainIdSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; date_from: string; date_to: string }) => {
      const tableRef = getTableRef(args.chain, 'blocks');
      const sql = `
        SELECT
          DATE(timestamp) AS date,
          COUNT(*) AS block_count,
          AVG(gas_used) AS avg_gas_used,
          AVG(gas_limit) AS avg_gas_limit,
          AVG(transaction_count) AS avg_tx_per_block,
          SUM(transaction_count) AS total_transactions
        FROM ${tableRef}
        WHERE timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY date
        ORDER BY date DESC
        LIMIT 1000
      `;
      return client.query(sql);
    },
  },

  {
    name: 'evm_transactions',
    description: 'List individual EVM transactions for address',
    inputSchema: z.object({
      chain: chainIdSchema,
      address: addressSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; address: string; date_from: string; date_to: string; limit?: number }) => {
      const tableRef = getTableRef(args.chain, 'transactions');
      const chain = getChain(args.chain);
      const addr = args.address.toLowerCase();
      const limit = Math.min(args.limit ?? 100, 10000);
      const sql = `
        SELECT
          \`hash\`,
          block_number,
          block_timestamp,
          from_address,
          to_address,
          CASE
            WHEN from_address = '${addr}' THEN 'sent'
            ELSE 'received'
          END AS direction,
          CAST(value AS FLOAT64) / 1e18 AS value_native,
          CAST(gas_price AS FLOAT64) / 1e9 AS gas_price_gwei,
          receipt_gas_used,
          CAST(receipt_gas_used AS FLOAT64) * CAST(gas_price AS FLOAT64) / 1e18 AS gas_cost_native,
          receipt_status
        FROM ${tableRef}
        WHERE block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
          AND (from_address = '${addr}' OR to_address = '${addr}')
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;
      const result = await client.query(sql);
      return { ...result, nativeToken: chain.nativeToken };
    },
  },

  {
    name: 'evm_transaction_summary',
    description: 'EVM transaction summary for address',
    inputSchema: z.object({
      chain: chainIdSchema,
      address: addressSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; address: string; date_from: string; date_to: string }) => {
      const tableRef = getTableRef(args.chain, 'transactions');
      const addr = args.address.toLowerCase();
      const sql = `
        SELECT
          COUNT(*) AS total_transactions,
          COUNTIF(from_address = '${addr}') AS sent_count,
          COUNTIF(to_address = '${addr}') AS received_count,
          SUM(CAST(value AS FLOAT64)) / 1e18 AS total_value_native,
          AVG(CAST(gas_price AS FLOAT64)) / 1e9 AS avg_gas_price_gwei,
          SUM(CAST(receipt_gas_used AS FLOAT64) * CAST(gas_price AS FLOAT64)) / 1e18 AS total_gas_cost_native,
          MIN(block_timestamp) AS first_tx,
          MAX(block_timestamp) AS last_tx
        FROM ${tableRef}
        WHERE block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
          AND (from_address = '${addr}' OR to_address = '${addr}')
      `;
      return client.query(sql);
    },
  },

  {
    name: 'evm_token_transfers',
    description: 'ERC20/721 token transfers for address',
    inputSchema: z.object({
      chain: chainIdSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
      address: z.string().optional().describe('wallet address'),
      token_address: z.string().optional().describe('token contract'),
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; date_from: string; date_to: string; address?: string; token_address?: string; limit?: number }) => {
      const tableRef = getTableRef(args.chain, 'token_transfers');
      const conditions = [`block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'`];

      if (args.address) {
        const addr = args.address.toLowerCase();
        conditions.push(`(from_address = '${addr}' OR to_address = '${addr}')`);
      }
      if (args.token_address) {
        conditions.push(`token_address = '${args.token_address.toLowerCase()}'`);
      }

      if (!args.address && !args.token_address) {
        return { error: 'Provide at least one of: address, token_address' };
      }

      const limit = Math.min(args.limit ?? 100, 10000);
      const sql = `
        SELECT token_address, from_address, to_address, value,
               transaction_hash, block_timestamp, block_number
        FROM ${tableRef}
        WHERE ${conditions.join('\n  AND ')}
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;
      return client.query(sql);
    },
  },

  {
    name: 'evm_top_addresses',
    description: 'Top addresses by tx count or value',
    inputSchema: z.object({
      chain: chainIdSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
      metric: z.enum(['tx_count', 'value_sent', 'gas_spent']).describe('ranking metric'),
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; date_from: string; date_to: string; metric: string; limit?: number }) => {
      const tableRef = getTableRef(args.chain, 'transactions');
      const limit = Math.min(args.limit ?? 25, 1000);

      let metricCol: string;
      let metricAlias: string;
      switch (args.metric) {
        case 'value_sent':
          metricCol = 'SUM(CAST(value AS FLOAT64)) / 1e18';
          metricAlias = 'total_value_native';
          break;
        case 'gas_spent':
          metricCol = 'SUM(CAST(receipt_gas_used AS FLOAT64) * CAST(gas_price AS FLOAT64)) / 1e18';
          metricAlias = 'total_gas_native';
          break;
        default:
          metricCol = 'COUNT(*)';
          metricAlias = 'tx_count';
      }

      const sql = `
        SELECT from_address AS address,
               ${metricCol} AS ${metricAlias},
               COUNT(*) AS total_txns
        FROM ${tableRef}
        WHERE block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY from_address
        ORDER BY ${metricAlias} DESC
        LIMIT ${limit}
      `;
      return client.query(sql);
    },
  },

  {
    name: 'evm_contract_info',
    description: 'Get EVM smart contract details',
    inputSchema: z.object({
      chain: chainIdSchema,
      address: addressSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; address: string }) => {
      const tableRef = getTableRef(args.chain, 'contracts');
      const sql = `
        SELECT address, is_erc20, is_erc721, block_number, block_timestamp,
               SUBSTR(bytecode, 1, 100) AS bytecode_preview
        FROM ${tableRef}
        WHERE address = '${args.address.toLowerCase()}'
        LIMIT 1
      `;
      return client.query(sql);
    },
  },

  {
    name: 'evm_eth_balance',
    description: 'Get native token balance for address',
    inputSchema: z.object({
      chain: chainIdSchema,
      address: addressSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; address: string }) => {
      const chain = getChain(args.chain);
      const tableRef = getTableRef(args.chain, 'balances');
      const sql = `
        SELECT address, eth_balance
        FROM ${tableRef}
        WHERE address = '${args.address.toLowerCase()}'
        LIMIT 1
      `;
      const result = await client.query(sql);
      return {
        ...result,
        nativeToken: chain.nativeToken,
      };
    },
  },

  {
    name: 'evm_token_info',
    description: 'Get token symbol, name, decimals',
    inputSchema: z.object({
      chain: chainIdSchema,
      token_address: z.string().describe('token contract'),
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; token_address: string }) => {
      const tableRef = getTableRef(args.chain, 'tokens');
      const sql = `
        SELECT address, symbol, name, decimals, total_supply
        FROM ${tableRef}
        WHERE address = '${args.token_address.toLowerCase()}'
        LIMIT 1
      `;
      return client.query(sql);
    },
  },

  // ==========================================
  // === UTXO TOOLS (BTC, BCH, LTC, DOGE, DASH, ZEC) ===
  // ==========================================

  {
    name: 'utxo_block_stats',
    description: 'UTXO chain block stats for date range',
    inputSchema: z.object({
      chain: chainIdSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; date_from: string; date_to: string }) => {
      const tableRef = getTableRef(args.chain, 'blocks');
      const sql = `
        SELECT
          DATE(timestamp) AS date,
          COUNT(*) AS block_count,
          AVG(size) AS avg_block_size,
          AVG(transaction_count) AS avg_tx_per_block,
          SUM(transaction_count) AS total_transactions
        FROM ${tableRef}
        WHERE timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY date
        ORDER BY date DESC
        LIMIT 1000
      `;
      return client.query(sql);
    },
  },

  {
    name: 'utxo_transaction_summary',
    description: 'UTXO transaction stats for date range',
    inputSchema: z.object({
      chain: chainIdSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; date_from: string; date_to: string; limit?: number }) => {
      const tableRef = getTableRef(args.chain, 'transactions');
      const limit = Math.min(args.limit ?? 100, 10000);
      const sql = `
        SELECT
          DATE(block_timestamp) AS date,
          COUNT(*) AS tx_count,
          AVG(input_value) / 1e8 AS avg_input_value,
          AVG(output_value) / 1e8 AS avg_output_value,
          AVG(fee) / 1e8 AS avg_fee,
          SUM(fee) / 1e8 AS total_fees,
          SUM(output_value) / 1e8 AS total_output_value
        FROM ${tableRef}
        WHERE block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY date
        ORDER BY date DESC
        LIMIT ${limit}
      `;
      return client.query(sql);
    },
  },

  {
    name: 'utxo_address_activity',
    description: 'UTXO address activity (inputs + outputs)',
    inputSchema: z.object({
      chain: chainIdSchema,
      address: addressSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; address: string; date_from: string; date_to: string; limit?: number }) => {
      const chain = getChain(args.chain);
      const limit = Math.min(args.limit ?? 100, 10000);

      // Query outputs (received)
      const outputsRef = getTableRef(args.chain, 'outputs');
      const receivedSQL = `
        SELECT 'received' AS direction, transaction_hash, block_timestamp,
               value / 1e8 AS value_native, block_number
        FROM ${outputsRef}
        WHERE '${args.address}' IN UNNEST(addresses)
          AND block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
      `;

      // Query inputs (sent)
      const inputsRef = getTableRef(args.chain, 'inputs');
      const sentSQL = `
        SELECT 'sent' AS direction, transaction_hash, block_timestamp,
               value / 1e8 AS value_native, block_number
        FROM ${inputsRef}
        WHERE '${args.address}' IN UNNEST(addresses)
          AND block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
      `;

      const sql = `
        ${receivedSQL}
        UNION ALL
        ${sentSQL}
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;
      const result = await client.query(sql);
      return { ...result, nativeToken: chain.nativeToken };
    },
  },

  {
    name: 'utxo_transactions',
    description: 'List individual UTXO transactions for address',
    inputSchema: z.object({
      chain: chainIdSchema,
      address: addressSchema,
      date_from: dateFromSchema,
      date_to: dateToSchema,
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { chain: string; address: string; date_from: string; date_to: string; limit?: number }) => {
      const chain = getChain(args.chain);
      const txRef = getTableRef(args.chain, 'transactions');
      const outputsRef = getTableRef(args.chain, 'outputs');
      const inputsRef = getTableRef(args.chain, 'inputs');
      const addr = args.address;
      const limit = Math.min(args.limit ?? 100, 10000);

      const sql = `
        WITH addr_txs AS (
          SELECT DISTINCT transaction_hash AS tx_hash, 'received' AS direction
          FROM ${outputsRef}
          WHERE '${addr}' IN UNNEST(addresses)
          UNION ALL
          SELECT DISTINCT transaction_hash AS tx_hash, 'sent' AS direction
          FROM ${inputsRef}
          WHERE '${addr}' IN UNNEST(addresses)
        )
        SELECT
          t.\`hash\`,
          t.block_number,
          t.block_timestamp,
          t.input_count,
          t.output_count,
          t.input_value / 1e8 AS input_value_native,
          t.output_value / 1e8 AS output_value_native,
          t.fee / 1e8 AS fee_native,
          t.is_coinbase,
          ARRAY_AGG(DISTINCT a.direction) AS directions
        FROM ${txRef} t
        JOIN addr_txs a ON t.\`hash\` = a.tx_hash
        WHERE t.block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY t.\`hash\`, t.block_number, t.block_timestamp, t.input_count,
                 t.output_count, t.input_value, t.output_value, t.fee, t.is_coinbase
        ORDER BY t.block_timestamp DESC
        LIMIT ${limit}
      `;
      const result = await client.query(sql);
      return { ...result, nativeToken: chain.nativeToken };
    },
  },

  // ==========================================
  // === SOLANA TOOLS ===
  // ==========================================

  {
    name: 'sol_block_stats',
    description: 'Solana block stats for date range',
    inputSchema: z.object({
      date_from: dateFromSchema,
      date_to: dateToSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { date_from: string; date_to: string }) => {
      const tableRef = getTableRef('solana', 'Blocks');
      const sql = `
        SELECT
          DATE(block_timestamp) AS date,
          COUNT(*) AS block_count,
          AVG(transaction_count) AS avg_tx_per_block,
          SUM(transaction_count) AS total_transactions,
          AVG(leader_reward) / 1e9 AS avg_leader_reward_sol
        FROM ${tableRef}
        WHERE block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY date
        ORDER BY date DESC
        LIMIT 1000
      `;
      return client.query(sql);
    },
  },

  {
    name: 'sol_token_transfers',
    description: 'Solana SPL token transfers',
    inputSchema: z.object({
      date_from: dateFromSchema,
      date_to: dateToSchema,
      mint: z.string().optional().describe('token mint'),
      address: z.string().optional().describe('wallet address'),
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { date_from: string; date_to: string; mint?: string; address?: string; limit?: number }) => {
      const tableRef = getTableRef('solana', 'Token Transfers');
      const conditions = [`block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'`];

      if (args.mint) conditions.push(`mint = '${args.mint}'`);
      if (args.address) conditions.push(`(source = '${args.address}' OR destination = '${args.address}')`);

      if (!args.mint && !args.address) {
        return { error: 'Provide at least one of: mint, address' };
      }

      const limit = Math.min(args.limit ?? 100, 10000);
      const sql = `
        SELECT source, destination, mint, value, decimals,
               tx_signature, block_timestamp, transfer_type
        FROM ${tableRef}
        WHERE ${conditions.join('\n  AND ')}
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;
      return client.query(sql);
    },
  },

  {
    name: 'sol_transaction_summary',
    description: 'Solana transaction details by signature',
    inputSchema: z.object({
      signature: z.string().describe('tx signature'),
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { signature: string }) => {
      const tableRef = getTableRef('solana', 'Transactions');
      const sql = `
        SELECT signature, block_slot, block_timestamp, fee / 1e9 AS fee_sol,
               status, err, compute_units_consumed
        FROM ${tableRef}
        WHERE signature = '${args.signature}'
        LIMIT 1
      `;
      return client.query(sql);
    },
  },

  {
    name: 'sol_transactions',
    description: 'List Solana transactions for account',
    inputSchema: z.object({
      address: z.string().describe('account address'),
      date_from: dateFromSchema,
      date_to: dateToSchema,
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { address: string; date_from: string; date_to: string; limit?: number }) => {
      const tableRef = getTableRef('solana', 'Transactions');
      const addr = args.address;
      const limit = Math.min(args.limit ?? 100, 10000);

      const sql = `
        SELECT
          t.signature,
          t.block_slot,
          t.block_timestamp,
          t.fee / 1e9 AS fee_sol,
          t.status,
          t.err,
          t.compute_units_consumed
        FROM ${tableRef} t,
          UNNEST(t.accounts) AS acct
        WHERE t.block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
          AND acct.pubkey = '${addr}'
          AND acct.signer = TRUE
        ORDER BY t.block_timestamp DESC
        LIMIT ${limit}
      `;
      return client.query(sql);
    },
  },

  // ==========================================
  // === BEACON CHAIN TOOLS ===
  // ==========================================

  {
    name: 'beacon_validator_info',
    description: 'Beacon chain validator status',
    inputSchema: z.object({
      validator_index: z.number().optional().describe('validator index'),
      pubkey: z.string().optional().describe('validator pubkey'),
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { validator_index?: number; pubkey?: string }) => {
      if (!args.validator_index && !args.pubkey) {
        return { error: 'Provide validator_index or pubkey' };
      }

      const tableRef = getTableRef('ethereum2', 'beacon_validators_latest');
      const condition = args.validator_index
        ? `validator_index = ${args.validator_index}`
        : `pubkey = '${args.pubkey}'`;

      const sql = `
        SELECT validator_index, pubkey, balance / 1e9 AS balance_eth,
               effective_balance / 1e9 AS effective_balance_eth,
               status, activation_epoch, exit_epoch, slashed
        FROM ${tableRef}
        WHERE ${condition}
        LIMIT 1
      `;
      return client.query(sql);
    },
  },

  {
    name: 'beacon_block_stats',
    description: 'Beacon chain block proposal stats',
    inputSchema: z.object({
      date_from: dateFromSchema,
      date_to: dateToSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { date_from: string; date_to: string }) => {
      const tableRef = getTableRef('ethereum2', 'beacon_blocks');
      const sql = `
        SELECT
          DATE(block_timestamp) AS date,
          COUNT(*) AS total_slots,
          COUNTIF(skipped = false) AS proposed_blocks,
          COUNTIF(skipped = true) AS skipped_slots,
          ROUND(COUNTIF(skipped = false) / COUNT(*) * 100, 2) AS proposal_rate_pct
        FROM ${tableRef}
        WHERE block_timestamp BETWEEN '${args.date_from}' AND '${args.date_to}'
        GROUP BY date
        ORDER BY date DESC
        LIMIT 1000
      `;
      return client.query(sql);
    },
  },

  // ==========================================
  // === QUERY TOOLS ===
  // ==========================================

  {
    name: 'build_and_run_query',
    description: 'Build SQL from structured plan and execute',
    inputSchema: z.object({
      chain: chainIdSchema,
      table: z.string().describe('table name'),
      select: z.array(z.string()).describe('columns'),
      aggregations: z.array(z.object({
        function: z.enum(['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX']).describe('agg function'),
        column: z.string().describe('column'),
        alias: z.string().describe('result name'),
      })).optional().describe('aggregations'),
      filters: z.array(z.object({
        column: z.string().describe('column'),
        operator: z.enum(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN']).describe('operator'),
        value: z.any().describe('filter value'),
      })).describe('WHERE filters'),
      group_by: z.array(z.string()).optional().describe('GROUP BY cols'),
      order_by: z.array(z.object({
        column: z.string().describe('column'),
        direction: z.enum(['ASC', 'DESC']).describe('sort order'),
      })).optional().describe('ORDER BY'),
      limit: limitSchema,
    }),
    handler: async (client: BlockchainAnalyzerClient, args: QueryPlan) => {
      // Validate the plan
      const validation = validatePlan(args);
      if (!validation.valid) {
        return { error: 'Invalid query plan', issues: validation.errors };
      }

      // Generate SQL from plan
      const sql = buildSQL(args);

      // Execute with cost gate
      const result = await client.query(sql);

      return {
        generatedSQL: sql,
        ...result,
      };
    },
  },

  {
    name: 'run_raw_sql',
    description: 'Execute raw BigQuery SQL with cost gate',
    inputSchema: z.object({
      sql: z.string().describe('BigQuery SQL'),
      max_rows: z.number().optional().describe('max rows'),
    }),
    handler: async (client: BlockchainAnalyzerClient, args: { sql: string; max_rows?: number }) => {
      // Step 1: Validate read-only
      const readOnlyCheck = validateReadOnly(args.sql);
      if (!readOnlyCheck.valid) {
        return { error: readOnlyCheck.error };
      }

      // Step 2: Sanitize for BigQuery dialect
      const sanitized = sanitizeSQL(args.sql);

      // Step 3: Execute (dry-run cost gate is inside client.query)
      const result = await client.query(sanitized, {
        maxRows: args.max_rows,
      });

      return {
        executedSQL: sanitized,
        ...result,
      };
    },
  },
];
