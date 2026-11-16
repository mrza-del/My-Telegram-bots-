import {
  getBotId,
  pickTopicColor,
  sendMessage,
  copyMessage,
  forwardMessage,
  createForumTopic,
  closeForumTopic,
  reopenForumTopic,
  pinChatMessage,
  editMessageText,
  editMessageCaption,
  editMessageReplyMarkup,
  deleteMessage,
  setMessageReaction,
  answerCallbackQuery,
  getChat,
  getChatMember
} from './telegram.js';
import { k, redisCmd, redisPipeline, parseHash } from './redis.js';

const DEFAULT_WELCOME = 'أهلاً بك {name} 👋\nاكتب رسالتك هنا وسأرد عليك في أقرب وقت ممكن.';
const MAP_TTL = 2592000; // 30 days

function getOwnerId() {
  const n = Number(process.env.OWNER_ID || 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function isSafeId(val) {
  const n = Number(val);
  return Number.isSafeInteger(n) && n !== 0;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseT2U(val) {
  if (!val) return { userId: 0, userMsgId: 0 };
  const str = String(val);
  if (str.includes(':')) {
    const [u, m] = str.split(':');
    return { userId: Number(u), userMsgId: Number(m) };
  }
  return { userId: 0, userMsgId: Number(str) };
}

function sanitizeTopicName(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const raw = fullName || (user.username ? `@${user.username}` : `User ${user.id}`);
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return (cleaned || `User ${user.id}`).slice(0, 128);
}

function formatWelcome(template, user) {
  const base = template && template.trim() ? template : DEFAULT_WELCOME;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'صديقي';
  const safeName = escapeHtml(fullName);
  return base.split('{name}').join(safeName);
}

function buildUserCardMarkup(userId, isBanned, isClosed) {
  const banBtn = isBanned
    ? { text: '✅ فك الحظر', callback_data: `unban:${userId}` }
    : { text: '🚫 حظر المستخدم', callback_data: `ban:${userId}` };

  const closeBtn = isClosed
    ? { text: '🔓 فتح الموضوع', callback_data: `open:${userId}` }
    : { text: '🔒 إغلاق الموضوع', callback_data: `close:${userId}` };

  return {
    inline_keyboard: [[banBtn, closeBtn]]
  };
}

function buildUserCardHtml(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'بدون اسم';
  const safeName = escapeHtml(fullName);
  const usernameText = user.username ? `@${escapeHtml(user.username)}` : 'لا يوجد';
  const langText = user.language_code ? escapeHtml(user.language_code) : '-';

  return [
    '👤 <b>بطاقة المستخدم</b>',
    `• المعرّف: <code>${user.id}</code>`,
    `• الاسم: <a href="tg://user?id=${user.id}">${safeName}</a>`,
    `• المعرّف النصي: ${usernameText}`,
    `• اللغة: ${langText}`,
    `#id${user.id}`
  ].join('\n');
}

function buildOwnerDashboard(cfg) {
  const isForward = cfg.forward_mode === '1';
  const modeLabel = isForward
    ? 'إظهار اسم الحساب (Forward)'
    : 'إخفاء الاسم (Copy)';
  const groupStatus = cfg.group
    ? `<code>${escapeHtml(cfg.group)}</code>`
    : 'غير مربوطة (أرسل /setgroup داخل مجموعة المواضيع)';
  const welcomePreview = cfg.welcome && cfg.welcome.trim() ? cfg.welcome : DEFAULT_WELCOME;

  const text = [
    '⚙️ <b>لوحة تحكم المالك</b>',
    '',
    `• <b>المجموعة المربوطة:</b> ${groupStatus}`,
    `• <b>وضع نقل الرسائل:</b> ${modeLabel}`,
    '',
    '• <b>رسالة الترحيب الحالية:</b>',
    welcomePreview
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: isForward
            ? '🔄 وضع النقل: إظهار الاسم (Forward)'
            : '🔄 وضع النقل: إخفاء الاسم (Copy)',
          callback_data: 'toggle_mode'
        }
      ],
      [
        { text: '✏️ تعديل رسالة الترحيب', callback_data: 'edit_welcome' },
        { text: '📊 الإحصائيات', callback_data: 'show_stats' }
      ]
    ]
  };

  return { text, reply_markup };
}

