export interface DatabaseConnectionOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl?: boolean | 'prefer' | 'require' | 'disable';
  connectionLimit?: number;
}

/**
 * Builds a valid PostgreSQL connection URL with proper percent-encoding
 * for user, password, and database name.
 */
export function buildDatabaseUrl(opts: DatabaseConnectionOptions): string {
  const encUser = encodeURIComponent(opts.user);
  const encPass = opts.password !== undefined ? `:${encodeURIComponent(opts.password)}` : '';
  const encDb = encodeURIComponent(opts.database);
  let host = opts.host;
  if (host === 'localhost') {
    host = '127.0.0.1';
  }
  let url = `postgresql://${encUser}${encPass}@${host}:${opts.port}/${encDb}`;
  const params = new URLSearchParams();
  if (opts.ssl !== undefined) {
    if (typeof opts.ssl === 'boolean') {
      params.set('sslmode', opts.ssl ? 'require' : 'disable');
    } else {
      params.set('sslmode', opts.ssl);
    }
  }
  if (opts.connectionLimit !== undefined && opts.connectionLimit > 0) {
    params.set('connection_limit', String(opts.connectionLimit));
  }
  const query = params.toString();
  if (query) {
    url += `?${query}`;
  }
  return url;
}
