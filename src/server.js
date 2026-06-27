import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFileSync } from 'fs';

import pool from './db/pool.js';
import { authenticate, requireRole, authenticateJob } from './middleware/auth.js';
import { calculateRFM } from './services/rfmService.js';
import { parseFile, validateRows, dedupeCustomers } from './services/uploadService.js';
import { chatWithAI } from './services/deepseekService.js';
import { assignCohorts, recalculateCohortMetrics } from './services/cohortService.js';
import { assignSegments } from './services/segmentService.js';
import { generateCoupon, generatePromoTasks, recordRedemption, calculatePromoROI } from './services/promoService.js';
import { executeTask } from './services/deliveryService.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', apiLimiter);

// Serve frontend static files
import { fileURLToPath as _f } from 'url';
import { dirname as _d, join as _j } from 'path';
const __dir = _d(_f(import.meta.url));
app.use(express.static(_j(__dir, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// --- Health check (Railway uses this) ---
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ============================================
// AUTH
// ============================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '8h' }
    );
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CUSTOMERS
// ============================================
app.get('/api/customers', authenticate, async (req, res) => {
  const { segment, cohort, search, limit = 50, offset = 0 } = req.query;
  try {
    let sql = 'SELECT * FROM customers WHERE status != $1';
    const params = ['deleted'];
    let i = 2;
    if (segment) { sql += ` AND current_segment_id = $${i++}`; params.push(segment); }
    if (cohort) { sql += ` AND cohort_id = $${i++}`; params.push(cohort); }
    if (search) { sql += ` AND (phone_number ILIKE $${i} OR name ILIKE $${i})`; params.push(`%${search}%`); i++; }
    sql += ` ORDER BY updated_at DESC LIMIT $${i++} OFFSET $${i}`;
    params.push(limit, offset);
    const result = await pool.query(sql, params);
    res.json({ customers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:phone', authenticate, async (req, res) => {
  try {
    const customer = await pool.query('SELECT * FROM customers WHERE phone_number = $1', [req.params.phone]);
    const purchases = await pool.query('SELECT * FROM purchases WHERE customer_phone = $1 ORDER BY purchase_date DESC', [req.params.phone]);
    if (!customer.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customer: customer.rows[0], purchases: purchases.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// UPLOAD
// ============================================
app.post('/api/uploads', authenticate, requireRole('admin', 'marketing_manager'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const client = await pool.connect();
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const { valid, errors } = validateRows(rows);
    const customers = dedupeCustomers(valid);

    await client.query('BEGIN');
    let newCount = 0, updatedCount = 0;

    for (const cust of customers) {
      // Upsert customer
      const existing = await client.query('SELECT phone_number FROM customers WHERE phone_number = $1', [cust.phone_number]);
      const earliestDate = cust.purchases.reduce((min, p) => p.purchase_date < min ? p.purchase_date : min, cust.purchases[0].purchase_date);

      if (existing.rows[0]) {
        updatedCount++;
      } else {
        // Assign cohort based on earliest purchase date
        const { ensureCohort } = await import('./services/cohortService.js');
        const cohortId = await ensureCohort(client, earliestDate);
        await client.query(
          'INSERT INTO customers (phone_number, name, email, date_added, cohort_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [cust.phone_number, cust.name, cust.email, earliestDate, cohortId, req.user.id]
        );
        newCount++;
      }

      // Insert purchases
      for (const p of cust.purchases) {
        await client.query(
          'INSERT INTO purchases (customer_phone, purchase_date, purchase_amount, product_category, quantity, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [cust.phone_number, p.purchase_date, p.purchase_amount, p.product_category, p.quantity, p.source, req.user.id]
        );
      }

      // Recalculate RFM
      const agg = await client.query(
        'SELECT COUNT(*) as cnt, SUM(purchase_amount) as total, MAX(purchase_date) as last FROM purchases WHERE customer_phone = $1',
        [cust.phone_number]
      );
      const { cnt, total, last } = agg.rows[0];
      const rfm = calculateRFM({ lastPurchaseDate: last, purchaseCount: parseInt(cnt), totalSpend: parseFloat(total) });
      await client.query(
        'UPDATE customers SET rfm_score=$1, rfm_recency=$2, rfm_frequency=$3, rfm_monetary=$4, last_interaction_date=$5, updated_at=NOW() WHERE phone_number=$6',
        [rfm.score, rfm.recency, rfm.frequency, rfm.monetary, last, cust.phone_number]
      );
    }

    // Log upload
    await client.query(
      'INSERT INTO upload_history (file_name, uploaded_by, total_rows, success_count, error_count, error_log, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.file.originalname, req.user.id, rows.length, valid.length, errors.length, JSON.stringify(errors), 'completed']
    );

    await client.query('COMMIT');
    res.json({ success: true, newCustomers: newCount, updatedCustomers: updatedCount, errors });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================
// COHORTS & SEGMENTS
// ============================================
app.get('/api/cohorts', authenticate, async (req, res) => {
  const result = await pool.query('SELECT * FROM cohorts ORDER BY start_date DESC');
  res.json({ cohorts: result.rows });
});

app.get('/api/segments', authenticate, async (req, res) => {
  const result = await pool.query('SELECT * FROM segments ORDER BY priority ASC');
  res.json({ segments: result.rows });
});

app.post('/api/segments', authenticate, requireRole('admin', 'marketing_manager'), async (req, res) => {
  const s = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO segments (segment_name, description, priority, rfm_recency_min, rfm_frequency_min, rfm_monetary_min, contact_frequency, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [s.segment_name, s.description, s.priority, s.rfm_recency_min, s.rfm_frequency_min, s.rfm_monetary_min, s.contact_frequency, req.user.id]
    );
    res.json({ segment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CHAT (Deepseek)
// ============================================
app.post('/api/chat/message', authenticate, requireRole('admin', 'marketing_manager', 'sales_lead'), async (req, res) => {
  const { message, conversationId } = req.body;
  try {
    const cohorts = (await pool.query('SELECT cohort_name, total_customers, repeat_purchase_rate, avg_ltv, churn_rate FROM cohorts')).rows;
    const segments = (await pool.query('SELECT segment_name, customer_count FROM segments')).rows;
    const businessConstraints = {
      max_discount_pct: parseInt(process.env.MAX_DISCOUNT_PCT) || 50,
      min_cohort_size_for_analysis: parseInt(process.env.MIN_COHORT_SIZE_ANALYSIS) || 100,
    };

    const { reply, usage } = await chatWithAI({
      userMessage: message,
      context: { cohorts, segments, businessConstraints },
    });

    // Log conversation
    const convId = conversationId || crypto.randomUUID();
    await pool.query(
      'INSERT INTO chat_messages (conversation_id, user_id, message_text, message_type) VALUES ($1,$2,$3,$4)',
      [convId, req.user.id, message, 'user_query']
    );
    await pool.query(
      'INSERT INTO chat_messages (conversation_id, user_id, message_text, message_type, ai_model) VALUES ($1,$2,$3,$4,$5)',
      [convId, req.user.id, reply, 'ai_response', process.env.DEEPSEEK_MODEL]
    );

    res.json({ reply, conversationId: convId, usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// BATCH JOBS (external cron trigger)
// ============================================
app.post('/api/jobs/recalculate-rfm', authenticateJob, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Recalculate RFM for all customers
    const customers = (await client.query("SELECT phone_number FROM customers WHERE status != 'deleted'")).rows;
    let rfmUpdated = 0;
    for (const c of customers) {
      const agg = await client.query(
        'SELECT COUNT(*) as cnt, SUM(purchase_amount) as total, MAX(purchase_date) as last FROM purchases WHERE customer_phone = $1',
        [c.phone_number]
      );
      const { cnt, total, last } = agg.rows[0];
      const rfm = calculateRFM({ lastPurchaseDate: last, purchaseCount: parseInt(cnt), totalSpend: parseFloat(total || 0) });
      await client.query(
        'UPDATE customers SET rfm_score=$1, rfm_recency=$2, rfm_frequency=$3, rfm_monetary=$4, last_interaction_date=$5 WHERE phone_number=$6',
        [rfm.score, rfm.recency, rfm.frequency, rfm.monetary, last, c.phone_number]
      );
      rfmUpdated++;
    }

    // 2. Assign cohorts (for any unassigned)
    const cohortsAssigned = await assignCohorts(client);

    // 3. Recalculate cohort metrics
    const churnDays = parseInt(process.env.CHURN_THRESHOLD_DAYS) || 90;
    const cohortsUpdated = await recalculateCohortMetrics(client, churnDays);

    // 4. Reassign segments based on new RFM
    const segmentResult = await assignSegments(client);

    await client.query('COMMIT');
    res.json({
      success: true,
      rfmUpdated,
      cohortsAssigned,
      cohortsUpdated,
      segments: segmentResult,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================
// PROMO STRATEGIES
// ============================================
app.get('/api/promo-strategies', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promo_strategies ORDER BY created_at DESC');
    res.json({ strategies: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promo-strategies', authenticate, requireRole('admin', 'marketing_manager'), async (req, res) => {
  const s = req.body;
  try {
    const coupon = s.coupon_code || generateCoupon(s.strategy_name);
    const result = await pool.query(
      `INSERT INTO promo_strategies
        (strategy_name, description, discount_type, discount_value, coupon_code, validity_days,
         delivery_channel, delivery_frequency, delivery_trigger, min_purchase_amount, max_per_customer,
         budget_allocated, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [s.strategy_name, s.description, s.discount_type, s.discount_value, coupon, s.validity_days || 30,
       s.delivery_channel, s.delivery_frequency || 'one_time', s.delivery_trigger || 'on_segment_assignment',
       s.min_purchase_amount || 0, s.max_per_customer || 1, s.budget_allocated || 0, 'draft', req.user.id]
    );
    res.json({ strategy: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promo-strategies/:id/approve', authenticate, requireRole('admin', 'marketing_manager'), async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE promo_strategies SET status = 'active', approved_at = NOW(), approved_by = $1 WHERE id = $2 RETURNING *",
      [req.user.id, req.params.id]
    );
    res.json({ strategy: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/promo-strategies/:id/roi', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const roi = await calculatePromoROI(client, req.params.id);
    res.json(roi);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/promo-redemptions', authenticate, async (req, res) => {
  const { strategyId, customerPhone, couponCode, amountRedeemed } = req.body;
  const client = await pool.connect();
  try {
    const result = await recordRedemption(client, { strategyId, customerPhone, couponCode, amountRedeemed });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================
// FOLLOW-UP TASKS
// ============================================
app.get('/api/tasks', authenticate, async (req, res) => {
  const { status, assigned_to } = req.query;
  try {
    let sql = 'SELECT * FROM follow_up_tasks WHERE 1=1';
    const params = [];
    let i = 1;
    if (status) { sql += ` AND status = $${i++}`; params.push(status); }
    if (assigned_to) { sql += ` AND assigned_to_user_id = $${i++}`; params.push(assigned_to); }
    // sales_lead and team_member only see their own tasks
    if (['sales_lead', 'team_member'].includes(req.user.role)) {
      sql += ` AND assigned_to_user_id = $${i++}`;
      params.push(req.user.id);
    }
    sql += ' ORDER BY scheduled_date ASC LIMIT 200';
    const result = await pool.query(sql, params);
    res.json({ tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id/status', authenticate, async (req, res) => {
  const { status, notes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE follow_up_tasks SET status = $1, notes = COALESCE($2, notes), status_updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, notes, req.params.id]
    );
    res.json({ task: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/approve', authenticate, requireRole('admin', 'marketing_manager'), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE follow_up_tasks SET approved_by_user_id = $1, approved_at = NOW() WHERE id = $2 RETURNING *',
      [req.user.id, req.params.id]
    );
    res.json({ task: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/execute', authenticate, requireRole('admin', 'marketing_manager', 'sales_lead'), async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await executeTask(client, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/tasks/overdue', authenticate, requireRole('admin', 'marketing_manager'), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM follow_up_tasks WHERE status = 'pending' AND scheduled_date < CURRENT_DATE - 7 ORDER BY scheduled_date ASC"
    );
    res.json({ overdueTasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate promo tasks for a segment
app.post('/api/segments/:id/generate-tasks', authenticate, requireRole('admin', 'marketing_manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await generatePromoTasks(client, req.params.id, { assignedBy: req.user.id });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================
// DASHBOARD OVERVIEW
// ============================================
app.get('/api/dashboard/overview', authenticate, async (req, res) => {
  try {
    const totalCustomers = (await pool.query("SELECT COUNT(*) as c FROM customers WHERE status != 'deleted'")).rows[0].c;
    const activeCohorts = (await pool.query('SELECT COUNT(*) as c FROM cohorts')).rows[0].c;
    const repeatRate = (await pool.query(
      "SELECT ROUND(AVG(CASE WHEN rfm_frequency >= 2 THEN 100.0 ELSE 0 END), 1) as r FROM customers WHERE status != 'deleted'"
    )).rows[0].r;
    const pendingTasks = (await pool.query("SELECT COUNT(*) as c FROM follow_up_tasks WHERE status = 'pending'")).rows[0].c;
    const lastUpload = (await pool.query('SELECT file_name, created_at, success_count FROM upload_history ORDER BY created_at DESC LIMIT 1')).rows[0];

    res.json({
      totalCustomers: parseInt(totalCustomers),
      activeCohorts: parseInt(activeCohorts),
      repeatRate: parseFloat(repeatRate || 0),
      pendingTasks: parseInt(pendingTasks),
      lastUpload: lastUpload || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Temporary: setup endpoint (REMOVE AFTER USE) ---
app.post('/api/setup/run', async (req, res) => {
  try {
    console.log('=== SETUP START ===');
    const bcrypt = (await import('bcryptjs')).default;
    console.log('bcrypt loaded');
    
    // Read + run schema
    const __setupDir = _d(_f(import.meta.url));
    console.log('Setup dir:', __setupDir);
    const schema = readFileSync(_j(__setupDir, 'db/schema.sql'), 'utf-8');
    console.log('Schema length:', schema.length);
    await pool.query(schema);
    console.log('✓ Migration done');

    // Create admin user
    const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@generos.com';
    const adminPass = process.env.SEED_ADMIN_PASSWORD || 'changeme123';
    const hash = await bcrypt.hash(adminPass, 10);
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [adminEmail, hash, 'Admin', 'admin']
    );
    console.log('✓ Admin user created');

    // Create default segments
    const segments = [
      { name: 'High-Value Repeat', priority: 1, r: 2, f: 2, m: 2, freq: 'high', desc: 'Recent, frequent, high spenders' },
      { name: 'Power Buyer', priority: 2, r: 3, f: 2, m: 2, freq: 'high', desc: 'Frequent high-value buyers' },
      { name: 'Regular Customer', priority: 3, r: 3, f: 3, m: 3, freq: 'medium', desc: 'Steady mid-tier buyers' },
      { name: 'At-Risk High-Value', priority: 4, r: 5, f: 3, m: 2, freq: 'high', desc: 'High spenders going quiet' },
      { name: 'One-Time Buyer', priority: 5, r: 5, f: 4, m: 4, freq: 'low', desc: 'Bought once, needs nurture' },
      { name: 'Dormant', priority: 6, r: 5, f: 5, m: 5, freq: 'low', desc: 'Inactive — low priority' },
    ];
    for (const s of segments) {
      await pool.query(
        `INSERT INTO segments (segment_name, description, priority, rfm_recency_min, rfm_frequency_min, rfm_monetary_min, contact_frequency)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [s.name, s.desc, s.priority, s.r, s.f, s.m, s.freq]
      );
    }
    console.log('✓ Segments created');

    res.json({ status: 'ok', message: 'Migration + seed completed', admin: { email: adminEmail } });
  } catch (err) {
    console.error('=== SETUP ERROR ===', err);
    res.status(500).json({ error: err.message || err.code || 'Unknown error' });
  }
});

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Generos CRM server running on port ${PORT}`);
});

export default app;