function isSupportedMessage(msg) {
  return Boolean(
    msg.text ||
    msg.photo ||
    msg.video ||
    msg.animation ||
    msg.voice ||
    msg.audio ||
    msg.video_note ||
    msg.sticker ||
    msg.document ||
    msg.contact ||
    msg.location ||
    msg.venue ||
    msg.poll ||
    msg.dice
  );
}

function isTopicMissingError(description = '') {
  const d = String(description).toLowerCase();
  return (
    d.includes('thread not found') ||
    d.includes('topic_deleted') ||
    d.includes('topic_id_invalid') ||
    d.includes('message thread not found')
  );
}

async function notifyOwnerOnce(errorDescription) {
  const ownerId = getOwnerId();
  if (!ownerId) return;
  try {
    const setRes = await redisCmd(['SET', k('alert'), '1', 'NX', 'EX', '600']);
    if (setRes === 'OK') {
      await sendMessage({
        chat_id: ownerId,
        text: `⚠️ <b>تنبيه خطأ في البوت:</b>\n<code>${escapeHtml(errorDescription)}</code>`
      });
    }
  } catch (e) {
    console.error('Failed to send alert:', e?.message);
  }
}

async function ensureTopic(user, userHash, cfg, forceRecreate = false) {
  const groupId = Number(cfg.group);
  const existingTopic = Number(userHash.topic || 0);
  const existingGrp = Number(userHash.grp || 0);

  if (!forceRecreate && existingTopic > 0 && existingGrp === groupId) {
    if (userHash.closed === '1') {
      await reopenForumTopic({ chat_id: groupId, message_thread_id: existingTopic });
      await redisCmd(['HSET', k(`u:${user.id}`), 'closed', '0']);
      if (userHash.card) {
        await editMessageReplyMarkup({
          chat_id: groupId,
          message_id: Number(userHash.card),
          reply_markup: buildUserCardMarkup(user.id, userHash.banned === '1', false)
        });
      }
    }
    return existingTopic;
  }

  const topicName = sanitizeTopicName(user);
  const color = pickTopicColor(user.id);

  const created = await createForumTopic({
    chat_id: groupId,
    name: topicName,
    icon_color: color
  });

  if (!created.ok || !created.result?.message_thread_id) {
    throw new Error(created.description || 'Failed to create forum topic');
  }

  const newTopicId = created.result.message_thread_id;
  const isBanned = userHash.banned === '1';

  const cardMsg = await sendMessage({
    chat_id: groupId,
    message_thread_id: newTopicId,
    text: buildUserCardHtml(user),
    reply_markup: buildUserCardMarkup(user.id, isBanned, false),
    link_preview_options: { is_disabled: true }
  });

  const cardId = cardMsg.ok && cardMsg.result?.message_id ? cardMsg.result.message_id : 0;

  if (cardId) {
    await pinChatMessage({
      chat_id: groupId,
      message_id: cardId,
      disable_notification: true
    });
  }

  await redisPipeline([
    [
      'HSET',
      k(`u:${user.id}`),
      'topic',
      String(newTopicId),
      'grp',
      String(groupId),
      'name',
      topicName,
      'card',
      String(cardId),
      'banned',
      isBanned ? '1' : '0',
      'closed',
      '0'
    ],
    ['SET', k(`t:${groupId}:${newTopicId}`), String(user.id)]
  ]);

  userHash.topic = String(newTopicId);
  userHash.grp = String(groupId);
  userHash.card = String(cardId);
  userHash.closed = '0';

  return newTopicId;
}

async function buildReplyParametersForTopic(userId, msg) {
  if (!msg.reply_to_message?.message_id) return undefined;
  const replyOrigId = msg.reply_to_message.message_id;
  if (!isSafeId(replyOrigId)) return undefined;

  const targetTopicMsgId = await redisCmd(['GET', k(`u2t:${userId}:${replyOrigId}`)]);
  if (!targetTopicMsgId) return undefined;

  const params = {
    message_id: Number(targetTopicMsgId),
    allow_sending_without_reply: true
  };

  if (msg.quote && typeof msg.quote.text === 'string') {
    params.quote = msg.quote.text;
    if (Array.isArray(msg.quote.entities)) {
      params.quote_entities = msg.quote.entities;
    }
    if (typeof msg.quote.position === 'number') {
      params.quote_position = msg.quote.position;
    }
  }

  return params;
}

