/**
 * BigQuery SQL Sanitizer
 *
 * Ported from AgenticLedger NL-to-SQL dialectStrategy.ts
 * Handles BigQuery-specific SQL sanitization and type fixing.
 */

/**
 * Map PostgreSQL types to BigQuery types
 */
function mapPGTypeToBigQuery(pgType: string): string {
  const typeMap: Record<string, string> = {
    text: 'STRING',
    varchar: 'STRING',
    char: 'STRING',
    integer: 'INT64',
    int: 'INT64',
    bigint: 'INT64',
    smallint: 'INT64',
    double: 'FLOAT64',
    float: 'FLOAT64',
    real: 'FLOAT64',
    numeric: 'NUMERIC',
    decimal: 'NUMERIC',
    boolean: 'BOOL',
    bool: 'BOOL',
    date: 'DATE',
    timestamp: 'TIMESTAMP',
    timestamptz: 'TIMESTAMP',
    time: 'TIME',
    json: 'JSON',
    jsonb: 'JSON',
  };
  return typeMap[pgType.toLowerCase()] || pgType.toUpperCase();
}

/**
 * Fix common SQL typos
 */
function sanitizeTypos(sql: string): string {
  return sql
    .replace(/GROPU\s+BY/gi, 'GROUP BY')
    .replace(/GROBY/gi, 'GROUP BY')
    .replace(/SLECT\s/gi, 'SELECT ')
    .replace(/\sFORM\s/gi, ' FROM ')
    .replace(/WEHRE\s/gi, 'WHERE ')
    .replace(/ODRER\s+BY/gi, 'ORDER BY')
    .replace(/LIMT\s/gi, 'LIMIT ');
}

/**
 * BigQuery-specific SQL sanitization
 */
function sanitizeBigQuery(sql: string): string {
  let result = sql;

  // Handle multi-word PostgreSQL types
  result = result.replace(/::double\s+precision/gi, '::FLOAT64');
  result = result.replace(/::character\s+varying/gi, '::STRING');
  result = result.replace(/::timestamp\s+with\s+time\s+zone/gi, '::TIMESTAMP');
  result = result.replace(/::timestamp\s+without\s+time\s+zone/gi, '::TIMESTAMP');

  // Fix standalone DOUBLE PRECISION
  result = result.replace(/\bDOUBLE\s+PRECISION\b/gi, 'FLOAT64');

  // Convert PostgreSQL :: cast syntax to BigQuery CAST()
  result = result.replace(/(\b[\w.]+|\([^)]+\)|'[^']*')::(\w+)/g, (_match, expr, pgType) => {
    const bqType = mapPGTypeToBigQuery(pgType);
    return `CAST(${expr} AS ${bqType})`;
  });

  // Fix CAST expressions with wrong types
  result = result.replace(/\bCAST\s*\(([^)]+)\s+AS\s+DOUBLE\s*\)/gi, 'CAST($1 AS FLOAT64)');
  result = result.replace(/\bCAST\s*\(([^)]+)\s+AS\s+TEXT\s*\)/gi, 'CAST($1 AS STRING)');
  result = result.replace(/\bCAST\s*\(([^)]+)\s+AS\s+INTEGER\s*\)/gi, 'CAST($1 AS INT64)');
  result = result.replace(/\bCAST\s*\(([^)]+)\s+AS\s+BOOLEAN\s*\)/gi, 'CAST($1 AS BOOL)');

  // Fix string concatenation (|| → CONCAT)
  result = result.replace(/(\w+)\s*\|\|\s*(\w+)/g, 'CONCAT($1, $2)');

  return result;
}

/**
 * Normalize whitespace
 */
function normalizeWhitespace(sql: string): string {
  let result = sql.replace(/--(.*)$/gm, '/*$1*/');
  result = result.replace(/[ \t]+/g, ' ').trim();
  return result;
}

/**
 * Validate SQL is read-only (SELECT only)
 */
export function validateReadOnly(sql: string): { valid: boolean; error?: string } {
  const trimmed = sql.trim().toUpperCase();

  const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'MERGE', 'GRANT', 'REVOKE'];
  for (const keyword of dangerous) {
    if (trimmed.startsWith(keyword)) {
      return { valid: false, error: `Only SELECT queries are allowed. Found: ${keyword}` };
    }
  }

  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    return { valid: false, error: 'Query must start with SELECT or WITH (CTE)' };
  }

  return { valid: true };
}

/**
 * Full sanitization pipeline for BigQuery SQL
 */
export function sanitizeSQL(sql: string): string {
  let result = normalizeWhitespace(sql);
  result = sanitizeTypos(result);
  result = sanitizeBigQuery(result);
  return result;
}
