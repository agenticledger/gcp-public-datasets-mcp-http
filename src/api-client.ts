/**
 * BlockchainAnalyzer BigQuery Client
 *
 * Wraps Google BigQuery SDK for blockchain dataset queries.
 * Handles auth, query execution, dry-runs, and schema discovery.
 */

import { BigQuery, type QueryResultsOptions } from '@google-cloud/bigquery';

export interface QueryOptions {
  maxRows?: number;
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface DryRunResult {
  estimatedBytes: number;
  estimatedGB: number;
  estimatedCostUSD: number;
}

export interface QueryResult {
  rows: any[];
  totalRows: number;
  estimatedBytes: number;
  estimatedCostUSD: number;
  executionTimeMs: number;
}

export interface TableInfo {
  tableId: string;
  columns: Array<{
    name: string;
    type: string;
    mode: string;
    fields?: Array<{ name: string; type: string; mode: string }>;
  }>;
  numRows: number;
  sizeGB: number;
  partitioning: string | null;
}

export interface DatasetInfo {
  project: string;
  dataset: string;
  tables: Record<string, TableInfo>;
  tableCount: number;
}

const COST_PER_TB_USD = 5.0;

export class BlockchainAnalyzerClient {
  private bigquery: BigQuery;
  private projectId: string;
  private maxCostPerQueryUSD: number;
  private hardCostCapUSD: number;
  private maxRows: number;
  private queryTimeoutMs: number;

  constructor(
    credentialsPathOrObject: string | Record<string, unknown>,
    projectId: string,
    options?: {
      maxCostPerQueryUSD?: number;
      hardCostCapUSD?: number;
      maxRows?: number;
      queryTimeoutSeconds?: number;
    }
  ) {
    this.projectId = projectId;
    this.maxCostPerQueryUSD = options?.maxCostPerQueryUSD ?? 1.0;
    this.hardCostCapUSD = options?.hardCostCapUSD ?? 5.0;
    this.maxRows = options?.maxRows ?? 10000;
    this.queryTimeoutMs = (options?.queryTimeoutSeconds ?? 30) * 1000;

    if (typeof credentialsPathOrObject === 'string') {
      this.bigquery = new BigQuery({
        projectId,
        keyFilename: credentialsPathOrObject,
      });
    } else {
      this.bigquery = new BigQuery({
        projectId,
        credentials: credentialsPathOrObject as any,
      });
    }
  }

  /**
   * Dry-run a query to estimate cost without executing
   */
  async dryRun(sql: string): Promise<DryRunResult> {
    const [job] = await this.bigquery.createQueryJob({
      query: sql,
      dryRun: true,
      useLegacySql: false,
    });

    const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0', 10);
    const estimatedGB = estimatedBytes / (1024 ** 3);
    const estimatedCostUSD = (estimatedBytes / (1024 ** 4)) * COST_PER_TB_USD;

    return {
      estimatedBytes,
      estimatedGB: Math.round(estimatedGB * 100) / 100,
      estimatedCostUSD: Math.round(estimatedCostUSD * 10000) / 10000,
    };
  }

  /**
   * Execute a query with cost gate and row limits
   */
  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const maxRows = options?.maxRows ?? this.maxRows;
    const timeoutMs = options?.timeoutMs ?? this.queryTimeoutMs;

    // Step 1: Dry-run cost check
    if (!options?.dryRun) {
      const estimate = await this.dryRun(sql);

      if (estimate.estimatedCostUSD > this.hardCostCapUSD) {
        throw new Error(
          `Query rejected: estimated cost $${estimate.estimatedCostUSD.toFixed(4)} ` +
          `exceeds hard cap of $${this.hardCostCapUSD.toFixed(2)}. ` +
          `Estimated scan: ${estimate.estimatedGB.toFixed(2)} GB. ` +
          `Add date filters or narrow your query.`
        );
      }

      if (estimate.estimatedCostUSD > this.maxCostPerQueryUSD) {
        throw new Error(
          `Query rejected: estimated cost $${estimate.estimatedCostUSD.toFixed(4)} ` +
          `exceeds per-query limit of $${this.maxCostPerQueryUSD.toFixed(2)}. ` +
          `Estimated scan: ${estimate.estimatedGB.toFixed(2)} GB. ` +
          `Add date filters or narrow your query.`
        );
      }
    }

    // Step 2: Execute
    const start = Date.now();

    const [job] = await this.bigquery.createQueryJob({
      query: sql,
      useLegacySql: false,
      maximumBytesBilled: String(Math.round(this.hardCostCapUSD / COST_PER_TB_USD * (1024 ** 4))),
    });

    const queryOptions: QueryResultsOptions = {
      maxResults: maxRows,
      timeoutMs: timeoutMs,
    };

    const [rows] = await job.getQueryResults(queryOptions);
    const executionTimeMs = Date.now() - start;

    const estimatedBytes = parseInt(job.metadata?.statistics?.query?.totalBytesProcessed || '0', 10);
    const estimatedCostUSD = (estimatedBytes / (1024 ** 4)) * COST_PER_TB_USD;

    return {
      rows: rows || [],
      totalRows: rows?.length || 0,
      estimatedBytes,
      estimatedCostUSD: Math.round(estimatedCostUSD * 10000) / 10000,
      executionTimeMs,
    };
  }

  /**
   * List tables in a dataset
   */
  async listTables(project: string, dataset: string): Promise<string[]> {
    const datasetRef = this.bigquery.dataset(dataset, { projectId: project });
    const [tables] = await datasetRef.getTables();
    return tables.map((t: any) => t.id || t.metadata?.tableReference?.tableId);
  }

  /**
   * Get full table schema
   */
  async getTableSchema(project: string, dataset: string, table: string): Promise<TableInfo> {
    const tableRef = this.bigquery.dataset(dataset, { projectId: project }).table(table);
    const [metadata] = await tableRef.getMetadata();

    const columns = (metadata.schema?.fields || []).map((field: any) => ({
      name: field.name,
      type: field.type,
      mode: field.mode || 'NULLABLE',
      ...(field.fields?.length ? {
        fields: field.fields.map((f: any) => ({
          name: f.name,
          type: f.type,
          mode: f.mode || 'NULLABLE',
        })),
      } : {}),
    }));

    return {
      tableId: table,
      columns,
      numRows: parseInt(metadata.numRows || '0', 10),
      sizeGB: Math.round((parseInt(metadata.numBytes || '0', 10) / (1024 ** 3)) * 100) / 100,
      partitioning: metadata.timePartitioning
        ? `${metadata.timePartitioning.type} on ${metadata.timePartitioning.field || 'default'}`
        : null,
    };
  }

  /**
   * Get full dataset info with all table schemas
   */
  async getDatasetInfo(project: string, dataset: string): Promise<DatasetInfo> {
    const tableNames = await this.listTables(project, dataset);
    const tables: Record<string, TableInfo> = {};

    for (const tableName of tableNames) {
      tables[tableName] = await this.getTableSchema(project, dataset, tableName);
    }

    return {
      project,
      dataset,
      tables,
      tableCount: tableNames.length,
    };
  }
}