async function buildReplyParametersForUser(groupId, msg) {
  if (!msg.reply_to_message?.message_id) return undefined;
  const replyTopicMsgId = msg.reply_to_message.message_id;

  if (msg.message_thread_id && replyTopicMsgId === msg.message_thread_id) {
    return undefined;
  }

  if (!isSafeId(replyTopicMsgId)) return undefined;

  const rawMap = await redisCmd(['GET', k(`t2u:${groupId}:${replyTopicMsgId}`)]);
  const { userMsgId } = parseT2U(rawMap);
  if (!userMsgId) return undefined;

  const params = {
    message_id: userMsgId,
    allow_sending_without_reply: true
  };

  if (msg.quote && typeof msg.quote.text === 'string') {
    params.quote = msg.quote.text;
    if (Array.isArray(msg.quote.entities)) {
      params.quote_entities = msg.quote.entities;
    }
    if (typeof msg.quote.position === 'number') {
      params.quote_position = msg.quote.position;
    }
  }

  return params;
}

async function sendToTopicOnce(msg, groupId, topicId, isForwardMode, replyParams) {
  if (!isForwardMode) {
    return copyMessage({
      chat_id: groupId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
      message_thread_id: topicId,
      reply_parameters: replyParams
    });
  }

  const fwdRes = await forwardMessage({
    chat_id: groupId,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    message_thread_id: topicId
  });

  if (fwdRes.ok && replyParams) {
    await sendMessage({
      chat_id: groupId,
      message_thread_id: topicId,
      text: '↩️ <i>الرسالة المحوّلة أعلاه هي رد على هذه الرسالة</i>',
      reply_parameters: replyParams
    });
  }

  return fwdRes;
}

async function relayUserToTopic(msg, userHash, cfg) {
  const user = msg.from;
  const groupId = Number(cfg.group);
  const isForwardMode = cfg.forward_mode === '1';

  let topicId = await ensureTopic(user, userHash, cfg, false);
  const replyParams = await buildReplyParametersForTopic(user.id, msg);

  let res = await sendToTopicOnce(msg, groupId, topicId, isForwardMode, replyParams);

  if (!res.ok && isTopicMissingError(res.description)) {
    topicId = await ensureTopic(user, userHash, cfg, true);
    res = await sendToTopicOnce(msg, groupId, topicId, isForwardMode, undefined);
  } else if (!res.ok && res.error_code === 429 && (res.parameters?.retry_after || 99) <= 3) {
    const waitMs = (res.parameters.retry_after || 1) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await sendToTopicOnce(msg, groupId, topicId, isForwardMode, replyParams);
  }

  if (!res.ok) {
    console.error('Failed to relay message to topic:', res.description);
    await sendMessage({
      chat_id: user.id,
      text: 'تعذر إيصال رسالتك الآن، حاول لاحقاً.'
    });
    await notifyOwnerOnce(res.description || 'Unknown relay error');
    return;
  }

  const sentTopicMsgId = res.result?.message_id;
  if (sentTopicMsgId) {
    await redisPipeline([
      ['SET', k(`u2t:${user.id}:${msg.message_id}`), String(sentTopicMsgId), 'EX', String(MAP_TTL)],
      ['SET', k(`t2u:${groupId}:${sentTopicMsgId}`), `${user.id}:${msg.message_id}`, 'EX', String(MAP_TTL)]
    ]);
  }
}

