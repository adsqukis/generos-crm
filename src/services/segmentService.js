// ============================================
// Segment Service
// Assigns customers to segments based on RFM rules.
// Conflict resolution: highest priority (lowest number) wins.
// ============================================

/**
 * Check if a customer matches a segment's rules.
 * Note: RFM score components — lower is better (1=best).
 * A segment defines MINIMUM acceptable scores, meaning the
 * customer's score number must be <= the threshold to qualify.
 *
 * Example: rfm_recency_min = 2 means "recency score 1 or 2 qualifies".
 */
function matchesSegment(customer, segment) {
  // recency: customer.rfm score digit 1
  const rScore = parseInt(customer.rfm_score?.[0] || 5);
  const fScore = parseInt(customer.rfm_score?.[1] || 5);
  const mScore = parseInt(customer.rfm_score?.[2] || 5);

  if (segment.rfm_recency_min != null && rScore > segment.rfm_recency_min) return false;
  if (segment.rfm_frequency_min != null && fScore > segment.rfm_frequency_min) return false;
  if (segment.rfm_monetary_min != null && mScore > segment.rfm_monetary_min) return false;

  // Cohort age check (optional)
  if (segment.cohort_min_age_days != null && customer.date_added) {
    const ageDays = Math.floor((Date.now() - new Date(customer.date_added)) / 86400000);
    if (ageDays < segment.cohort_min_age_days) return false;
  }

  return true;
}

/**
 * Assign all customers to their best-matching segment.
 * Records segment changes in audit log.
 * Returns { assigned, changed, unassigned }.
 */
export async function assignSegments(client, options = {}) {
  const systemUserId = options.systemUserId || null;

  // Get all active segments ordered by priority (lowest number = highest priority)
  const segmentsRes = await client.query('SELECT * FROM segments ORDER BY priority ASC');
  const segments = segmentsRes.rows;

  if (segments.length === 0) {
    return { assigned: 0, changed: 0, unassigned: 0, note: 'No segments defined' };
  }

  const customersRes = await client.query(
    "SELECT phone_number, rfm_score, date_added, current_segment_id FROM customers WHERE status != 'deleted'"
  );

  let assigned = 0, changed = 0, unassigned = 0;

  for (const customer of customersRes.rows) {
    // Find first matching segment (already sorted by priority)
    const match = segments.find((seg) => matchesSegment(customer, seg));
    const newSegmentId = match ? match.id : null;

    if (newSegmentId === null) {
      unassigned++;
      // If previously had a segment, clear it
      if (customer.current_segment_id) {
        await client.query(
          'UPDATE customers SET previous_segment_id = current_segment_id, current_segment_id = NULL, segment_change_date = CURRENT_DATE WHERE phone_number = $1',
          [customer.phone_number]
        );
      }
      continue;
    }

    if (customer.current_segment_id === newSegmentId) {
      assigned++;
      continue; // no change
    }

    // Segment changed
    await client.query(
      `UPDATE customers SET previous_segment_id = current_segment_id, current_segment_id = $1, segment_change_date = CURRENT_DATE, updated_at = NOW()
       WHERE phone_number = $2`,
      [newSegmentId, customer.phone_number]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, reason)
       VALUES ($1, 'update', 'customer_segment', $2, $3, $4, $5)`,
      [
        systemUserId,
        customer.phone_number,
        JSON.stringify({ segment_id: customer.current_segment_id }),
        JSON.stringify({ segment_id: newSegmentId }),
        'Auto-reassignment via RFM rules',
      ]
    );
    changed++;
    assigned++;
  }

  // Update segment customer counts
  for (const seg of segments) {
    const cnt = await client.query('SELECT COUNT(*) as c FROM customers WHERE current_segment_id = $1', [seg.id]);
    await client.query('UPDATE segments SET customer_count = $1, last_recalculated = NOW() WHERE id = $2', [
      parseInt(cnt.rows[0].c),
      seg.id,
    ]);
  }

  return { assigned, changed, unassigned };
}

export default { assignSegments };
