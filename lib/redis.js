import { getBotId } from './telegram.js';

function getRedisCredentials() {
  const url = (
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    ''
  ).replace(/\/+$/, '');

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    '';

  if (!url || !token) {
    throw new Error('Missing Upstash Redis REST configuration');
  }
  return { url, token };
}

export function k(suffix) {
  const botId = getBotId();
  return `b:${botId}:${suffix}`;
}

export async function redisCmd(commandArray) {
  const { url, token } = getRedisCredentials();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commandArray),
    signal: AbortSignal.timeout(8000)
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Redis Error: ${data.error}`);
  }
  return data.result;
}

export async function redisPipeline(commandsArray) {
  const { url, token } = getRedisCredentials();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commandsArray),
    signal: AbortSignal.timeout(8000)
  });

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('Invalid Redis pipeline response');
  }
  return data.map((item) => {
    if (item && item.error) {
      console.error('Redis pipeline item error:', item.error);
      return null;
    }
    return item ? item.result : null;
  });
}

export function parseHash(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out = {};
    for (let i = 0; i < raw.length; i += 2) {
      const key = raw[i];
      const val = raw[i + 1];
      if (key !== undefined && val !== undefined) {
        out[String(key)] = String(val);
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val !== undefined && val !== null) {
        out[String(key)] = String(val);
      }
    }
    return out;
  }
  return {};
}