async function handlePrivateMessage(msg) {
  const user = msg.from;
  if (!user || !isSafeId(user.id)) return;

  const text = (msg.text || '').trim();

  if (text === '/id' || text.startsWith('/id@')) {
    await sendMessage({
      chat_id: msg.chat.id,
      text: `معرّفك: <code>${user.id}</code>`
    });
    return;
  }

  const ownerId = getOwnerId();
  if (ownerId === 0) return;

  if (user.id === ownerId) {
    const rawCfg = await redisCmd(['HGETALL', k('cfg')]);
    const cfg = parseHash(rawCfg);

    if (text === '/start') {
      if (cfg.state) {
        await redisCmd(['HDEL', k('cfg'), 'state']);
        cfg.state = '';
      }
      const dash = buildOwnerDashboard(cfg);
      await sendMessage({
        chat_id: ownerId,
        text: dash.text,
        reply_markup: dash.reply_markup,
        link_preview_options: { is_disabled: true }
      });
      return;
    }

    if (cfg.state === 'await_welcome' && text && !text.startsWith('/')) {
      const previewRes = await sendMessage({
        chat_id: ownerId,
        text: `✅ <b>تم حفظ رسالة الترحيب الجديدة بنجاح. معاينة:</b>\n\n${msg.text}`
      });

      if (!previewRes.ok && previewRes.error_code === 400) {
        await sendMessage({
          chat_id: ownerId,
          text: '❌ النص يحتوي على وسوم HTML غير صالحة. أرسل نصاً صحيحاً أو أرسل /start للإلغاء.'
        });
        return;
      }

      await redisPipeline([
        ['HSET', k('cfg'), 'welcome', msg.text],
        ['HDEL', k('cfg'), 'state']
      ]);
      return;
    }

    await sendMessage({
      chat_id: ownerId,
      text: 'أنت المالك. أرسل /start لفتح لوحة التحكم، أو راسل البوت من حساب آخر لتجربته كمستخدم.'
    });
    return;
  }

  const [rawUser, rawCfg] = await redisPipeline([
    ['HGETALL', k(`u:${user.id}`)],
    ['HGETALL', k('cfg')]
  ]);

  const userHash = parseHash(rawUser);
  const cfg = parseHash(rawCfg);

  if (userHash.banned === '1') {
    return;
  }

  if (!cfg.group || !isSafeId(cfg.group)) {
    await sendMessage({
      chat_id: user.id,
      text: 'البوت قيد الإعداد حالياً، يرجى المحاولة لاحقاً.'
    });
    return;
  }

  await redisCmd(['SADD', k('users'), String(user.id)]);

  if (text === '/start' || text.startsWith('/start ')) {
    try {
      const topicId = await ensureTopic(user, userHash, cfg, false);
      const welcomeText = formatWelcome(cfg.welcome, user);
      await sendMessage({
        chat_id: user.id,
        text: welcomeText
      });
      await sendMessage({
        chat_id: Number(cfg.group),
        message_thread_id: topicId,
        text: '▶️ <i>بدأ المستخدم المحادثة (/start)</i>'
      });
    } catch (err) {
      console.error('Error in user /start:', err?.message);
      await notifyOwnerOnce(err?.message || 'Error in /start');
    }
    return;
  }

  if (!isSupportedMessage(msg)) return;

  try {
    await relayUserToTopic(msg, userHash, cfg);
  } catch (err) {
    console.error('Relay error:', err?.message);
    await sendMessage({
      chat_id: user.id,
      text: 'تعذر إيصال رسالتك الآن، حاول لاحقاً.'
    });
    await notifyOwnerOnce(err?.message || 'Unexpected relay failure');
  }
}

