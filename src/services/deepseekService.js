// ============================================
// Deepseek AI Service
// Handles chat queries, strategy recommendations, pattern analysis
// ============================================

const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const SYSTEM_PROMPT = `You are a CRM assistant for Generos (a kids product brand: milk, snacks, apparel).

DATA ACCESS: You can see all customer and cohort data for internal analysis.

YOUR ROLE:
1. Analyze cohort/segment performance using provided metrics
2. Suggest promo strategies based on customer behavior
3. Answer factual questions about CRM data
4. Identify patterns and anomalies

CONSTRAINTS:
- Use actual numbers from the provided data, never estimate
- Preface recommendations with a confidence level (0-100%)
- Never recommend a strategy without an ROI estimate
- Flag uncertainty: say "Data insufficient" if a segment has under 100 customers
- Keep language actionable, not just descriptive
- All claims must be backed by specific metrics
- Cannot suggest discount greater than ${process.env.MAX_DISCOUNT_PCT || 50}%
- If a recommendation is strategic, note that it requires approval

Respond concisely. Cite the data source (cohort name, exact metrics) in your answer.`;

/**
 * Build context object injected into each request
 */
function buildContext({ cohorts, segments, businessConstraints }) {
  return JSON.stringify({
    available_cohorts: cohorts,
    available_segments: segments,
    business_constraints: businessConstraints,
  }, null, 2);
}

/**
 * Send a chat message to Deepseek with CRM context
 */
export async function chatWithAI({ userMessage, context, conversationHistory = [] }) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Current CRM data context:\n${buildContext(context)}` },
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.3, // Lower = more deterministic for analysis
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Deepseek API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return {
    reply: data.choices[0]?.message?.content || '',
    usage: data.usage,
  };
}

export default { chatWithAI };
