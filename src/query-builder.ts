/**
 * Structured Query Plan → BigQuery SQL Generator
 *
 * Takes a structured query plan from the LLM and deterministically
 * generates correct BigQuery SQL. The LLM never writes SQL directly —
 * it provides the plan, this module generates the SQL.
 */

import { getChain, getTableRef } from './config.js';

// ===== Plan Types =====

export type AggFunction = 'SUM' | 'AVG' | 'COUNT' | 'COUNT_DISTINCT' | 'MIN' | 'MAX';
export type FilterOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN' | 'NOT IN' | 'IS NULL' | 'IS NOT NULL' | 'BETWEEN';

export interface AggregateSpec {
  function: AggFunction;
  column: string;
  alias: string;
}

export interface FilterSpec {
  column: string;
  operator: FilterOperator;
  value: string | number | string[] | [string, string];
}

export interface OrderSpec {
  column: string;
  direction: 'ASC' | 'DESC';
}

export interface QueryPlan {
  chain: string;
  table: string;
  select: string[];
  aggregations?: AggregateSpec[];
  filters: FilterSpec[];
  group_by?: string[];
  order_by?: OrderSpec[];
  limit?: number;
}

// ===== SQL Generation =====

/**
 * BigQuery reserved words that must be backtick-quoted
 */
const RESERVED_WORDS = new Set([
  'all', 'and', 'any', 'array', 'as', 'asc', 'assert_rows_modified', 'at',
  'between', 'by', 'case', 'cast', 'collate', 'contains', 'create', 'cross',
  'cube', 'current', 'default', 'define', 'desc', 'distinct', 'else', 'end',
  'enum', 'escape', 'except', 'exclude', 'exists', 'extract', 'false', 'fetch',
  'following', 'for', 'from', 'full', 'group', 'grouping', 'groups', 'hash',
  'having', 'if', 'ignore', 'in', 'inner', 'intersect', 'interval', 'into',
  'is', 'join', 'lateral', 'left', 'like', 'limit', 'lookup', 'merge', 'natural',
  'new', 'no', 'not', 'null', 'nulls', 'of', 'on', 'or', 'order', 'outer',
  'over', 'partition', 'preceding', 'proto', 'range', 'recursive', 'respect',
  'right', 'rollup', 'rows', 'select', 'set', 'some', 'struct', 'tablesample',
  'then', 'to', 'treat', 'true', 'unbounded', 'union', 'unnest', 'using',
  'when', 'where', 'window', 'with', 'within',
]);

/**
 * Sanitize a SQL identifier (column name), backtick-quote if reserved
 */
function sanitizeIdentifier(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_.*]/g, '');
  if (clean === '*') return '*';
  if (RESERVED_WORDS.has(clean.toLowerCase())) return `\`${clean}\``;
  return clean;
}

/**
 * Escape a SQL string value
 */
function escapeString(value: string): string {
  return value.replace(/'/g, "\\'");
}

/**
 * Format a filter value for BigQuery SQL
 */
function formatFilterValue(filter: FilterSpec): string {
  const { operator, value } = filter;

  if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
    return '';
  }

  if (operator === 'IN' || operator === 'NOT IN') {
    if (!Array.isArray(value)) throw new Error(`IN/NOT IN requires array value for ${filter.column}`);
    const formatted = (value as string[]).map(v =>
      typeof v === 'number' ? String(v) : `'${escapeString(String(v))}'`
    ).join(', ');
    return `(${formatted})`;
  }

  if (operator === 'BETWEEN') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error(`BETWEEN requires [start, end] array for ${filter.column}`);
    }
    const [start, end] = value;
    return `'${escapeString(String(start))}' AND '${escapeString(String(end))}'`;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return `'${escapeString(String(value))}'`;
}

/**
 * Build an aggregate expression
 */
function buildAggregate(agg: AggregateSpec): string {
  const col = sanitizeIdentifier(agg.column);

  switch (agg.function) {
    case 'COUNT_DISTINCT':
      return `COUNT(DISTINCT ${col}) AS ${sanitizeIdentifier(agg.alias)}`;
    case 'COUNT':
      return agg.column === '*'
        ? `COUNT(*) AS ${sanitizeIdentifier(agg.alias)}`
        : `COUNT(${col}) AS ${sanitizeIdentifier(agg.alias)}`;
    case 'SUM':
      return `SUM(CAST(${col} AS FLOAT64)) AS ${sanitizeIdentifier(agg.alias)}`;
    case 'AVG':
      return `AVG(CAST(${col} AS FLOAT64)) AS ${sanitizeIdentifier(agg.alias)}`;
    default:
      return `${agg.function}(${col}) AS ${sanitizeIdentifier(agg.alias)}`;
  }
}

/**
 * Generate BigQuery SQL from a structured query plan
 */
export function buildSQL(plan: QueryPlan): string {
  // Validate chain exists
  getChain(plan.chain);
  const tableRef = getTableRef(plan.chain, plan.table);

  // Build SELECT clause
  const selectParts: string[] = [];

  // Add plain columns
  for (const col of plan.select) {
    selectParts.push(sanitizeIdentifier(col));
  }

  // Add aggregates
  if (plan.aggregations?.length) {
    for (const agg of plan.aggregations) {
      selectParts.push(buildAggregate(agg));
    }
  }

  if (selectParts.length === 0) {
    selectParts.push('*');
  }

  // Build WHERE clause
  const whereParts: string[] = [];
  for (const filter of plan.filters) {
    const col = sanitizeIdentifier(filter.column);
    const op = filter.operator;

    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      whereParts.push(`${col} ${op}`);
    } else {
      const val = formatFilterValue(filter);
      whereParts.push(`${col} ${op} ${val}`);
    }
  }

  // Assemble SQL
  let sql = `SELECT ${selectParts.join(',\n       ')}\nFROM ${tableRef}`;

  if (whereParts.length > 0) {
    sql += `\nWHERE ${whereParts.join('\n  AND ')}`;
  }

  if (plan.group_by?.length) {
    const groupCols = plan.group_by.map(sanitizeIdentifier).join(', ');
    sql += `\nGROUP BY ${groupCols}`;
  }

  if (plan.order_by?.length) {
    const orderCols = plan.order_by
      .map(o => `${sanitizeIdentifier(o.column)} ${o.direction}`)
      .join(', ');
    sql += `\nORDER BY ${orderCols}`;
  }

  const limit = plan.limit ?? 100;
  sql += `\nLIMIT ${Math.min(limit, 10000)}`;

  return sql;
}

/**
 * Validate a query plan has required fields
 */
export function validatePlan(plan: QueryPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!plan.chain) errors.push('chain is required');
  if (!plan.table) errors.push('table is required');
  if (!plan.filters || plan.filters.length === 0) {
    errors.push('At least one filter is required (e.g., date range)');
  }

  // Check for aggregation/group_by consistency
  if (plan.aggregations?.length && plan.select.length > 0 && (!plan.group_by || plan.group_by.length === 0)) {
    errors.push('When using aggregations with select columns, group_by is required');
  }

  return { valid: errors.length === 0, errors };
}