async function handleGroupMessage(msg) {
  if (!msg.from || msg.from.is_bot) return;

  const ownerId = getOwnerId();
  if (ownerId === 0 || msg.from.id !== ownerId) return;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const cmdToken = text.split(/\s+/)[0].split('@')[0];

  if (cmdToken === '/setgroup') {
    const chatInfo = await getChat({ chat_id: chatId });
    if (!chatInfo.ok || !chatInfo.result?.is_forum) {
      await sendMessage({
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: '⚠️ يرجى تفعيل خيار <b>المواضيع (Topics)</b> من إعدادات المجموعة أولاً ثم إعادة المحاولة.'
      });
      return;
    }

    const botId = getBotId();
    const memberInfo = await getChatMember({ chat_id: chatId, user_id: botId });
    const isAdmin = memberInfo.ok && memberInfo.result?.status === 'administrator';
    const canManageTopics = Boolean(memberInfo.result?.can_manage_topics);

    if (!isAdmin || !canManageTopics) {
      await sendMessage({
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: '⚠️ يرجى رفع البوت مشرفاً في المجموعة مع تفعيل صلاحية <b>إدارة المواضيع (Manage Topics)</b>.'
      });
      return;
    }

    await redisCmd(['HSET', k('cfg'), 'group', String(chatId)]);
    await sendMessage({
      chat_id: chatId,
      message_thread_id: msg.message_thread_id,
      text: '✅ تم ربط مجموعة المواضيع بنجاح.'
    });
    return;
  }

  const rawCfg = await redisCmd(['HGETALL', k('cfg')]);
  const cfg = parseHash(rawCfg);
  if (!cfg.group || Number(cfg.group) !== chatId) return;

  const topicId = msg.message_thread_id;
  if (!topicId) return;

  const targetUserIdStr = await redisCmd(['GET', k(`t:${chatId}:${topicId}`)]);
  if (!targetUserIdStr || !isSafeId(targetUserIdStr)) {
    if (!text.startsWith('/')) {
      await sendMessage({
        chat_id: chatId,
        message_thread_id: topicId,
        text: '⚠️ هذا الموضوع غير مرتبط بأي مستخدم.'
      });
    }
    return;
  }

  const targetUserId = Number(targetUserIdStr);

  if (cmdToken === '/del') {
    const replyMsgId = msg.reply_to_message?.message_id;
    if (replyMsgId && replyMsgId !== topicId) {
      const rawMap = await redisCmd(['GET', k(`t2u:${chatId}:${replyMsgId}`)]);
      const { userMsgId } = parseT2U(rawMap);
      if (userMsgId) {
        await deleteMessage({ chat_id: targetUserId, message_id: userMsgId });
      }
      await deleteMessage({ chat_id: chatId, message_id: replyMsgId });
    }
    await deleteMessage({ chat_id: chatId, message_id: msg.message_id });
    return;
  }

  if (cmdToken === '/ban' || cmdToken === '/unban') {
    const banning = cmdToken === '/ban';
    const rawU = await redisCmd(['HGETALL', k(`u:${targetUserId}`)]);
    const uHash = parseHash(rawU);

    await redisPipeline([
      ['HSET', k(`u:${targetUserId}`), 'banned', banning ? '1' : '0'],
      [banning ? 'SADD' : 'SREM', k('banned_set'), String(targetUserId)]
    ]);

    if (uHash.card) {
      await editMessageReplyMarkup({
        chat_id: chatId,
        message_id: Number(uHash.card),
        reply_markup: buildUserCardMarkup(targetUserId, banning, uHash.closed === '1')
      });
    }

    await sendMessage({
      chat_id: chatId,
      message_thread_id: topicId,
      text: banning ? '🚫 تم حظر المستخدم.' : '✅ تم فك الحظر عن المستخدم.'
    });
    return;
  }

  if (!isSupportedMessage(msg)) return;

  const replyParams = await buildReplyParametersForUser(chatId, msg);

  const copyRes = await copyMessage({
    chat_id: targetUserId,
    from_chat_id: chatId,
    message_id: msg.message_id,
    reply_parameters: replyParams
  });

  if (!copyRes.ok) {
    if (copyRes.error_code === 403) {
      await sendMessage({
        chat_id: chatId,
        message_thread_id: topicId,
        text: '🚫 هذا المستخدم قام بحظر البوت.'
      });
    } else {
      await sendMessage({
        chat_id: chatId,
        message_thread_id: topicId,
        text: `❌ تعذر الإيصال: <code>${escapeHtml(copyRes.description || 'Unknown error')}</code>`
      });
    }
    return;
  }

  const sentUserMsgId = copyRes.result?.message_id;
  if (sentUserMsgId) {
    await redisPipeline([
      ['SET', k(`t2u:${chatId}:${msg.message_id}`), `${targetUserId}:${sentUserMsgId}`, 'EX', String(MAP_TTL)],
      ['SET', k(`u2t:${targetUserId}:${sentUserMsgId}`), String(msg.message_id), 'EX', String(MAP_TTL)]
    ]);
  }
}

