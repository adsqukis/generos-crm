// ============================================
// Promo & Follow-up Task Service
// ============================================

import crypto from 'crypto';

/**
 * Generate a unique coupon code: GENEROS_<SEGMENT>_<6CHARS>
 */
export function generateCoupon(segmentName = 'GEN') {
  const prefix = segmentName.replace(/[^A-Za-z]/g, '').substring(0, 6).toUpperCase() || 'GEN';
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `GENEROS_${prefix}_${random}`;
}

/**
 * Create follow-up tasks for all customers in a segment that has a promo strategy.
 * Returns count of tasks created.
 */
export async function generatePromoTasks(client, segmentId, options = {}) {
  const assignedBy = options.assignedBy || null;

  const segment = (await client.query('SELECT * FROM segments WHERE id = $1', [segmentId])).rows[0];
  if (!segment) throw new Error('Segment not found');
  if (!segment.assigned_promo_strategy_id) {
    return { created: 0, note: 'Segment has no promo strategy assigned' };
  }

  const strategy = (await client.query('SELECT * FROM promo_strategies WHERE id = $1', [segment.assigned_promo_strategy_id])).rows[0];
  if (!strategy || strategy.status !== 'active') {
    return { created: 0, note: 'Promo strategy not active' };
  }

  const customers = (await client.query(
    "SELECT phone_number, name FROM customers WHERE current_segment_id = $1 AND status = 'active'",
    [segmentId]
  )).rows;

  // Determine if approval needed (high-value discount)
  const requiresApproval =
    (strategy.discount_type === 'fixed_amount' && parseFloat(strategy.discount_value) > 50) ||
    strategy.delivery_channel === 'manual_call';

  let created = 0;
  const today = new Date();
  const scheduledDate = today.getHours() >= 17
    ? new Date(today.getTime() + 86400000).toISOString().split('T')[0]
    : today.toISOString().split('T')[0];

  for (const customer of customers) {
    // Skip if a pending promo task already exists for this customer+strategy
    const existing = await client.query(
      "SELECT id FROM follow_up_tasks WHERE customer_phone = $1 AND promo_strategy_id = $2 AND status = 'pending'",
      [customer.phone_number, strategy.id]
    );
    if (existing.rows[0]) continue;

    const message = `Send "${strategy.strategy_name}" to ${customer.name}`;

    await client.query(
      `INSERT INTO follow_up_tasks
        (customer_phone, segment_id, promo_strategy_id, task_type, task_title, description,
         scheduled_date, channel, status, requires_approval, assigned_by_user_id, assigned_at, created_by)
       VALUES ($1,$2,$3,'send_promo',$4,$5,$6,$7,'pending',$8,$9,NOW(),$9)`,
      [
        customer.phone_number, segmentId, strategy.id,
        `Promo: ${strategy.strategy_name}`, message,
        scheduledDate, strategy.delivery_channel, requiresApproval, assignedBy,
      ]
    );
    created++;
  }

  return { created, requiresApproval };
}

/**
 * Record a promo redemption and update budget.
 */
export async function recordRedemption(client, { strategyId, customerPhone, couponCode, amountRedeemed }) {
  const strategy = (await client.query('SELECT * FROM promo_strategies WHERE id = $1', [strategyId])).rows[0];
  if (!strategy) throw new Error('Strategy not found');

  // Calculate discount applied
  let discount = 0;
  if (strategy.discount_type === 'percentage') {
    discount = (amountRedeemed * parseFloat(strategy.discount_value)) / 100;
  } else {
    discount = parseFloat(strategy.discount_value);
  }

  await client.query(
    `INSERT INTO promo_redemptions (promo_strategy_id, customer_phone, coupon_code, amount_redeemed, discount_applied)
     VALUES ($1,$2,$3,$4,$5)`,
    [strategyId, customerPhone, couponCode, amountRedeemed, discount]
  );

  // Update budget used
  await client.query(
    'UPDATE promo_strategies SET budget_used = budget_used + $1 WHERE id = $2',
    [discount, strategyId]
  );

  return { discount };
}

/**
 * Calculate ROI for a promo strategy.
 */
export async function calculatePromoROI(client, strategyId) {
  const redemptions = (await client.query(
    'SELECT COUNT(*) as count, SUM(amount_redeemed) as revenue, SUM(discount_applied) as discount FROM promo_redemptions WHERE promo_strategy_id = $1',
    [strategyId]
  )).rows[0];

  const revenue = parseFloat(redemptions.revenue || 0);
  const discount = parseFloat(redemptions.discount || 0);
  const roi = discount > 0 ? (((revenue - discount) / discount) * 100).toFixed(2) : null;

  return {
    redemptionCount: parseInt(redemptions.count),
    revenue,
    discountSpent: discount,
    roi: roi ? `${roi}%` : 'N/A',
  };
}

export default { generateCoupon, generatePromoTasks, recordRedemption, calculatePromoROI };
