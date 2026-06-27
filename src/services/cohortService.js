// ============================================
// Cohort Service
// Auto-generates monthly cohorts and calculates retention metrics
// ============================================

/**
 * Get cohort name from a date (e.g. "2024-01" -> "Jan 2024")
 */
function cohortNameFromDate(date) {
  const d = new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Get first & last day of the month for a given date
 */
function monthBounds(date) {
  const d = new Date(date);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

/**
 * Ensure a cohort row exists for the given date_added.
 * Returns the cohort id.
 */
export async function ensureCohort(client, dateAdded) {
  const name = cohortNameFromDate(dateAdded);
  const existing = await client.query('SELECT id FROM cohorts WHERE cohort_name = $1', [name]);
  if (existing.rows[0]) return existing.rows[0].id;

  const { start, end } = monthBounds(dateAdded);
  const inserted = await client.query(
    'INSERT INTO cohorts (cohort_name, cohort_type, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, 'monthly', start, end]
  );
  return inserted.rows[0].id;
}

/**
 * Assign all customers to their cohort based on date_added.
 */
export async function assignCohorts(client) {
  const customers = await client.query('SELECT phone_number, date_added FROM customers WHERE cohort_id IS NULL');
  let assigned = 0;
  for (const c of customers.rows) {
    const cohortId = await ensureCohort(client, c.date_added);
    await client.query('UPDATE customers SET cohort_id = $1 WHERE phone_number = $2', [cohortId, c.phone_number]);
    assigned++;
  }
  return assigned;
}

/**
 * Recalculate metrics for all cohorts:
 * repeat rate, avg LTV, churn rate, 30/60/90 day retention.
 */
export async function recalculateCohortMetrics(client, churnThresholdDays = 90) {
  const cohorts = await client.query('SELECT id FROM cohorts');
  let updated = 0;

  for (const cohort of cohorts.rows) {
    const cid = cohort.id;

    // Total customers in cohort
    const totalRes = await client.query(
      'SELECT COUNT(*) as total FROM customers WHERE cohort_id = $1 AND status != $2',
      [cid, 'deleted']
    );
    const total = parseInt(totalRes.rows[0].total);
    if (total === 0) continue;

    // Customers with 2+ purchases (repeat)
    const repeatRes = await client.query(
      'SELECT COUNT(*) as cnt FROM customers WHERE cohort_id = $1 AND rfm_frequency >= 2',
      [cid]
    );
    const repeatCount = parseInt(repeatRes.rows[0].cnt);
    const repeatRate = ((repeatCount / total) * 100).toFixed(2);

    // Average LTV (total monetary)
    const ltvRes = await client.query(
      'SELECT AVG(rfm_monetary) as avg_ltv FROM customers WHERE cohort_id = $1',
      [cid]
    );
    const avgLtv = parseFloat(ltvRes.rows[0].avg_ltv || 0).toFixed(2);

    // Churn: customers with no purchase in churnThresholdDays
    const churnRes = await client.query(
      `SELECT COUNT(*) as cnt FROM customers
       WHERE cohort_id = $1 AND (last_interaction_date IS NULL OR last_interaction_date < CURRENT_DATE - $2::int)`,
      [cid, churnThresholdDays]
    );
    const churnCount = parseInt(churnRes.rows[0].cnt);
    const churnRate = ((churnCount / total) * 100).toFixed(2);

    // Retention: % who made a 2nd purchase within N days of first
    const retention = {};
    for (const days of [30, 60, 90]) {
      const retRes = await client.query(
        `SELECT COUNT(DISTINCT p1.customer_phone) as cnt
         FROM purchases p1
         JOIN customers c ON c.phone_number = p1.customer_phone
         WHERE c.cohort_id = $1
         AND EXISTS (
           SELECT 1 FROM purchases p2
           WHERE p2.customer_phone = p1.customer_phone
           AND p2.purchase_date > p1.purchase_date
           AND p2.purchase_date <= p1.purchase_date + $2::int
         )`,
        [cid, days]
      );
      retention[days] = ((parseInt(retRes.rows[0].cnt) / total) * 100).toFixed(2);
    }

    // Avg days from first to second purchase
    const daysRes = await client.query(
      `SELECT AVG(diff) as avg_days FROM (
         SELECT MIN(p2.purchase_date - p1.purchase_date) as diff
         FROM purchases p1
         JOIN purchases p2 ON p2.customer_phone = p1.customer_phone AND p2.purchase_date > p1.purchase_date
         JOIN customers c ON c.phone_number = p1.customer_phone
         WHERE c.cohort_id = $1
         GROUP BY p1.customer_phone
       ) sub`,
      [cid]
    );
    const avgFirstToRepeat = Math.round(parseFloat(daysRes.rows[0].avg_days || 0));

    await client.query(
      `UPDATE cohorts SET
        total_customers = $1, customers_with_repeat = $2, repeat_purchase_rate = $3,
        avg_ltv = $4, churn_rate = $5, days_30_retention = $6, days_60_retention = $7,
        days_90_retention = $8, avg_first_to_repeat_days = $9, updated_at = NOW()
       WHERE id = $10`,
      [total, repeatCount, repeatRate, avgLtv, churnRate, retention[30], retention[60], retention[90], avgFirstToRepeat, cid]
    );
    updated++;
  }
  return updated;
}

export default { ensureCohort, assignCohorts, recalculateCohortMetrics };