async function handleEditedMessage(editedMsg) {
  if (!editedMsg || !editedMsg.from || editedMsg.from.is_bot) return;
  const ownerId = getOwnerId();
  if (ownerId === 0) return;

  if (editedMsg.chat.type === 'private' && editedMsg.from.id !== ownerId) {
    const userId = editedMsg.from.id;
    const [rawUser, rawCfg, origTopicMsgId] = await redisPipeline([
      ['HGETALL', k(`u:${userId}`)],
      ['HGETALL', k('cfg')],
      ['GET', k(`u2t:${userId}:${editedMsg.message_id}`)]
    ]);

    const userHash = parseHash(rawUser);
    const cfg = parseHash(rawCfg);
    if (userHash.banned === '1' || !cfg.group || !userHash.topic) return;

    const groupId = Number(cfg.group);
    const topicId = Number(userHash.topic);
    const replyParams = origTopicMsgId
      ? { message_id: Number(origTopicMsgId), allow_sending_without_reply: true }
      : undefined;

    let sentRes;
    if (editedMsg.text) {
      sentRes = await sendMessage({
        chat_id: groupId,
        message_thread_id: topicId,
        text: `📝 <b>عدّل المستخدم الرسالة السابقة إلى:</b>\n\n${escapeHtml(editedMsg.text)}`,
        reply_parameters: replyParams
      });
    } else {
      sentRes = await copyMessage({
        chat_id: groupId,
        from_chat_id: editedMsg.chat.id,
        message_id: editedMsg.message_id,
        message_thread_id: topicId,
        reply_parameters: replyParams
      });
      if (sentRes.ok) {
        await sendMessage({
          chat_id: groupId,
          message_thread_id: topicId,
          text: '📝 <i>الرسالة أعلاه هي نسخة معدّلة من المستخدم</i>',
          reply_parameters: replyParams
        });
      }
    }

    if (sentRes?.ok && sentRes.result?.message_id) {
      const newTopicMsgId = sentRes.result.message_id;
      await redisPipeline([
        ['SET', k(`u2t:${userId}:${editedMsg.message_id}`), String(newTopicMsgId), 'EX', String(MAP_TTL)],
        ['SET', k(`t2u:${groupId}:${newTopicMsgId}`), `${userId}:${editedMsg.message_id}`, 'EX', String(MAP_TTL)]
      ]);
    }
    return;
  }

  if (
    (editedMsg.chat.type === 'group' || editedMsg.chat.type === 'supergroup') &&
    editedMsg.from.id === ownerId &&
    editedMsg.message_thread_id
  ) {
    const groupId = editedMsg.chat.id;
    const topicId = editedMsg.message_thread_id;

    const [targetUserIdStr, rawMap] = await redisPipeline([
      ['GET', k(`t:${groupId}:${topicId}`)],
      ['GET', k(`t2u:${groupId}:${editedMsg.message_id}`)]
    ]);

    const { userMsgId } = parseT2U(rawMap);
    if (!targetUserIdStr || !userMsgId) return;

    const targetUserId = Number(targetUserIdStr);

    if (editedMsg.text !== undefined) {
      await editMessageText({
        chat_id: targetUserId,
        message_id: userMsgId,
        text: editedMsg.text,
        entities: editedMsg.entities
      });
    } else if (editedMsg.caption !== undefined) {
      await editMessageCaption({
        chat_id: targetUserId,
        message_id: userMsgId,
        caption: editedMsg.caption,
        caption_entities: editedMsg.caption_entities
      });
    }
  }
}

async function handleReaction(reactionUpdate) {
  if (!reactionUpdate || !reactionUpdate.chat || !reactionUpdate.message_id) return;
  const actor = reactionUpdate.user;
  if (!actor || actor.is_bot) return;

  const ownerId = getOwnerId();
  if (ownerId === 0) return;

  const emojiReactions = (reactionUpdate.new_reaction || []).filter(
    (r) => r.type === 'emoji' && r.emoji
  );

  // 1) User reacted in Private Chat -> Mirror reaction to Topic message
  if (reactionUpdate.chat.type === 'private' && actor.id !== ownerId) {
    const userId = actor.id;
    const [rawCfg, targetTopicMsgId] = await redisPipeline([
      ['HGETALL', k('cfg')],
      ['GET', k(`u2t:${userId}:${reactionUpdate.message_id}`)]
    ]);
    const cfg = parseHash(rawCfg);
    if (!cfg.group || !targetTopicMsgId) return;

    await setMessageReaction({
      chat_id: Number(cfg.group),
      message_id: Number(targetTopicMsgId),
      reaction: emojiReactions
    });
    return;
  }

  // 2) Owner reacted inside Group Topic -> Mirror reaction to User's Private Chat
  if (
    (reactionUpdate.chat.type === 'group' || reactionUpdate.chat.type === 'supergroup') &&
    actor.id === ownerId
  ) {
    const groupId = reactionUpdate.chat.id;
    const rawMap = await redisCmd(['GET', k(`t2u:${groupId}:${reactionUpdate.message_id}`)]);
    const { userId, userMsgId } = parseT2U(rawMap);
    if (!userId || !userMsgId) return;

    await setMessageReaction({
      chat_id: userId,
      message_id: userMsgId,
      reaction: emojiReactions
    });
  }
}

