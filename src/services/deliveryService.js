// ============================================
// Delivery Service
// Pluggable adapter for sending messages.
//
// ⚠️ IMPORTANT: This ships with a CONSOLE adapter only (logs instead of sends).
// To actually deliver messages you must plug in a real provider:
//   - Email: SendGrid, Resend, AWS SES
//   - SMS/WhatsApp: Twilio, Vonage, or a local Indonesian gateway (Qontak, Wablas)
// Replace the adapter functions below with real API calls + add provider keys to .env
// ============================================

const ADAPTER = process.env.DELIVERY_ADAPTER || 'console';

async function consoleAdapter(channel, to, message) {
  console.log(`[DELIVERY:${channel}] → ${to}: ${message}`);
  return { success: true, adapter: 'console', delivered: false, note: 'Logged only — no real provider configured' };
}

// --- Placeholder for real adapters ---
// async function sendgridEmail(to, subject, body) { ... }
// async function twilioSMS(to, body) { ... }
// async function whatsappGateway(to, body) { ... }

/**
 * Send a message via the configured channel.
 * Currently routes everything to console adapter.
 */
export async function deliver({ channel, to, message }) {
  switch (ADAPTER) {
    case 'console':
    default:
      return consoleAdapter(channel, to, message);
    // case 'production':
    //   if (channel === 'email') return sendgridEmail(to, 'Generos', message);
    //   if (channel === 'sms') return twilioSMS(to, message);
    //   if (channel === 'whatsapp') return whatsappGateway(to, message);
  }
}

/**
 * Execute a follow-up task: deliver its message and update status.
 */
export async function executeTask(client, taskId) {
  const task = (await client.query('SELECT * FROM follow_up_tasks WHERE id = $1', [taskId])).rows[0];
  if (!task) throw new Error('Task not found');

  // Manual call tasks aren't auto-delivered — they stay for a human
  if (task.channel === 'manual_call') {
    return { skipped: true, note: 'Manual call — requires human action' };
  }

  // Approval gate
  if (task.requires_approval && !task.approved_at) {
    return { skipped: true, note: 'Awaiting approval' };
  }

  try {
    const result = await deliver({
      channel: task.channel,
      to: task.customer_phone,
      message: task.personalized_message || task.description,
    });

    await client.query(
      "UPDATE follow_up_tasks SET status = 'sent', status_updated_at = NOW() WHERE id = $1",
      [taskId]
    );
    return { success: true, result };
  } catch (err) {
    const retries = task.retry_count + 1;
    const newStatus = retries >= 3 ? 'failed' : 'pending';
    await client.query(
      'UPDATE follow_up_tasks SET status = $1, retry_count = $2, status_updated_at = NOW() WHERE id = $3',
      [newStatus, retries, taskId]
    );
    return { success: false, error: err.message, retries };
  }
}

export default { deliver, executeTask };
