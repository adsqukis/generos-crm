import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Debug: log sanitized connection info
const rawUrl = process.env.DATABASE_URL || '';
const sanitized = rawUrl.replace(/\/\/[^@]+@/, '//USER:PASS@');
const hasSslMode = rawUrl.includes('sslmode');
console.log('DB URL (sanitized):', sanitized || '(not set)');
console.log('DB PGUSER:', process.env.PGUSER || '(not set)');
console.log('DB PGPORT:', process.env.PGPORT || '(not set)');
console.log('DB PGHOST:', process.env.PGHOST || '(not set)');

// Decide SSL: internal Railway (port 5432) = no SSL needed
const isInternal = !rawUrl.includes('tcp') && !rawUrl.includes('public');
const sslConfig = isInternal ? false : { rejectUnauthorized: false };
console.log('DB SSL:', sslConfig === false ? 'false (internal)' : 'true (public)');

const pool = new Pool({
  connectionString: rawUrl || undefined,
  ssl: sslConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
export default pool;
