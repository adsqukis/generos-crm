import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Railway PostgreSQL — connect via individual params for better SSL control
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'railway',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

console.log('DB config:', {
  host: process.env.PGHOST || '(not set)',
  port: process.env.PGPORT || '5432',
  database: process.env.PGDATABASE || 'railway',
  user: process.env.PGUSER || 'postgres',
  ssl: process.env.PGSSLMODE || 'false (no PGSSLMODE)',
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
export default pool;
