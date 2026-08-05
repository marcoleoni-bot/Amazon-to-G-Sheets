import { log } from './log.js';

/**
 * Optional webhook. A run that fails at 05:30 and only says so in run.log has
 * not really told anyone.
 */
export async function alert(subject, detail) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'amazon-report-bot',
        at: new Date().toISOString(),
        subject,
        detail: String(detail).slice(0, 4000),
      }),
    });
    if (!res.ok) log.warn(`alert webhook returned ${res.status}`);
  } catch (err) {
    log.warn(`alert webhook failed: ${err.message}`);
  }
}
