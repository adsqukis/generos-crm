import bcrypt from 'bcryptjs';
import pool from './pool.js';

async function seed() {
  console.log('Seeding database...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Admin user ---
    const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@generos.com';
    const adminPass = process.env.SEED_ADMIN_PASSWORD || 'changeme123';
    const hash = await bcrypt.hash(adminPass, 10);

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (!existing.rows[0]) {
      await client.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
        [adminEmail, hash, 'Admin', 'admin']
      );
      console.log(`✓ Admin user created: ${adminEmail} / ${adminPass}`);
    } else {
      console.log('• Admin user already exists, skipping');
    }

    // --- Default segments (priority order) ---
    const segments = [
      { name: 'High-Value Repeat', priority: 1, r: 2, f: 2, m: 2, freq: 'high', desc: 'Recent, frequent, high spenders' },
      { name: 'Power Buyer', priority: 2, r: 3, f: 2, m: 2, freq: 'high', desc: 'Frequent high-value buyers' },
      { name: 'Regular Customer', priority: 3, r: 3, f: 3, m: 3, freq: 'medium', desc: 'Steady mid-tier buyers' },
      { name: 'At-Risk High-Value', priority: 4, r: 5, f: 3, m: 2, freq: 'high', desc: 'High spenders going quiet — win back' },
      { name: 'One-Time Buyer', priority: 5, r: 5, f: 4, m: 4, freq: 'low', desc: 'Bought once, needs nurture' },
      { name: 'Dormant', priority: 6, r: 5, f: 5, m: 5, freq: 'low', desc: 'Inactive — low priority' },
    ];

    for (const s of segments) {
      const exists = await client.query('SELECT id FROM segments WHERE segment_name = $1', [s.name]);
      if (!exists.rows[0]) {
        await client.query(
          `INSERT INTO segments (segment_name, description, priority, rfm_recency_min, rfm_frequency_min, rfm_monetary_min, contact_frequency)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [s.name, s.desc, s.priority, s.r, s.f, s.m, s.freq]
        );
        console.log(`✓ Segment created: ${s.name}`);
      }
    }

    await client.query('COMMIT');
    console.log('✓ Seeding complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Seeding failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
