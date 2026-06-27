import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('Running database migration...');
  try {
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    await pool.query(schema);
    console.log('✓ Migration completed successfully');
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
