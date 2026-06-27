// ============================================
// RFM Scoring Service
// Scores customers on Recency, Frequency, Monetary
//
// Thresholds are configurable via env vars so they can be
// calibrated to the business (currency, purchase cycle).
// DEFAULTS BELOW ARE IN IDR (Indonesian Rupiah) for Generos.
// ============================================

// Recency thresholds in days (lower = more recent = better score)
const R_THRESHOLDS = (process.env.RFM_RECENCY_DAYS || '15,30,60,90').split(',').map(Number);
// Frequency thresholds: min purchases for each score tier
const F_THRESHOLDS = (process.env.RFM_FREQUENCY || '5,3,2,1').split(',').map(Number);
// Monetary thresholds in IDR: total spend for each score tier
const M_THRESHOLDS = (process.env.RFM_MONETARY || '2000000,1000000,500000,150000').split(',').map(Number);

function scoreRecency(days) {
  if (days <= R_THRESHOLDS[0]) return 1;
  if (days <= R_THRESHOLDS[1]) return 2;
  if (days <= R_THRESHOLDS[2]) return 3;
  if (days <= R_THRESHOLDS[3]) return 4;
  return 5;
}

function scoreFrequency(count) {
  if (count >= F_THRESHOLDS[0]) return 1;
  if (count >= F_THRESHOLDS[1]) return 2;
  if (count >= F_THRESHOLDS[2]) return 3;
  if (count >= F_THRESHOLDS[3]) return 4;
  return 5;
}

function scoreMonetary(total) {
  if (total >= M_THRESHOLDS[0]) return 1;
  if (total >= M_THRESHOLDS[1]) return 2;
  if (total >= M_THRESHOLDS[2]) return 3;
  if (total >= M_THRESHOLDS[3]) return 4;
  return 5;
}

/**
 * Calculate full RFM for a customer
 * @returns { recency, frequency, monetary, score, rScore, fScore, mScore }
 */
export function calculateRFM({ lastPurchaseDate, purchaseCount, totalSpend }) {
  const today = new Date();
  let daysSinceLastPurchase = 999;

  if (lastPurchaseDate) {
    const last = new Date(lastPurchaseDate);
    daysSinceLastPurchase = Math.floor((today - last) / (1000 * 60 * 60 * 24));
  }

  const rScore = scoreRecency(daysSinceLastPurchase);
  const fScore = scoreFrequency(purchaseCount);
  const mScore = scoreMonetary(totalSpend);

  // Combined score string e.g. "131"
  const score = `${rScore}${fScore}${mScore}`;

  return {
    recency: daysSinceLastPurchase,
    frequency: purchaseCount,
    monetary: totalSpend,
    rScore,
    fScore,
    mScore,
    score,
  };
}

/**
 * Map RFM scores to a segment tier label.
 * This is a fallback labeling — actual segment assignment
 * uses the segments table rules (see segmentService).
 */
export function getRFMTier({ rScore, fScore, mScore }) {
  // Tier A: High-Value Repeat
  if (rScore <= 2 && fScore <= 2 && mScore <= 2) return 'High-Value Repeat';
  // Tier B: Mid-Tier
  if (rScore <= 3 && fScore <= 3 && mScore <= 3) return 'Mid-Tier';
  // Tier D: Dormant — never bought or fully lapsed (check BEFORE one-time)
  if (fScore === 5) return 'Dormant';
  // Tier C: At-risk high-value churning (bought before, high spend, now lapsed)
  if (rScore >= 4 && mScore <= 2) return 'Churned High-Value';
  // Tier C: One-time buyer (bought exactly once or rarely)
  if (fScore >= 4) return 'One-Time Buyer';
  // Tier D: Dormant fallback
  if (rScore === 5) return 'Dormant';
  return 'Unclassified';
}

export default { calculateRFM, getRFMTier };
