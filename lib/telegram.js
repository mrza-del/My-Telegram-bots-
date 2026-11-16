const TOPIC_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];

function getBotToken() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('Missing BOT_TOKEN environment variable');
  return token;
}

export function getBotId() {
  const token = process.env.BOT_TOKEN || '';
  const idPart = token.split(':')[0];
  const parsed = Number(idPart);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function pickTopicColor(userId) {
  const idx = Math.abs(Number(userId) || 0) % TOPIC_COLORS.length;
  return TOPIC_COLORS[idx];
}

async function callTelegram(method, payload = {}) {
  const token = getBotToken();
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const cleanPayload = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined && v !== null) {
      cleanPayload[k] = v;
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanPayload),
      signal: AbortSignal.timeout(8000)
    });

    const data = await res.json();
    return data;
  } catch (err) {
    return {
      ok: false,
      error_code: 500,
      description: err?.message || 'Network or timeout error'
    };
  }
}

export function sendMessage({
  chat_id,
  text,
  parse_mode = 'HTML',
  message_thread_id,
  reply_markup,
  reply_parameters,
  link_preview_options
}) {
  return callTelegram('sendMessage', {
    chat_id,
    text,
    parse_mode,
    message_thread_id,
    reply_markup,
    reply_parameters,
    link_preview_options
  });
}

export function copyMessage({
  chat_id,
  from_chat_id,
  message_id,
  message_thread_id,
  reply_parameters
}) {
  return callTelegram('copyMessage', {
    chat_id,
    from_chat_id,
    message_id,
    message_thread_id,
    reply_parameters
  });
}

export function forwardMessage({
  chat_id,
  from_chat_id,
  message_id,
  message_thread_id
}) {
  return callTelegram('forwardMessage', {
    chat_id,
    from_chat_id,
    message_id,
    message_thread_id
  });
}

export function createForumTopic({ chat_id, name, icon_color }) {
  return callTelegram('createForumTopic', {
    chat_id,
    name,
    icon_color
  });
}

export function closeForumTopic({ chat_id, message_thread_id }) {
  return callTelegram('closeForumTopic', {
    chat_id,
    message_thread_id
  });
}

export function reopenForumTopic({ chat_id, message_thread_id }) {
  return callTelegram('reopenForumTopic', {
    chat_id,
    message_thread_id
  });
}

export function pinChatMessage({ chat_id, message_id, disable_notification = true }) {
  return callTelegram('pinChatMessage', {
    chat_id,
    message_id,
    disable_notification
  });
}

export function editMessageText({
  chat_id,
  message_id,
  text,
  parse_mode = 'HTML',
  reply_markup,
  entities,
  link_preview_options
}) {
  const payload = {
    chat_id,
    message_id,
    text,
    reply_markup,
    link_preview_options
  };
  if (entities && Array.isArray(entities) && entities.length > 0) {
    payload.entities = entities;
  } else if (parse_mode) {
    payload.parse_mode = parse_mode;
  }
  return callTelegram('editMessageText', payload);
}

export function editMessageCaption({
  chat_id,
  message_id,
  caption,
  parse_mode = 'HTML',
  reply_markup,
  caption_entities
}) {
  const payload = {
    chat_id,
    message_id,
    caption,
    reply_markup
  };
  if (caption_entities && Array.isArray(caption_entities) && caption_entities.length > 0) {
    payload.caption_entities = caption_entities;
  } else if (parse_mode) {
    payload.parse_mode = parse_mode;
  }
  return callTelegram('editMessageCaption', payload);
}

export function editMessageReplyMarkup({ chat_id, message_id, reply_markup }) {
  return callTelegram('editMessageReplyMarkup', {
    chat_id,
    message_id,
    reply_markup
  });
}

export function deleteMessage({ chat_id, message_id }) {
  return callTelegram('deleteMessage', {
    chat_id,
    message_id
  });
}

export function setMessageReaction({ chat_id, message_id, reaction, is_big = false }) {
  return callTelegram('setMessageReaction', {
    chat_id,
    message_id,
    reaction,
    is_big
  });
}

export function answerCallbackQuery({ callback_query_id, text, show_alert = false }) {
  return callTelegram('answerCallbackQuery', {
    callback_query_id,
    text,
    show_alert
  });
}

export function getChat({ chat_id }) {
  return callTelegram('getChat', { chat_id });
}

export function getChatMember({ chat_id, user_id }) {
  return callTelegram('getChatMember', { chat_id, user_id });
}
