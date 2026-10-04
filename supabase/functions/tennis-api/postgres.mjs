// The driver is imported by the Deno entry point. Keeping this adapter plain
// Web JavaScript lets the shared API tests run against an injected connection.
export function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('A database integer exceeds the supported range.');
  return number;
}

function safeNumeric(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) throw new Error('A database number exceeds the supported range.');
  return number;
}

export function postgresOptions() {
  return { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10,
    connection: { application_name: 'tennis-edge-api' },
    types: {
      bigint: { to: 20, from: [20], serialize: value => String(safeInteger(value)), parse: safeInteger },
      numeric: { to: 1700, from: [1700], serialize: value => String(safeNumeric(value)), parse: safeNumeric }
    }
  };
}

export function translateSql(source) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('A SQL statement is required.');
  let output = '', parameters = 0, quote = null, lineComment = false, blockComment = false;
  for (let position = 0; position < source.length; position++) {
    const char = source[position], next = source[position + 1];
    if (lineComment) { output += char; if (char === '\n') lineComment = false; continue; }
    if (blockComment) { output += char; if (char === '*' && next === '/') { output += next; position++; blockComment = false; } continue; }
    if (quote) {
      output += char;
      if (char === quote) { if (next === quote) { output += next; position++; } else quote = null; }
      continue;
    }
    if (char === '-' && next === '-') { output += char + next; position++; lineComment = true; continue; }
    if (char === '/' && next === '*') { output += char + next; position++; blockComment = true; continue; }
    if (char === "'" || char === '"') { quote = char; output += char; continue; }
    if (char === '?') {
      // Postgres cannot infer the type of a standalone nullable identity.
      const nullableIdentity = /^\s+IS\s+NULL\b/i.test(source.slice(position + 1));
      output += '$' + (++parameters) + (nullableIdentity ? '::text' : '');
    } else output += char;
  }
  // This is the shared worker's sole SQLite scalar MAX expression. Aggregate
  // MAX remains unchanged; PostgreSQL's scalar equivalent is GREATEST.
  output = output.replace(/\bMAX\(failures-1,0\)/g, 'GREATEST(failures-1,0)');
  return { sql: output, parameters };
}

function databaseError(error) {
  // PostgreSQL detail fields can contain submitted values. The shared worker
  // logs Error.message, so never forward raw driver messages or connection URLs.
  const sanitized = new Error(error?.code === '23505' ? 'UNIQUE constraint violation.' : 'Backend database query failed.');
  if (/^[A-Z0-9]{5}$/.test(error?.code || '')) sanitized.code = error.code;
  return sanitized;
}

function rowView(row) {
  // SQLite exposes SQL predicates as 0/1, whereas PostgreSQL returns booleans.
  // Preserve the shared worker's public_shared response without altering
  // nested JSONB deployment metadata.
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]));
}

class Statement {
  constructor(owner, source, values = []) { this.owner = owner; this.query = translateSql(source); this.values = values; }
  bind(...values) { const statement = Object.create(Statement.prototype); statement.owner = this.owner; statement.query = this.query; statement.values = values; return statement; }
  validate() {
    if (this.values.length !== this.query.parameters || this.values.some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))) throw new TypeError('SQL parameters must be bound primitive values.');
  }
  async execute(connection, operation) {
    this.validate();
    let result;
    try { result = await connection.unsafe(this.query.sql, this.values); } catch (error) { throw databaseError(error); }
    if (operation === 'first') return result[0] ? rowView(result[0]) : null;
    if (operation === 'all') return { results: result.map(rowView), success: true };
    return { success: true, meta: { changes: safeInteger(result.count ?? 0) } };
  }
  async first(column) { const row = await this.execute(this.owner.connection, 'first'); return column === undefined ? row : row?.[column] ?? null; }
  async all() { return this.execute(this.owner.connection, 'all'); }
  async run() {
    this.validate();
    try {
      // D1 also serializes standalone writes. The photo-count INSERT SELECT
      // must remain atomic across Edge instances, not just within one pool.
      return await this.owner.connection.begin('isolation level serializable', transaction => this.execute(transaction, 'run'));
    } catch (error) { throw databaseError(error); }
  }
}

export function createPostgresDatabase(connection) {
  if (!connection?.unsafe || !connection?.begin) throw new TypeError('A server-only PostgreSQL connection is required.');
  const owner = { connection };
  return {
    prepare(source) { return new Statement(owner, source); },
    async batch(statements) {
      if (!Array.isArray(statements) || statements.some(statement => !(statement instanceof Statement) || statement.owner !== owner)) throw new TypeError('All batch statements must belong to this database.');
      try {
        // SQLite D1 serializes whole write batches. PostgreSQL's default READ
        // COMMITTED could insert a registration account before losing the
        // conditional member bind. Serializable isolation rolls the loser back.
        return await connection.begin('isolation level serializable', async transaction => {
          const results = [];
          for (const statement of statements) results.push(await statement.execute(transaction, 'run'));
          return results;
        });
      } catch (error) { throw databaseError(error); }
    }
  };
}
