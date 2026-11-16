import crypto from 'node:crypto';
import { handleUpdate } from '../lib/bot.js';

function verifySecret(headerVal, secretVal) {
  if (!headerVal || !secretVal) return false;
  const a = Buffer.from(String(headerVal), 'utf8');
  const b = Buffer.from(String(secretVal), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = process.env.WEBHOOK_SECRET;

  if (!verifySecret(secretHeader, expectedSecret)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (update && typeof update === 'object') {
      await handleUpdate(update);
    }
  } catch (err) {
    console.error('Webhook handling error:', err?.message || 'Unknown error');
  }

  return res.status(200).json({ ok: true });
}