async function handleCallback(cb) {
  const from = cb.from;
  const ownerId = getOwnerId();

  if (!from || from.id !== ownerId) {
    await answerCallbackQuery({
      callback_query_id: cb.id,
      text: 'غير مصرح لك.',
      show_alert: true
    });
    return;
  }

  const data = cb.data || '';

  if (data === 'toggle_mode') {
    const rawCfg = await redisCmd(['HGETALL', k('cfg')]);
    const cfg = parseHash(rawCfg);
    const nextMode = cfg.forward_mode === '1' ? '0' : '1';
    await redisCmd(['HSET', k('cfg'), 'forward_mode', nextMode]);
    cfg.forward_mode = nextMode;

    const dash = buildOwnerDashboard(cfg);
    if (cb.message?.message_id) {
      await editMessageText({
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: dash.text,
        reply_markup: dash.reply_markup,
        link_preview_options: { is_disabled: true }
      });
    }

    await answerCallbackQuery({
      callback_query_id: cb.id,
      text: nextMode === '1' ? 'تم التبديل إلى: إظهار الاسم (Forward)' : 'تم التبديل إلى: إخفاء الاسم (Copy)'
    });
    return;
  }

  if (data === 'edit_welcome') {
    await redisCmd(['HSET', k('cfg'), 'state', 'await_welcome']);
    await answerCallbackQuery({ callback_query_id: cb.id, text: 'أرسل نص الترحيب الجديد' });
    await sendMessage({
      chat_id: ownerId,
      text: '✏️ <b>أرسل الآن نص الترحيب الجديد:</b>\n• يدعم تنسيقات HTML.\n• يمكنك كتابة <code>{name}</code> ليتم استبدالها باسم المستخدم تلقائياً.\n• للإلغاء أرسل /start.'
    });
    return;
  }

  if (data === 'show_stats') {
    const [totalUsers, bannedUsers] = await redisPipeline([
      ['SCARD', k('users')],
      ['SCARD', k('banned_set')]
    ]);

    await answerCallbackQuery({
      callback_query_id: cb.id,
      text: `📊 إحصائيات البوت:\n• إجمالي المستخدمين: ${totalUsers || 0}\n• المحظورون: ${bannedUsers || 0}`,
      show_alert: true
    });
    return;
  }

  const [action, targetIdStr] = data.split(':');
  if (!isSafeId(targetIdStr)) {
    await answerCallbackQuery({ callback_query_id: cb.id, text: 'معرّف غير صالح' });
    return;
  }

  const targetUserId = Number(targetIdStr);
  const rawU = await redisCmd(['HGETALL', k(`u:${targetUserId}`)]);
  const uHash = parseHash(rawU);

  if (action === 'ban' || action === 'unban') {
    const banning = action === 'ban';
    await redisPipeline([
      ['HSET', k(`u:${targetUserId}`), 'banned', banning ? '1' : '0'],
      [banning ? 'SADD' : 'SREM', k('banned_set'), String(targetUserId)]
    ]);

    const isClosed = uHash.closed === '1';
    if (cb.message?.message_id) {
      await editMessageReplyMarkup({
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: buildUserCardMarkup(targetUserId, banning, isClosed)
      });
    }

    await answerCallbackQuery({
      callback_query_id: cb.id,
      text: banning ? '🚫 تم حظر المستخدم' : '✅ تم فك الحظر'
    });
    return;
  }

  if (action === 'close' || action === 'open') {
    const closing = action === 'close';
    const topicId = Number(uHash.topic || cb.message?.message_thread_id || 0);
    const groupId = cb.message?.chat?.id;

    if (groupId && topicId) {
      if (closing) {
        await closeForumTopic({ chat_id: groupId, message_thread_id: topicId });
      } else {
        await reopenForumTopic({ chat_id: groupId, message_thread_id: topicId });
      }
    }

    await redisCmd(['HSET', k(`u:${targetUserId}`), 'closed', closing ? '1' : '0']);
    const isBanned = uHash.banned === '1';

    if (cb.message?.message_id) {
      await editMessageReplyMarkup({
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: buildUserCardMarkup(targetUserId, isBanned, closing)
      });
    }

    await answerCallbackQuery({
      callback_query_id: cb.id,
      text: closing ? '🔒 تم إغلاق الموضوع' : '🔓 تم فتح الموضوع'
    });
  }
}

export async function handleUpdate(update) {
  if (update.message) {
    const chatType = update.message.chat?.type;
    if (chatType === 'private') {
      await handlePrivateMessage(update.message);
    } else if (chatType === 'group' || chatType === 'supergroup') {
      await handleGroupMessage(update.message);
    }
    return;
  }

  if (update.edited_message) {
    await handleEditedMessage(update.edited_message);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  if (update.message_reaction) {
    await handleReaction(update.message_reaction);
  }
}
