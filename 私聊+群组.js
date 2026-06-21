// ================= 环境变量 =================
const TOKEN = globalThis.BOT_TOKEN;
const SECRET = globalThis.BOT_SECRET;
const ADMIN_UID = String(globalThis.ADMIN_UID || '');
const DEFAULT_GROUP_CHAT_ID = globalThis.GROUP_CHAT_ID || null;

// 检查必要的环境变量
if (!TOKEN) {
  throw new Error('BOT_TOKEN is not set in environment variables');
}
if (!SECRET) {
  console.warn('BOT_SECRET is not set, webhook secret token will be empty');
}
if (!ADMIN_UID) {
  console.warn('ADMIN_UID is not set, admin commands will not work');
}

// ================= 常量配置 =================
const WEBHOOK = '/endpoint'
const NOTIFY_INTERVAL = 3600 * 1000;
const fraudDb = 'https://raw.githubusercontent.com/wuyangdaily/nfd/main/data/fraud.db';
const startMsgUrl = 'https://raw.githubusercontent.com/wuyangdaily/nfd/main/data/startMessage.md';

const chatSessions = {};

// 持久化 KV 键名
const GROUP_CHAT_ID_KV_KEY = 'group_chat_id';
const MODE_KV_KEY = 'mode';
const BLOCKED_USERS_KV_KEY = 'blockedUsers';
const FRAUD_LIST_KV_KEY = 'localFraudList';
const FRAUD_CACHE_KV_KEY = 'cached_fraud_db';
const FRAUD_CACHE_TIME_KV_KEY = 'cached_fraud_db_time';
const START_MSG_CACHE_KV_KEY = 'cached_start_message';
const START_MSG_CACHE_TIME_KV_KEY = 'cached_start_message_time';

// 常量：7 天过期时间（秒）
const DEFAULT_TTL = 7 * 24 * 3600;  // 7天 默认过期时间
const PENDING_MSG_TTL = 300;        // 5分钟 待转发消息过期时间
const CURRENT_TARGET_TTL = 1800;    // 30分钟 当前聊天目标过期时间
const FRAUD_CACHE_TTL = 3600;       // 1小时 骗子库更新间隔
const START_MSG_CACHE_TTL = 3600;   // 1小时 启动消息更新间隔

console.log(`[初始化] 环境变量已直接读取: ADMIN_UID=${ADMIN_UID}, GROUP_CHAT_ID=${DEFAULT_GROUP_CHAT_ID}`);

// 辅助函数：判断是否为永久保存的配置键
function isPermanentKey(key) {
  return key === MODE_KV_KEY ||
         key === GROUP_CHAT_ID_KV_KEY ||
         key === BLOCKED_USERS_KV_KEY ||
         key === FRAUD_LIST_KV_KEY ||
         key === FRAUD_CACHE_KV_KEY ||
         key === FRAUD_CACHE_TIME_KV_KEY ||
         key === START_MSG_CACHE_KV_KEY ||
         key === START_MSG_CACHE_TIME_KV_KEY;
}

// 封装 KV 写入，自动添加过期时间（永久键除外）
async function putWithTTL(key, value, options = {}) {
  if (!isPermanentKey(key) && !options.expirationTtl) {
    options.expirationTtl = DEFAULT_TTL;
  }
  await nfd.put(key, value, options);
}

// 清空所有临时 KV 数据（永久键除外）
async function clearTempKV() {
  let cursor = undefined;
  let deletedCount = 0;
  do {
    const listOptions = { limit: 1000 };
    if (cursor) listOptions.cursor = cursor;
    const list = await nfd.list(listOptions);
    for (const key of list.keys) {
      if (!isPermanentKey(key.name)) {
        await nfd.delete(key.name);
        deletedCount++;
      }
    }
    cursor = list.cursor;
  } while (cursor);
  console.log(`[clearTempKV] 已删除 ${deletedCount} 个临时键`);
  return deletedCount;
}

function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
}

function isAdmin(userId) {
  return String(userId) === ADMIN_UID;
}

function debugLog(...args) {
  try { console.log(...args); } catch(e) {}
}

function getCommandFromMessage(message) {
  if (!message || !message.text) return null;
  const text = message.text;
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return null;
  if (trimmed[0] !== '/') return null;
  const firstWord = trimmed.split(/\s/)[0];
  const cmd = firstWord.split('@')[0];
  return cmd;
}

// -------------------- 自动删除辅助函数 --------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scheduleDeletion(chatId, messageIds, delay = 3000, event = null) {
  if (!event) return;
  event.waitUntil((async () => {
    await sleep(delay);
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    for (const msgId of ids) {
      if (!msgId) continue;
      try {
        await requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: msgId }));
      } catch (e) {
        console.warn(`[自动删除] 删除消息 ${msgId} 失败:`, e);
      }
    }
  })());
}

// -------------------- Telegram API wrapper --------------------
function apiUrl(methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body, params = null){
  return fetch(apiUrl(methodName, params), body)
    .then(r => r.json())
}

function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

async function sendMessage(msg = {}) {
  try {
    const res = await requestTelegram('sendMessage', makeReqBody(msg));
    console.log('[sendMessage] request ->', JSON.stringify(msg), ' response ->', JSON.stringify(res));
    return res;
  } catch (err) {
    console.error('[sendMessage] error', err, 'msg=', JSON.stringify(msg));
    throw err;
  }
}

function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage(msg){
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

async function editMessageText(msg = {}) {
  try {
    const res = await requestTelegram('editMessageText', makeReqBody(msg));
    console.log('[editMessageText] request ->', JSON.stringify(msg), ' response ->', JSON.stringify(res));
    return res;
  } catch (err) {
    console.error('[editMessageText] error', err, 'msg=', JSON.stringify(msg));
    if (err && err.description && err.description.includes('message is not modified')) {
      return { ok: true };
    }
    throw err;
  }
}

async function editMessageCaption(msg = {}) {
  try {
    const res = await requestTelegram('editMessageCaption', makeReqBody(msg));
    console.log('[editMessageCaption] request ->', JSON.stringify(msg), ' response ->', JSON.stringify(res));
    return res;
  } catch (err) {
    console.error('[editMessageCaption] error', err, 'msg=', JSON.stringify(msg));
    if (err && err.description && err.description.includes('message is not modified')) {
      return { ok: true };
    }
    throw err;
  }
}

// ========== 支持媒体替换和内联键盘编辑 ==========
async function editMessageMedia(msg = {}) {
  try {
    const res = await requestTelegram('editMessageMedia', makeReqBody(msg));
    console.log('[editMessageMedia] request ->', JSON.stringify(msg), ' response ->', JSON.stringify(res));
    return res;
  } catch (err) {
    console.error('[editMessageMedia] error', err, 'msg=', JSON.stringify(msg));
    if (err && err.description && err.description.includes('message is not modified')) {
      return { ok: true };
    }
    throw err;
  }
}

async function editMessageReplyMarkup(msg = {}) {
  try {
    const res = await requestTelegram('editMessageReplyMarkup', makeReqBody(msg));
    console.log('[editMessageReplyMarkup] request ->', JSON.stringify(msg), ' response ->', JSON.stringify(res));
    return res;
  } catch (err) {
    console.error('[editMessageReplyMarkup] error', err, 'msg=', JSON.stringify(msg));
    if (err && err.description && err.description.includes('message is not modified')) {
      return { ok: true };
    }
    throw err;
  }
}

// 辅助函数：从消息中提取媒体信息
function extractMediaFromMessage(msg) {
  if (msg.photo) {
    const largest = msg.photo.reduce((a, b) => (a.file_size > b.file_size ? a : b), msg.photo[0]);
    return { type: 'photo', file_id: largest.file_id };
  }
  if (msg.video) {
    return { type: 'video', file_id: msg.video.file_id };
  }
  if (msg.animation) {
    return { type: 'animation', file_id: msg.animation.file_id };
  }
  if (msg.audio) {
    return { type: 'audio', file_id: msg.audio.file_id };
  }
  if (msg.document) {
    return { type: 'document', file_id: msg.document.file_id };
  }
  if (msg.sticker) {
    return { type: 'sticker', file_id: msg.sticker.file_id };
  }
  if (msg.voice) {
    return { type: 'voice', file_id: msg.voice.file_id };
  }
  return null;
}

function generateKeyboard(options) {
  return {
    reply_markup: {
      inline_keyboard: options.map(option => [{
        text: option.text,
        callback_data: option.callback_data
      }])
    }
  };
}

function generateAdminCommandKeyboard(uid, nicknamePlain, mode = 'private') {
  const commonRows = [
    [
      { text: '查看昵称', callback_data: `search_${uid}` },
      { text: '屏蔽用户', callback_data: `block_${uid}` }
    ],
    [
      { text: '解除屏蔽', callback_data: `unblock_${uid}` },
      { text: '检查屏蔽', callback_data: `checkblock_${uid}` }
    ],
    [
      { text: '添加骗子', callback_data: `fraud_${uid}` },
      { text: '移除骗子', callback_data: `unfraud_${uid}` }
    ],
    [
      { text: '查看骗子列表', callback_data: `list_${uid}` },
      { text: '查看屏蔽列表', callback_data: `blocklist_${uid}` }
    ]
  ];

  let additionalRows;
  if (mode === 'group') {
    additionalRows = [[{ text: '结束会话', callback_data: `end_${uid}` }]];
  } else {
    additionalRows = [
      [{ text: `选择 ${nicknamePlain}`, callback_data: `select_${uid}` }],
      [{ text: `取消 ${nicknamePlain}`, callback_data: `cancel_${uid}` }]
    ];
  }

  const rows = [...commonRows, ...additionalRows];
  return { reply_markup: { inline_keyboard: rows } };
}

// -------------------- 消息映射存储 --------------------
async function saveMessageMapping(sourceChatId, sourceMsgId, targetChatId, targetMsgId, msgType = 'text', mediaType = null, hasReplyMarkup = false) {
  const key = `msg_map_${sourceChatId}_${sourceMsgId}`;
  const data = {
    target_chat_id: targetChatId,
    target_message_id: targetMsgId,
    type: msgType,
    media_type: mediaType,
    has_reply_markup: hasReplyMarkup
  };
  await putWithTTL(key, JSON.stringify(data));
  const reverseKey = `msg_map_rev_${targetChatId}_${targetMsgId}`;
  await putWithTTL(reverseKey, JSON.stringify({ source_chat_id: sourceChatId, source_message_id: sourceMsgId, type: msgType, media_type: mediaType }));
  console.log(`[映射保存] ${sourceChatId}:${sourceMsgId} -> ${targetChatId}:${targetMsgId} (type: ${msgType}, media: ${mediaType})`);
}

async function getTargetMessage(sourceChatId, sourceMsgId) {
  const key = `msg_map_${sourceChatId}_${sourceMsgId}`;
  const data = await nfd.get(key, { type: 'json' });
  console.log(`[映射查询] ${sourceChatId}:${sourceMsgId} -> ${data ? JSON.stringify(data) : 'null'}`);
  return data;
}

async function getSourceMessage(targetChatId, targetMsgId) {
  const key = `msg_map_rev_${targetChatId}_${targetMsgId}`;
  const data = await nfd.get(key, { type: 'json' });
  return data;
}

// -------------------- KV 存储操作 --------------------
async function saveChatSession() {
  await putWithTTL('chatSessions', JSON.stringify(chatSessions));
}

async function loadChatSession() {
  const storedSessions = await nfd.get('chatSessions');
  if (storedSessions) {
    Object.assign(chatSessions, JSON.parse(storedSessions));
  }
}

async function generateRecentChatButtons() {
  const recentChatTargets = await getRecentChatTargets();
  const buttons = await Promise.all(recentChatTargets.map(async chatId => {
    const userInfo = await getUserInfo(chatId);
    const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${chatId}`;
    return {
      text: `发给：${nickname}`,
      callback_data: `select_${chatId}`
    };
  }));
  return generateKeyboard(buttons);
}

// 屏蔽列表操作
async function isUserBlocked(userId) {
  const blockedList = await nfd.get(BLOCKED_USERS_KV_KEY, { type: 'json' }) || [];
  return blockedList.includes(String(userId));
}

async function blockUser(userId) {
  let blockedList = await nfd.get(BLOCKED_USERS_KV_KEY, { type: 'json' }) || [];
  if (!blockedList.includes(String(userId))) {
    blockedList.push(String(userId));
    await putWithTTL(BLOCKED_USERS_KV_KEY, JSON.stringify(blockedList));
  }
}

async function unblockUser(userId) {
  let blockedList = await nfd.get(BLOCKED_USERS_KV_KEY, { type: 'json' }) || [];
  const idx = blockedList.indexOf(String(userId));
  if (idx !== -1) {
    blockedList.splice(idx, 1);
    await putWithTTL(BLOCKED_USERS_KV_KEY, JSON.stringify(blockedList));
  }
}

async function getBlockedUsers() {
  return await nfd.get(BLOCKED_USERS_KV_KEY, { type: 'json' }) || [];
}

// 本地骗子列表操作
async function getLocalFraudList() {
  return await nfd.get(FRAUD_LIST_KV_KEY, { type: 'json' }) || [];
}

async function addLocalFraud(userId) {
  let list = await getLocalFraudList();
  if (!list.includes(String(userId))) {
    list.push(String(userId));
    await putWithTTL(FRAUD_LIST_KV_KEY, JSON.stringify(list));
  }
}

async function removeLocalFraud(userId) {
  let list = await getLocalFraudList();
  const idx = list.indexOf(String(userId));
  if (idx !== -1) {
    list.splice(idx, 1);
    await putWithTTL(FRAUD_LIST_KV_KEY, JSON.stringify(list));
  }
}

// ---------- 获取当前北京时间字符串 (YYYY-MM-DD HH:MM:SS) ----------
function getBeijingTimeString() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 3600 * 1000);
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getUTCDate()).padStart(2, '0');
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function beijingStringToTimestamp(beijingStr) {
  const match = beijingStr.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);
  return Date.UTC(year, month, day, hour - 8, minute, second);
}

// 远程骗子库缓存
async function getFraudSet() {
  const now = Date.now();
  let lastUpdateStr = await nfd.get(FRAUD_CACHE_TIME_KV_KEY);
  let cachedData = await nfd.get(FRAUD_CACHE_KV_KEY, { type: 'json' });
  
  let lastUpdate = null;
  if (lastUpdateStr) {
    lastUpdate = beijingStringToTimestamp(lastUpdateStr);
    if (isNaN(lastUpdate)) lastUpdate = null;
  }
  
  let needUpdate = false;
  if (!cachedData) {
    needUpdate = true;
  } else if (!lastUpdate || (now - lastUpdate) > FRAUD_CACHE_TTL * 1000) {
    needUpdate = true;
  }
  
  if (needUpdate) {
    console.log('[getFraudSet] 需要更新骗子库，开始拉取远程数据...');
    try {
      const response = await fetch(fraudDb);
      const text = await response.text();
      const lines = text.split('\n').filter(v => v.trim().length > 0);
      await putWithTTL(FRAUD_CACHE_KV_KEY, JSON.stringify(lines));
      const beijingTimeStr = getBeijingTimeString();
      await putWithTTL(FRAUD_CACHE_TIME_KV_KEY, beijingTimeStr);
      console.log(`[getFraudSet] 已更新骗子库，共 ${lines.length} 条记录，更新时间: ${beijingTimeStr}`);
      return new Set(lines);
    } catch (err) {
      console.error('[getFraudSet] 拉取失败，使用旧缓存', err);
      if (cachedData) return new Set(cachedData);
      throw err;
    }
  }
  
  console.log('[getFraudSet] 使用缓存中的骗子库');
  return new Set(cachedData);
}

async function isFraud(id){
  id = id.toString();
  const localList = await getLocalFraudList();
  if (localList.includes(id)) return true;
  const fraudSet = await getFraudSet();
  return fraudSet.has(id);
}

// 启动消息缓存
async function getStartMessage() {
  const now = Date.now();
  let lastUpdateStr = await nfd.get(START_MSG_CACHE_TIME_KV_KEY);
  let cachedMsg = await nfd.get(START_MSG_CACHE_KV_KEY);
  
  let lastUpdate = null;
  if (lastUpdateStr) {
    lastUpdate = beijingStringToTimestamp(lastUpdateStr);
    if (isNaN(lastUpdate)) lastUpdate = null;
  }
  
  let needUpdate = false;
  if (!cachedMsg) {
    needUpdate = true;
  } else if (!lastUpdate || (now - lastUpdate) > START_MSG_CACHE_TTL * 1000) {
    needUpdate = true;
  }
  
  if (needUpdate) {
    console.log('[getStartMessage] 需要更新启动消息，开始拉取远程数据...');
    try {
      const response = await fetch(startMsgUrl);
      const text = await response.text();
      await putWithTTL(START_MSG_CACHE_KV_KEY, text);
      const beijingTimeStr = getBeijingTimeString();
      await putWithTTL(START_MSG_CACHE_TIME_KV_KEY, beijingTimeStr);
      console.log(`[getStartMessage] 已更新启动消息缓存，更新时间: ${beijingTimeStr}`);
      return text;
    } catch (err) {
      console.error('[getStartMessage] 拉取失败，使用旧缓存', err);
      if (cachedMsg) return cachedMsg;
      throw err;
    }
  }
  
  console.log('[getStartMessage] 使用缓存中的启动消息');
  return cachedMsg;
}

async function saveRecentChatTargets(chatId) {
  let recentChatTargets = await nfd.get('recentChatTargets', { type: "json" }) || [];
  recentChatTargets = recentChatTargets.filter(id => id !== chatId.toString());
  recentChatTargets.unshift(chatId.toString());
  if (recentChatTargets.length > 5) {
    recentChatTargets.pop();
  }
  await putWithTTL('recentChatTargets', JSON.stringify(recentChatTargets));
}

async function getRecentChatTargets() {
  let recentChatTargets = await nfd.get('recentChatTargets', { type: "json" }) || [];
  return recentChatTargets.map(id => id.toString());
}

// 当前聊天目标
async function getCurrentChatTarget() {
  const data = await nfd.get('currentChatTarget', { type: 'json' });
  return data ? data.target : null;
}

async function setCurrentChatTarget(target) {
  await putWithTTL('currentChatTarget', JSON.stringify({ target }), { expirationTtl: CURRENT_TARGET_TTL });
}

// 待转发消息存储
async function savePendingMessage(message) {
  const key = `pending_msg_${ADMIN_UID}`;
  const data = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: message.text || null,
    hasMedia: !!(message.photo || message.video || message.document || message.audio),
  };
  await putWithTTL(key, JSON.stringify(data), { expirationTtl: PENDING_MSG_TTL });
}

async function consumePendingMessage() {
  const key = `pending_msg_${ADMIN_UID}`;
  const data = await nfd.get(key, { type: 'json' });
  if (data) {
    await nfd.delete(key);
    return data;
  }
  return null;
}

// ================= 模式配置加载与保存 =================
async function getCurrentMode() {
  const mode = await nfd.get(MODE_KV_KEY);
  return mode === 'group' ? 'group' : 'private';
}

async function setCurrentMode(mode) {
  await putWithTTL(MODE_KV_KEY, mode);
}

async function getGroupChatId() {
  let gid = DEFAULT_GROUP_CHAT_ID;
  if (!gid) {
    gid = await nfd.get(GROUP_CHAT_ID_KV_KEY);
  }
  return gid || null;
}

async function setGroupChatId(gid) {
  await putWithTTL(GROUP_CHAT_ID_KV_KEY, gid);
}

let configLoadedPromise = null;
async function ensureConfigLoaded() {
  if (!configLoadedPromise) {
    configLoadedPromise = (async () => {
      await loadChatSession();
      console.log('[ensureConfigLoaded] 配置加载完成');
    })();
  }
  await configLoadedPromise;
}

// ================= 群组话题管理 =================
async function createForumTopic(chatId, name, userId) {
  const topicName = `${name} | ${userId}`;
  const response = await requestTelegram('createForumTopic', makeReqBody({
    chat_id: chatId,
    name: topicName
  }));
  if (response.ok && response.result) {
    return response.result.message_thread_id;
  } else {
    console.error('创建话题失败:', response);
    return null;
  }
}

async function ensureUserTopic(userId, displayName) {
  const groupChatId = await getGroupChatId();
  let topicId = await nfd.get('user_topic_' + userId, { type: 'json' });
  if (!topicId && groupChatId) {
    topicId = await createForumTopic(groupChatId, displayName, userId);
    if (topicId) {
      await putWithTTL('user_topic_' + userId, JSON.stringify(topicId));
      await putWithTTL('topic_user_' + topicId, userId);
    }
  }
  return topicId;
}

async function sendAdminButtonsInTopic(topicId, userId, nicknamePlain, nicknameEsc) {
  const groupChatId = await getGroupChatId();
  if (!groupChatId) return;
  let text = `👤: [*${nicknameEsc}*](tg://user?id=${userId})\n🆔: ${userId}`;
  if (await isFraud(userId)) {
    text += `\n\n⚠️ *请注意，该用户是骗子！*`;
  }
  const sent = await sendMessage({
    chat_id: groupChatId,
    message_thread_id: topicId,
    parse_mode: 'MarkdownV2',
    text: text,
    ...generateAdminCommandKeyboard(userId, nicknamePlain, 'group')
  });
  if (sent.ok && sent.result) {
    console.log(`[映射保存] 管理按钮消息发送成功，消息ID: ${sent.result.message_id}`);
  } else {
    console.error('[映射保存] 管理按钮消息发送失败');
  }
}

async function forwardUserMessageToTopic(userId, topicId, message) {
  const groupChatId = await getGroupChatId();
  if (!groupChatId) return;
  const copyReq = await copyMessage({
    chat_id: groupChatId,
    message_thread_id: topicId,
    from_chat_id: userId,
    message_id: message.message_id
  });
  if (copyReq.ok && copyReq.result) {
    const copiedMsgId = copyReq.result.message_id;
    const mediaInfo = extractMediaFromMessage(message);
    const msgType = message.text ? 'text' : (message.caption ? 'caption' : 'media');
    await saveMessageMapping(userId, message.message_id, groupChatId, copiedMsgId, msgType, mediaInfo ? mediaInfo.type : null, !!message.reply_markup);
    console.log(`[映射保存] 用户消息 ${message.message_id} 已复制到话题 ${copiedMsgId}`);
  } else {
    console.error('[转发] 复制消息失败:', copyReq);
  }
  return copyReq;
}

async function initUserTopicIfNeeded(userId) {
  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();
  if (currentMode !== 'group' || !groupChatId) return;

  let topicId = await nfd.get('user_topic_' + userId, { type: 'json' });
  if (topicId) {
    const isInitialized = await nfd.get('topic_initialized_' + topicId);
    if (isInitialized) return;
  }

  const userInfo = await getUserInfo(userId);
  const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${userId}`;
  const nicknameEsc = escapeMarkdown(nicknamePlain);

  topicId = await ensureUserTopic(userId, nicknamePlain);
  if (topicId) {
    await sendAdminButtonsInTopic(topicId, userId, nicknamePlain, nicknameEsc);
    await putWithTTL('topic_initialized_' + topicId, '1');
    console.log(`[初始化] 为用户 ${userId} 创建话题 ${topicId} 并发送管理按钮`);
  }
}

// ================= 验证模块 =================
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createMathQuestion() {
  const operations = [
    { symbol: '+', name: '加' },
    { symbol: '-', name: '减' },
    { symbol: '×', name: '乘' },
    { symbol: '÷', name: '除' }
  ];
  
  const operation = operations[randInt(0, operations.length - 1)];
  
  let A, B, result, expr;
  
  switch (operation.symbol) {
    case '+':
      A = randInt(1, 50);
      B = randInt(1, 50);
      result = A + B;
      expr = `${A} + ${B}`;
      break;
    case '-':
      A = randInt(2, 100);
      B = randInt(1, A - 1);
      result = A - B;
      expr = `${A} - ${B}`;
      break;
    case '×':
      A = randInt(1, 12);
      B = randInt(1, 12);
      result = A * B;
      expr = `${A} × ${B}`;
      break;
    case '÷':
      B = randInt(2, 12);
      result = randInt(1, 12);
      A = B * result;
      expr = `${A} ÷ ${B}`;
      break;
    default:
      A = randInt(1, 50);
      B = randInt(1, 50);
      result = A + B;
      expr = `${A} + ${B}`;
  }
  
  return { expr, value: result };
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function deleteOldVerifyMsg(chatId) {
  try {
    const key = 'verify-' + chatId;
    const v = await nfd.get(key, { type: "json" });
    if (v && v.message_id) {
      try {
        await requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: v.message_id }));
      } catch (e) {
        console.warn('[deleteOldVerifyMsg] deleteMessage failed', e);
      }
    }
    await nfd.delete(key);
  } catch (e) {
    console.warn('[deleteOldVerifyMsg] failed', e);
  }
}

function oneLineKeyboardForOptions(chatId, options) {
  return {
    reply_markup: {
      inline_keyboard: [ options.map(opt => ({ text: opt.text, callback_data: opt.callback_data })) ]
    }
  };
}

// 处理验证超时并累计失败次数
async function handleExpiredVerification(userId) {
  // 检查是否已锁定
  const lockKey = 'verify-lock-' + userId;
  const lockVal = await nfd.get(lockKey, { type: "json" });
  if (lockVal && Number(lockVal) > Date.now()) {
    return false;
  }
  
  const key = 'verify-' + userId;
  const recRaw = await nfd.get(key);
  if (!recRaw) return false;
  
  const rec = JSON.parse(recRaw);
  if (Date.now() <= rec.expires) return false;
  
  // 超时，增加失败计数
  const attemptKey = 'verify-attempts-' + userId;
  let attempts = await nfd.get(attemptKey, { type: "json" }) || 0;
  attempts++;
  await putWithTTL(attemptKey, JSON.stringify(attempts));
  
  // 删除旧的验证消息和记录
  await deleteOldVerifyMsg(userId);
  
  if (attempts >= 3) {
    // 达到3次失败，锁定1小时
    const until = await lockUser(userId);
    await nfd.delete(attemptKey);
    const remainMs = until - Date.now();
    const minutes = Math.floor(remainMs / 60000);
    const seconds = Math.floor((remainMs % 60000) / 1000);
    const bj = new Date(until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await sendMessage({
      chat_id: userId,
      text: `验证失败次数(含超时)已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试`
    });
    return true;
  } else {
    // 未达锁定次数，提示超时并重新发送验证
    await sendMessage({ chat_id: userId, text: '验证已超时，请重新验证。' });
    await sendVerify(userId);
    return true;
  }
}

async function sendVerify(chatId) {
  const lockKey = 'verify-lock-' + chatId;
  const lockVal = await nfd.get(lockKey, { type: "json" });
  if (lockVal && Number(lockVal) > Date.now()) {
    const remain = Number(lockVal) - Date.now();
    const minutes = Math.floor(remain/60000);
    const seconds = Math.floor((remain%60000)/1000);
    const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await sendMessage({ chat_id: chatId, text: `验证失败次数(含超时)已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
    return;
  }

  await deleteOldVerifyMsg(chatId);

  const q = createMathQuestion();
  const correct = q.value;
  const options = new Set();
  options.add(String(correct));
  while (options.size < 5) {
    const delta = randInt(-5, 5);
    let candidate = correct + delta;
    if (candidate <= 0) candidate = randInt(1, 10);
    if (candidate === correct) candidate += randInt(1, 3);
    options.add(String(candidate));
  }
  
  const optsArr = Array.from(options);
  shuffleArray(optsArr);
  const correctIndex = optsArr.findIndex(x => String(x) === String(correct));

  const btns = optsArr.map((t, idx) => {
    return {
      text: t,
      callback_data: `verify_${chatId}_${idx}`
    };
  });

  const text = `请先通过验证（10 秒内回答）:\n${q.expr} = ?\n（错误或超时3次将被锁定1小时）`;

  const sent = await sendMessage({
    chat_id: chatId,
    text,
    ...oneLineKeyboardForOptions(chatId, btns)
  });

  const key = 'verify-' + chatId;
  const rec = {
    expr: q.expr,
    correct: String(correct),
    options: optsArr,
    correctIndex,
    message_id: sent && sent.result ? sent.result.message_id : (sent && sent.message_id) || null,
    expires: Date.now() + 10 * 1000
  };
  await putWithTTL(key, JSON.stringify(rec));
}

async function lockUser(chatId) {
  const lockKey = 'verify-lock-' + chatId;
  const until = Date.now() + 60 * 60 * 1000;
  await putWithTTL(lockKey, JSON.stringify(until), { expirationTtl: 3600 });
  return until;
}

// ================= 清理用户话题映射并删除实际话题 =================
async function clearUserTopicMapping(userId) {
  try {
    const groupChatId = await getGroupChatId();
    const topicId = await nfd.get('user_topic_' + userId, { type: 'json' });
    if (topicId) {
      // 1. 删除 Telegram 上的实际话题
      if (groupChatId) {
        try {
          const delRes = await requestTelegram('deleteForumTopic', makeReqBody({
            chat_id: groupChatId,
            message_thread_id: topicId
          }));
          if (delRes.ok) {
            console.log(`[清理] 成功删除群组 ${groupChatId} 中的话题 ${topicId}（用户 ${userId}）`);
          } else {
            console.warn(`[清理] 删除话题 ${topicId} 失败:`, delRes);
          }
        } catch (e) {
          console.error(`[清理] 调用 deleteForumTopic 异常:`, e);
        }
      }
      // 2. 删除 KV 中的映射
      await nfd.delete('user_topic_' + userId);
      await nfd.delete('topic_user_' + topicId);
      await nfd.delete('topic_initialized_' + topicId);
      console.log(`[清理] 已删除用户 ${userId} 的话题映射 (话题ID: ${topicId})`);
    } else {
      console.log(`[清理] 用户 ${userId} 没有话题映射，无需清理`);
    }
  } catch (e) {
    console.error(`[清理] 删除用户 ${userId} 话题映射失败:`, e);
  }
}

// ================= 清理所有用户话题 =================
async function clearAllUserTopics() {
  let cursor = undefined;
  let deletedCount = 0;
  do {
    const listOptions = { prefix: 'user_topic_', limit: 100 };
    if (cursor) listOptions.cursor = cursor;
    const list = await nfd.list(listOptions);
    for (const key of list.keys) {
      const userId = key.name.replace('user_topic_', '');
      console.log(`[clearAllUserTopics] 正在清理用户 ${userId} 的话题`);
      await clearUserTopicMapping(userId);
      deletedCount++;
    }
    cursor = list.cursor;
  } while (cursor);
  console.log(`[clearAllUserTopics] 共清理 ${deletedCount} 个用户的话题`);
  return deletedCount;
}

// ================= isVerified：有效期为 1 天 =================
async function isVerified(chatId) {
  const key = 'verified-' + chatId;
  const v = await nfd.get(key, { type: "json" });
  if (!v) return false;
  const ts = Number(v);
  if (!ts) return false;
  // 1 天有效期
  if (Date.now() - ts < 24 * 3600 * 1000) return true;
  // 删除验证记录
  await nfd.delete(key);
  return false;
}

async function setVerified(chatId) {
  await putWithTTL('verified-' + chatId, JSON.stringify(Date.now()));
}

// -------------------- 管理端点 --------------------
async function setBotCommands() {
  try {
    const commands = [
      { command: 'start', description: '启动机器人' },
      { command: 'help', description: '显示帮助信息' },
      { command: 'mode', description: '私聊/话题 模式切换 (管理员)' },
      { command: 'setgroup', description: '设置群组ID (管理员)' },
      { command: 'del', description: '删除所有临时数据 (管理员)' },
      { command: 'search', description: '查看指定uid用户最新昵称 (管理员)' },
      { command: 'block', description: '屏蔽用户 (管理员)' },
      { command: 'unblock', description: '解除屏蔽 (管理员)' },
      { command: 'checkblock', description: '检查是否被屏蔽 (管理员)' },
      { command: 'fraud', description: '添加骗子ID - [本地库] (管理员)' },
      { command: 'unfraud', description: '移除骗子ID - [本地库] (管理员)' },
      { command: 'list', description: '查看骗子ID列表 - [本地库] (管理员)' },
      { command: 'blocklist', description: '查看屏蔽用户列表 - [本地库] (管理员)' }
    ];

    const result = await requestTelegram('setMyCommands', makeReqBody({ commands }));
    if (result.ok) {
      return new Response('Ok', { status: 200 });
    } else {
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    console.error('[setBotCommands] 异常:', err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}

async function registerWebhook(event, requestUrl, suffix, secret) {
  try {
    const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`;
    const result = await requestTelegram('setWebhook', null, { url: webhookUrl, secret_token: secret });
    if (result.ok) {
      return new Response('Ok', { status: 200 });
    } else {
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    console.error('[registerWebhook] 异常:', err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}

async function unRegisterWebhook(event) {
  try {
    const result = await requestTelegram('setWebhook', null, { url: '' });
    if (result.ok) {
      return new Response('Ok', { status: 200 });
    } else {
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    console.error('[unRegisterWebhook] 异常:', err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}

// -------------------- Cloudflare Worker HTTP 入口 --------------------
addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event));
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET));
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event));
  } else if (url.pathname === '/setCommands') {
    event.respondWith(setBotCommands());
  } else {
    event.respondWith(new Response('No handler for this request'));
  }
});

async function handleWebhook(event) {
  if (!TOKEN) {
    console.error('BOT_TOKEN not set');
    return new Response('BOT_TOKEN not set', { status: 500 });
  }

  await ensureConfigLoaded();

  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 });
  }

  const update = await event.request.json();
  try { console.log('[onUpdate] incoming update:', JSON.stringify(update)); } catch(e){}

  event.waitUntil(onUpdate(update, event));

  return new Response('Ok');
}

async function onUpdate(update, event) {
  if (update.message) {
    await onMessage(update.message, event);
  } else if (update.edited_message) {
    await onEditedMessage(update.edited_message, event);
  } else if (update.callback_query) {
    await onCallbackQuery(update.callback_query, event);
  }
}

// -------------------- Telegram helper getters --------------------
async function getUserInfo(chatId) {
  const response = await requestTelegram('getChat', makeReqBody({ chat_id: chatId }));
  console.log(`Response for getUserInfo with chatId ${chatId}:`, response);
  if (response.ok) {
    return response.result;
  } else {
    console.error(`Failed to get user info for chat ID ${chatId}:`, response);
    return null;
  }
}

async function getChatMember(chatId) {
  const response = await requestTelegram('getChatMember', makeReqBody({ chat_id: chatId, user_id: chatId }));
  console.log(`Response for getChatMember with chatId ${chatId}:`, response);
  if (response.ok) {
    return response.result;
  } else {
    console.error(`Failed to get chat member info for chat ID ${chatId}:`, response);
    return null;
  }
}

async function getUserProfilePhotos(userId) {
  const response = await requestTelegram('getUserProfilePhotos', makeReqBody({ user_id: userId }));
  console.log(`Response for getUserProfilePhotos with userId ${userId}:`, response);
  if (response.ok) {
    const photos = response.result.photos;
    if (photos.length > 0) {
      return `用户存在，头像数量: ${photos.length}`;
    } else {
      return '用户存在，但没有头像';
    }
  } else {
    console.error(`Failed to get user profile photos for user ID ${userId}:`, response);
    return null;
  }
}

async function getChat(chatId) {
  const response = await requestTelegram('getChat', makeReqBody({ chat_id: chatId }));
  console.log(`Response for getChat with chatId ${chatId}:`, response);
  if (response.ok) {
    return response.result;
  } else {
    console.error(`Failed to get chat info for chat ID ${chatId}:`, response);
    return null;
  }
}

async function getDisplayName(uid, forMarkdownV2 = false) {
  try {
    const userInfo = await getUserInfo(uid);
    let name;
    if (userInfo) {
      name = `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim();
      if (!name) name = `UID:${uid}`;
    } else {
      name = `UID:${uid}`;
    }
    if (forMarkdownV2) return escapeMarkdown(name);
    return name;
  } catch (e) {
    console.warn('[getDisplayName] failed for', uid, e);
    return forMarkdownV2 ? escapeMarkdown(`UID:${uid}`) : `UID:${uid}`;
  }
}

// -------------------- requireAdmin --------------------
async function requireAdmin(message, event, commandMsgId) {
  const senderId = message && message.from ? message.from.id : null;
  const idToCheck = senderId || (message && message.chat ? message.chat.id : null);

  debugLog('requireAdmin called. senderId=', senderId, 'idToCheck=', idToCheck, 'ADMIN_UID=', ADMIN_UID);

  if (isAdmin(idToCheck)) {
    return true;
  }

  const chatTarget = message && message.chat && message.chat.id ? message.chat.id : senderId;
  const threadId = message.message_thread_id;

  const sendOptions = {
    chat_id: chatTarget,
    text: '此命令仅限管理员使用',
    reply_to_message_id: commandMsgId
  };
  if (threadId) sendOptions.message_thread_id = threadId;

  const res = await sendMessage(sendOptions);
  if (res && res.ok && res.result && event) {
    scheduleDeletion(chatTarget, [commandMsgId, res.result.message_id], 3000, event);
  } else {
    debugLog('[requireAdmin] send to chat failed, trying fallback. res=', res);
    if (senderId && String(senderId) !== String(chatTarget)) {
      try {
        const fallbackRes = await sendMessage({
          chat_id: senderId,
          text: '此命令仅限管理员使用',
          reply_to_message_id: commandMsgId
        });
        if (fallbackRes && fallbackRes.ok && fallbackRes.result && event) {
          scheduleDeletion(senderId, [commandMsgId, fallbackRes.result.message_id], 3000, event);
        }
      } catch (e2) {
        console.error('[requireAdmin] fallback sendMessage failed', e2);
      }
    }
  }

  return false;
}

// ================= 核心：增强的编辑消息处理 =================
async function onEditedMessage(message, event) {
  try { console.log('[onEditedMessage] raw message:', JSON.stringify(message)); } catch(e){}

  const fromId = message.from ? message.from.id : null;
  const chatId = message.chat.id.toString();
  const isAdminUser = isAdmin(fromId);

  if (message.chat.type !== 'private' && !isAdminUser) {
    console.log('[忽略] 非私聊且非管理员的编辑消息，来自', fromId);
    return;
  }

  const target = await getTargetMessage(chatId, message.message_id);
  if (!target) {
    console.log('[编辑] 未找到映射，忽略');
    return;
  }

  const targetChatId = target.target_chat_id;
  const targetMsgId = target.target_message_id;
  const originalType = target.type;
  const originalMediaType = target.media_type;

  // 1. 优先处理内联键盘的编辑
  if (message.reply_markup) {
    await editMessageReplyMarkup({
      chat_id: targetChatId,
      message_id: targetMsgId,
      reply_markup: message.reply_markup
    }).catch(err => console.error('[编辑] 编辑键盘失败', err));
    return;
  }

  // 2. 处理文本编辑
  if (message.text !== undefined && message.text !== null) {
    if (originalType === 'text') {
      await editMessageText({
        chat_id: targetChatId,
        message_id: targetMsgId,
        text: message.text,
        parse_mode: message.parse_mode || undefined,
        entities: message.entities
      }).catch(err => console.error('[编辑] 编辑文本失败', err));
    } else {
      console.warn('[编辑] 无法将媒体消息编辑为纯文本，忽略');
    }
    return;
  }

  // 3. 单独处理 caption 编辑
  const hasCaptionChange = message.caption !== undefined && message.caption !== null;
  const hasMediaChange = (() => {
    const media = extractMediaFromMessage(message);
    return media && media.file_id;
  })();

  if (hasCaptionChange && (originalType === 'caption' || originalType === 'media')) {
    try {
      await editMessageCaption({
        chat_id: targetChatId,
        message_id: targetMsgId,
        caption: message.caption,
        parse_mode: message.parse_mode || undefined,
        show_caption_above_media: message.show_caption_above_media
      });
      console.log('[编辑] caption 编辑成功');
      if (!hasMediaChange) return;
    } catch (err) {
      console.error('[编辑] editMessageCaption 失败', err);
      if (!hasMediaChange) return;
    }
  }

  // 4. 处理媒体文件替换
  if (hasMediaChange) {
    const newMedia = extractMediaFromMessage(message);
    if (originalMediaType === undefined) {
      console.warn('[编辑] 旧映射缺少 media_type，跳过媒体替换');
      return;
    }
    if (originalMediaType && newMedia.type !== originalMediaType) {
      console.warn(`[编辑] 媒体类型不兼容: 原 ${originalMediaType} -> 新 ${newMedia.type}，仍尝试编辑`);
    }
    const inputMedia = {
      type: newMedia.type,
      media: newMedia.file_id
    };
    if (message.caption) {
      inputMedia.caption = message.caption;
      inputMedia.parse_mode = message.parse_mode || undefined;
    }
    try {
      await editMessageMedia({
        chat_id: targetChatId,
        message_id: targetMsgId,
        media: inputMedia
      });
      console.log('[编辑] 媒体替换成功');
    } catch (err) {
      console.error('[编辑] 替换媒体失败', err);
    }
    return;
  }

  console.log('[编辑] 无支持的编辑内容');
}

// -------------------- 消息处理 --------------------
async function onMessage(message, event) {
  try { console.log('[onMessage] raw message:', JSON.stringify(message)); } catch(e){}

  const fromId = message.from ? message.from.id : null;
  const chatId = message.chat.id.toString();
  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();

  if (message.chat.type !== 'private' && !isAdmin(fromId)) {
    console.log('[忽略] 群组中的普通用户消息，来自', fromId);
    return;
  }

  if (!chatSessions[chatId]) {
    chatSessions[chatId] = {
      step: 0,
      lastInteraction: Date.now()
    };
  }

  const session = chatSessions[chatId];
  session.lastInteraction = Date.now();

  // ================= 处理群组模式下的管理员回复 =================
  if (groupChatId && String(chatId) === String(groupChatId) && isAdmin(fromId)) {
    // 先检查是否为命令，命令在群组中直接处理，不转发给用户
    const command = getCommandFromMessage(message);
    const args = message.text ? message.text.slice((command||'').length).trim() : '';
    const commandMsgId = message.message_id;
    const threadId = message.message_thread_id;

    // 辅助函数：在群组话题中发送回复并自动删除命令和回复
    const sendAndDeleteInGroup = async (replyText, extraOptions = {}) => {
      const sendOptions = {
        chat_id: chatId,
        text: replyText,
        reply_to_message_id: commandMsgId,
        message_thread_id: threadId,
        ...extraOptions
      };
      const res = await sendMessage(sendOptions);
      if (res && res.ok && res.result && event) {
        scheduleDeletion(chatId, [commandMsgId, res.result.message_id], 3000, event);
      }
      return res;
    };

    if (command && command.startsWith('/')) {
      // 处理命令
      if (command === '/start') {
        const startMsg = await getStartMessage();
        await sendAndDeleteInGroup(startMsg);
        return;
      } else if (command === '/help') {
        let helpMsg = "可用指令列表:\n" +
                      "/start - 启动机器人\n" +
                      "/help - 显示帮助信息\n" +
                      "/mode - 私聊/话题 模式切换 (管理员)\n" +
                      "/setgroup - 设置群组ID (管理员)\n" +
                      "/del - 删除所有临时数据 (管理员)\n" +
                      "/search - 查看指定uid用户最新昵称 (管理员)\n" +
                      "/block - 屏蔽用户 (管理员)\n" +
                      "/unblock - 解除屏蔽 (管理员)\n" +
                      "/checkblock - 检查是否被屏蔽 (管理员)\n" +
                      "/fraud - 添加骗子ID - [本地库] (管理员)\n" +
                      "/unfraud - 移除骗子ID - [本地库] (管理员)\n" +
                      "/list - 查看骗子ID列表 - [本地库] (管理员)\n" +
                      "/blocklist - 查看屏蔽用户列表 - [本地库] (管理员)\n";
        await sendAndDeleteInGroup(helpMsg);
        return;
      } else if (command === '/mode') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        const newMode = args.trim().toLowerCase();
        const curMode = await getCurrentMode();
        if (newMode === '') {
          if (curMode === 'private') {
            const gid = await getGroupChatId();
            if (!gid) {
              await sendAndDeleteInGroup('无法切换到群组模式：未设置群组ID。请先使用 /setgroup 设置群组ID或配置环境变量 GROUP_CHAT_ID。');
              return;
            }
            await setCurrentMode('group');
            await sendAndDeleteInGroup('已切换到群组模式。所有用户消息将转发到群组话题中。');
          } else {
            await setCurrentMode('private');
            await sendAndDeleteInGroup('已切换到私聊模式。所有用户消息将私聊转发给管理员。');
          }
          return;
        } else if (newMode === 'group') {
          const gid = await getGroupChatId();
          if (!gid) {
            await sendAndDeleteInGroup('请先设置群组ID（环境变量 GROUP_CHAT_ID 或使用 /setgroup 命令）。');
            return;
          }
          await setCurrentMode('group');
          await sendAndDeleteInGroup('已切换到群组模式。所有用户消息将转发到群组话题中。');
        } else if (newMode === 'private') {
          await setCurrentMode('private');
          await sendAndDeleteInGroup('已切换到私聊模式。所有用户消息将私聊转发给管理员。');
        } else {
          await sendAndDeleteInGroup(`当前模式: ${curMode}\n使用方法: /mode 或 /mode private 或 /mode group`);
        }
        return;
      } else if (command === '/setgroup') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        const newGroupId = args.trim();
        if (!newGroupId) {
          await sendAndDeleteInGroup('使用方法: /setgroup 群组ID');
          return;
        }
        await setGroupChatId(newGroupId);
        await sendAndDeleteInGroup(`群组ID已设置为: ${newGroupId}（持久化保存）`);
        return;
      } else if (command === '/del') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        // 先删除所有用户话题
        const topicCount = await clearAllUserTopics();
        // 再删除所有临时 KV 数据
        const kvCount = await clearTempKV();
        await sendAndDeleteInGroup(`已删除 ${topicCount} 个用户话题，并清理 ${kvCount} 个临时 KV 数据。`);
        return;
      } else if (command === '/blocklist') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        await listBlockedUsers(event, commandMsgId, chatId, threadId);
        return;
      } else if (command === '/unblock') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        if (message.reply_to_message) {
          await handleUnBlock(message, event, commandMsgId, chatId, threadId);
          return;
        }
        if (args) {
          const index = parseInt(args.split(' ')[0], 10);
          if (!isNaN(index)) {
            await unblockByIndex(index, event, commandMsgId, chatId, threadId);
            return;
          } else {
            await sendAndDeleteInGroup('无效的序号。');
            return;
          }
        }
        await sendAndDeleteInGroup('使用方法: 请【回复某条消息并输入 /unblock 】 或 【使用 /unblock 屏蔽序号 】来解除屏蔽用户。\n 屏蔽序号可以通过 /blocklist 获取');
        return;
      } else if (command === '/list') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        const fraudList = await getLocalFraudList();
        if (fraudList.length === 0) {
          await sendAndDeleteInGroup('本地没有骗子ID。');
        } else {
          const fraudListText = await Promise.all(fraudList.map(async uid => {
            const userInfo = await getUserInfo(uid);
            const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
            return `UID: ${uid}, 昵称: ${nickname}`;
          }));
          await sendAndDeleteInGroup(`本地骗子ID列表:\n${fraudListText.join('\n')}`);
        }
        return;
      } else if (command === '/search') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        if (message.reply_to_message) {
          const forwardedMsgId = message.reply_to_message.message_id;
          const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
          if (guestChatId) {
            const userInfo = await getChat(guestChatId);
            if (userInfo) {
              const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
              await sendAndDeleteInGroup(`UID: ${guestChatId}, 昵称: ${nickname}`);
              return;
            } else {
              await sendAndDeleteInGroup(`找不到 UID: ${guestChatId} 的详细信息`);
              return;
            }
          } else {
            await sendAndDeleteInGroup('无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。');
            return;
          }
        }
        if (args) {
          const searchId = args.split(' ')[0].toString();
          const userInfo = await getChat(searchId);
          if (userInfo) {
            const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
            await sendAndDeleteInGroup(`UID: ${searchId}, 昵称: ${nickname}`);
            return;
          } else {
            await sendAndDeleteInGroup(`无法找到 UID: ${searchId} 的用户信息`);
            return;
          }
        } else {
          await sendAndDeleteInGroup('使用方法: 请回复某条消息并输入 /search，或 /search 用户UID');
          return;
        }
      } else if (command === '/fraud') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        if (message.reply_to_message) {
          const forwardedMsgId = message.reply_to_message.message_id;
          const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
          if (guestChatId) {
            const idStr = String(guestChatId);
            const list = await getLocalFraudList();
            if (!list.includes(idStr)) {
              await addLocalFraud(idStr);
              await sendAndDeleteInGroup(`已添加骗子ID: ${idStr}`);
              return;
            } else {
              await sendAndDeleteInGroup(`骗子ID ${idStr} 已存在`);
              return;
            }
          } else {
            await sendAndDeleteInGroup('无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。');
            return;
          }
        }
        if (args) {
          const fraudId = args.split(' ')[0].toString();
          const list = await getLocalFraudList();
          if (!list.includes(fraudId)) {
            await addLocalFraud(fraudId);
            await sendAndDeleteInGroup(`已添加骗子ID: ${fraudId}`);
            return;
          } else {
            await sendAndDeleteInGroup(`骗子ID: ${fraudId} 已存在`);
            return;
          }
        } else {
          await sendAndDeleteInGroup('使用方法: 请回复某条消息并输入 /fraud，或 /fraud 用户UID');
          return;
        }
      } else if (command === '/unfraud') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        if (message.reply_to_message) {
          const forwardedMsgId = message.reply_to_message.message_id;
          const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
          if (guestChatId) {
            const idStr = String(guestChatId);
            const list = await getLocalFraudList();
            const idx = list.indexOf(idStr);
            if (idx > -1) {
              await removeLocalFraud(idStr);
              await sendAndDeleteInGroup(`已移除骗子ID: ${idStr}`);
              return;
            } else {
              await sendAndDeleteInGroup(`骗子ID ${idStr} 不在本地列表中`);
              return;
            }
          } else {
            await sendAndDeleteInGroup('无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。');
            return;
          }
        }
        if (args) {
          const fraudId = args.split(' ')[0].toString();
          const list = await getLocalFraudList();
          const index = list.indexOf(fraudId);
          if (index > -1) {
            await removeLocalFraud(fraudId);
            await sendAndDeleteInGroup(`已移除骗子ID: ${fraudId}`);
            return;
          } else {
            await sendAndDeleteInGroup(`骗子ID: ${fraudId} 不在本地列表中`);
            return;
          }
        } else {
          await sendAndDeleteInGroup('使用方法: 请回复某条消息并输入 /unfraud，或 /unfraud 用户UID');
          return;
        }
      } else if (command === '/block') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        if (message.reply_to_message) {
          await handleBlock(message, event, commandMsgId, chatId, threadId);
          return;
        } else {
          await sendAndDeleteInGroup('使用方法: 请回复某条消息并输入 /block 来屏蔽用户。');
          return;
        }
      } else if (command === '/checkblock') {
        if (!(await requireAdmin(message, event, commandMsgId))) return;
        if (message.reply_to_message) {
          await checkBlock(message, event, commandMsgId, chatId, threadId);
          return;
        } else {
          await sendAndDeleteInGroup('使用方法: 请回复某条消息并输入 /checkblock 来检查用户是否被屏蔽。');
          return;
        }
      } else {
        await sendAndDeleteInGroup(`未知命令: ${command}`);
        return;
      }
    }

    // 非命令消息，继续原有的转发逻辑
    let targetUserId = null;
    if (message.message_thread_id) {
      targetUserId = await nfd.get('topic_user_' + message.message_thread_id, { type: 'json' });
      if (targetUserId) {
        console.log(`[群组回复] 通过话题ID ${message.message_thread_id} 找到用户 ${targetUserId}`);
      } else {
        console.log(`[群组回复] 话题ID ${message.message_thread_id} 未找到对应用户`);
      }
    }

    if (targetUserId) {
  try {
    let originalUserMsgId = null;
    if (message.reply_to_message) {
      const repliedMsgIdInGroup = message.reply_to_message.message_id;
      const sourceInfo = await getSourceMessage(groupChatId, repliedMsgIdInGroup);
      if (sourceInfo) {
        originalUserMsgId = sourceInfo.source_message_id;
        console.log(`[引用回复] 找到原始用户消息 ID: ${originalUserMsgId}`);
      } else {
        console.warn(`[引用回复] 未找到映射，消息ID: ${repliedMsgIdInGroup}`);
      }
    }

    let sendRes;
    const mediaInfo = extractMediaFromMessage(message);

    if (message.text) {
     const sendOptions = {
        chat_id: targetUserId,
        text: message.text,
        entities: message.entities,
      };
      if (originalUserMsgId) sendOptions.reply_to_message_id = originalUserMsgId;
      sendRes = await sendMessage(sendOptions);
    } else {
      const copyOptions = {
        chat_id: targetUserId,
        from_chat_id: groupChatId,
        message_id: message.message_id,
      };
    if (originalUserMsgId) copyOptions.reply_to_message_id = originalUserMsgId;
      sendRes = await copyMessage(copyOptions);
      }

    console.log('[群组回复] 发送给用户', targetUserId, '结果:', sendRes);
    if (sendRes.ok && sendRes.result) {
      const msgType = message.text ? 'text' : (message.caption ? 'caption' : 'media');
      const mediaType = mediaInfo ? mediaInfo.type : null;
      await saveMessageMapping(chatId, message.message_id, targetUserId, sendRes.result.message_id, msgType, mediaType, !!message.reply_markup);
    } else {
      await sendMessage({
        chat_id: groupChatId,
        message_thread_id: message.message_thread_id,
        text: `❌ 发送失败: ${sendRes ? JSON.stringify(sendRes) : '未知错误'}`,
        reply_to_message_id: message.message_id
      });
    }
  } catch (err) {
    console.error('[群组回复] 发送失败:', err);
    await sendMessage({
      chat_id: groupChatId,
      message_thread_id: message.message_thread_id,
      text: `❌ 发送失败: ${err.message}`,
      reply_to_message_id: message.message_id
    });
  }
  return;
} else {
      let errorMsg = '⚠️ 无法确定要发送给哪位用户。\n\n';
      if (message.message_thread_id) {
        errorMsg += `当前话题ID: ${message.message_thread_id}\n未找到对应的用户映射。\n\n`;
      } else {
        errorMsg += '当前消息不在话题中（缺少 message_thread_id）。\n\n';
      }
      errorMsg += '请确保：\n1️⃣ 消息发送在机器人创建的话题内\n2️⃣ 话题已正确关联用户（用户曾发过消息）\n3️⃣ 如问题持续，请让用户重新发一条消息以重建映射。';
      
      const sent = await sendMessage({
        chat_id: groupChatId,
        message_thread_id: message.message_thread_id,
        text: errorMsg,
        reply_to_message_id: message.message_id
      });
      
      if (sent && sent.ok && sent.result) {
        const errorMsgId = sent.result.message_id;
        if (event && event.waitUntil) {
          event.waitUntil((async () => {
            await new Promise(resolve => setTimeout(resolve, 3000));
            try {
              await requestTelegram('deleteMessage', makeReqBody({
                chat_id: groupChatId,
                message_id: errorMsgId
              }));
              console.log(`[自动删除] 已删除错误提示消息 ${errorMsgId}`);
            } catch (e) {
              console.error('[自动删除] 删除错误提示消息失败', e);
            }
          })());
        }
      }
      return;
    }
  }

  // 以下为私聊模式的处理（包括管理员私聊和普通用户私聊）
  const command = getCommandFromMessage(message);
  const args = message.text ? message.text.slice((command||'').length).trim() : '';
  const commandMsgId = message.message_id;
  const threadId = message.message_thread_id;

  debugLog('onMessage command=', command, 'args=', args, 'from=', fromId);

  // 辅助函数：发送回复并自动删除命令和回复（引用命令消息）
  const sendAndDelete = async (replyText, extraOptions = {}) => {
    const sendOptions = {
      chat_id: chatId,
      text: replyText,
      reply_to_message_id: commandMsgId,
      ...extraOptions
    };
    if (threadId) sendOptions.message_thread_id = threadId;
    const res = await sendMessage(sendOptions);
    if (res && res.ok && res.result && event) {
      scheduleDeletion(chatId, [commandMsgId, res.result.message_id], 3000, event);
    }
    return res;
  };

  if (message.text && command) {
    if (command === '/start') {
      const userId = fromId;
      if (isAdmin(userId)) {
        const startMsg = await getStartMessage();
        await sendMessage({
          chat_id: userId,
          text: startMsg
        });
        await setVerified(userId);
        return;
      }
      if (await isVerified(userId)) {
        const startMsg = await getStartMessage();
        await sendMessage({
          chat_id: userId,
          text: startMsg
        });
        await initUserTopicIfNeeded(userId);
      } else {
        // 未验证：先处理可能的超时/过期，再发送验证
        const expiredHandled = await handleExpiredVerification(userId);
        if (!expiredHandled) {
          await sendVerify(userId);
        }
      }
      return;
    } else if (command === '/help') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      let helpMsg = "可用指令列表:\n" +
                    "/start - 启动机器人\n" +
                    "/help - 显示帮助信息\n" +
                    "/mode - 私聊/话题 模式切换 (管理员)\n" +
                    "/setgroup - 设置群组ID (管理员)\n" +
                    "/del - 删除所有临时数据 (管理员)\n" +
                    "/search - 查看指定uid用户最新昵称 (管理员)\n" +
                    "/block - 屏蔽用户 (管理员)\n" +
                    "/unblock - 解除屏蔽 (管理员)\n" +
                    "/checkblock - 检查是否被屏蔽 (管理员)\n" +
                    "/fraud - 添加骗子ID - [本地库] (管理员)\n" +
                    "/unfraud - 移除骗子ID - [本地库] (管理员)\n" +
                    "/list - 查看骗子ID列表 - [本地库] (管理员)\n" +
                    "/blocklist - 查看屏蔽用户列表 - [本地库] (管理员)\n";
      await sendAndDelete(helpMsg);
      return;
    } else if (command === '/mode') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      const newMode = args.trim().toLowerCase();
      const curMode = await getCurrentMode();
      if (newMode === '') {
        if (curMode === 'private') {
          const gid = await getGroupChatId();
          if (!gid) {
            await sendAndDelete('无法切换到群组模式：未设置群组ID。请先使用 /setgroup 设置群组ID或配置环境变量 GROUP_CHAT_ID。');
            return;
          }
          await setCurrentMode('group');
          await sendAndDelete('已切换到群组模式。所有用户消息将转发到群组话题中。');
        } else {
          await setCurrentMode('private');
          await sendAndDelete('已切换到私聊模式。所有用户消息将私聊转发给管理员。');
        }
        return;
      } else if (newMode === 'group') {
        const gid = await getGroupChatId();
        if (!gid) {
          await sendAndDelete('请先设置群组ID（环境变量 GROUP_CHAT_ID 或使用 /setgroup 命令）。');
          return;
        }
        await setCurrentMode('group');
        await sendAndDelete('已切换到群组模式。所有用户消息将转发到群组话题中。');
      } else if (newMode === 'private') {
        await setCurrentMode('private');
        await sendAndDelete('已切换到私聊模式。所有用户消息将私聊转发给管理员。');
      } else {
        await sendAndDelete(`当前模式: ${curMode}\n使用方法: /mode 或 /mode private 或 /mode group`);
      }
      return;
    } else if (command === '/setgroup') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      const newGroupId = args.trim();
      if (!newGroupId) {
        await sendAndDelete('使用方法: /setgroup 群组ID');
        return;
      }
      await setGroupChatId(newGroupId);
      await sendAndDelete(`群组ID已设置为: ${newGroupId}（持久化保存）`);
      return;
    } else if (command === '/del') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      // 先删除所有用户话题
      const topicCount = await clearAllUserTopics();
      // 再删除所有临时 KV 数据
      const kvCount = await clearTempKV();
      await sendAndDelete(`已删除 ${topicCount} 个用户话题，并清理 ${kvCount} 个临时 KV 数据。`);
      return;
    } else if (command === '/blocklist') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      await listBlockedUsers(event, commandMsgId, chatId, threadId);
      return;
    } else if (command === '/unblock') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      if (message.reply_to_message) {
        await handleUnBlock(message, event, commandMsgId, chatId, threadId);
        return;
      }
      if (args) {
        const index = parseInt(args.split(' ')[0], 10);
        if (!isNaN(index)) {
          await unblockByIndex(index, event, commandMsgId, chatId, threadId);
          return;
        } else {
          await sendAndDelete('无效的序号。');
          return;
        }
      }
      await sendAndDelete('使用方法: 请【回复某条消息并输入 /unblock 】 或 【使用 /unblock 屏蔽序号 】来解除屏蔽用户。\n 屏蔽序号可以通过 /blocklist 获取');
      return;
    } else if (command === '/list') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      const fraudList = await getLocalFraudList();
      if (fraudList.length === 0) {
        await sendAndDelete('本地没有骗子ID。');
      } else {
        const fraudListText = await Promise.all(fraudList.map(async uid => {
          const userInfo = await getUserInfo(uid);
          const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
          return `UID: ${uid}, 昵称: ${nickname}`;
        }));
        await sendAndDelete(`本地骗子ID列表:\n${fraudListText.join('\n')}`);
      }
      return;
    } else if (command === '/search') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const userInfo = await getChat(guestChatId);
          if (userInfo) {
            const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
            await sendAndDelete(`UID: ${guestChatId}, 昵称: ${nickname}`);
            return;
          } else {
            await sendAndDelete(`找不到 UID: ${guestChatId} 的详细信息`);
            return;
          }
        } else {
          await sendAndDelete('无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。');
          return;
        }
      }
      if (args) {
        const searchId = args.split(' ')[0].toString();
        const userInfo = await getChat(searchId);
        if (userInfo) {
          const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
          await sendAndDelete(`UID: ${searchId}, 昵称: ${nickname}`);
          return;
        } else {
          await sendAndDelete(`无法找到 UID: ${searchId} 的用户信息`);
          return;
        }
      } else {
        await sendAndDelete('使用方法: 请回复某条消息并输入 /search，或 /search 用户UID');
        return;
      }
    } else if (command === '/fraud') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const idStr = String(guestChatId);
          const list = await getLocalFraudList();
          if (!list.includes(idStr)) {
            await addLocalFraud(idStr);
            await sendAndDelete(`已添加骗子ID: ${idStr}`);
            return;
          } else {
            await sendAndDelete(`骗子ID ${idStr} 已存在`);
            return;
          }
        } else {
          await sendAndDelete('无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。');
          return;
        }
      }
      if (args) {
        const fraudId = args.split(' ')[0].toString();
        const list = await getLocalFraudList();
        if (!list.includes(fraudId)) {
          await addLocalFraud(fraudId);
          await sendAndDelete(`已添加骗子ID: ${fraudId}`);
          return;
        } else {
          await sendAndDelete(`骗子ID: ${fraudId} 已存在`);
          return;
        }
      } else {
        await sendAndDelete('使用方法: 请回复某条消息并输入 /fraud，或 /fraud 用户UID');
        return;
      }
    } else if (command === '/unfraud') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const idStr = String(guestChatId);
          const list = await getLocalFraudList();
          const idx = list.indexOf(idStr);
          if (idx > -1) {
            await removeLocalFraud(idStr);
            await sendAndDelete(`已移除骗子ID: ${idStr}`);
            return;
          } else {
            await sendAndDelete(`骗子ID ${idStr} 不在本地列表中`);
            return;
          }
        } else {
          await sendAndDelete('无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。');
          return;
        }
      }
      if (args) {
        const fraudId = args.split(' ')[0].toString();
        const list = await getLocalFraudList();
        const index = list.indexOf(fraudId);
        if (index > -1) {
          await removeLocalFraud(fraudId);
          await sendAndDelete(`已移除骗子ID: ${fraudId}`);
          return;
        } else {
          await sendAndDelete(`骗子ID: ${fraudId} 不在本地列表中`);
          return;
        }
      } else {
        await sendAndDelete('使用方法: 请回复某条消息并输入 /unfraud，或 /unfraud 用户UID');
        return;
      }
    } else if (command === '/block') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      if (message.reply_to_message) {
        await handleBlock(message, event, commandMsgId, chatId, threadId);
        return;
      } else {
        await sendAndDelete('使用方法: 请回复某条消息并输入 /block 来屏蔽用户。');
        return;
      }
    } else if (command === '/checkblock') {
      if (!(await requireAdmin(message, event, commandMsgId))) return;
      if (message.reply_to_message) {
        await checkBlock(message, event, commandMsgId, chatId, threadId);
        return;
      } else {
        await sendAndDelete('使用方法: 请回复某条消息并输入 /checkblock 来检查用户是否被屏蔽。');
        return;
      }
    }
  }

  // 管理员消息处理（非命令）
  if (isAdmin(fromId)) {
    if (message.reply_to_message) {
      const repliedMsgId = message.reply_to_message.message_id;
      const guestChatId = await nfd.get('msg-map-' + repliedMsgId, { type: "json" });
      console.log("guestChatId:", guestChatId);
      if (guestChatId) {
        await setCurrentChatTarget(guestChatId);
        await saveRecentChatTargets(guestChatId);
        if (message.text) {
          const sendRes = await sendMessage({
            chat_id: guestChatId,
            text: message.text,
            entities: message.entities,
          });
          if (sendRes.ok && sendRes.result) {
            const mediaInfo = extractMediaFromMessage(message);
            await saveMessageMapping(chatId, message.message_id, guestChatId, sendRes.result.message_id, 'text', null, !!message.reply_markup);
          }
        } else {
          console.log("Copying media message:", message.message_id);
          const copyRes = await copyMessage({
            chat_id: guestChatId,
            from_chat_id: chatId,
            message_id: message.message_id,
          });
          if (copyRes.ok && copyRes.result) {
            const mediaInfo = extractMediaFromMessage(message);
            const msgType = message.caption ? 'caption' : 'media';
            await saveMessageMapping(chatId, message.message_id, guestChatId, copyRes.result.message_id, msgType, mediaInfo ? mediaInfo.type : null, !!message.reply_markup);
          }
        }
        await nfd.delete('msg-map-' + repliedMsgId);
      }
    } else {
      let currentTarget = await getCurrentChatTarget();
      if (!currentTarget) {
        await savePendingMessage(message);
        const recentChatButtons = await generateRecentChatButtons();
        const sent = await sendMessage({
          chat_id: ADMIN_UID,
          text: "没有设置当前聊天目标!\n请先通过【回复某条消息】或【点击下方按钮】来设置聊天目标。",
          reply_markup: recentChatButtons.reply_markup
        });
        // 自动删除这条提示消息（3秒后），但不删除管理员发送的原始消息
        if (sent && sent.ok && sent.result && event) {
          scheduleDeletion(ADMIN_UID, sent.result.message_id, 3000, event);
        }
        return;
      }
      if (message.text) {
        const sendRes = await sendMessage({
          chat_id: currentTarget,
          text: message.text,
          entities: message.entities,
        });
        if (sendRes.ok && sendRes.result) {
          const mediaInfo = extractMediaFromMessage(message);
          await saveMessageMapping(chatId, message.message_id, currentTarget, sendRes.result.message_id, 'text', null, !!message.reply_markup);
        }
      } else {
        console.log("Copying media message:", message.message_id);
        const copyRes = await copyMessage({
          chat_id: currentTarget,
          from_chat_id: chatId,
          message_id: message.message_id,
        });
        if (copyRes.ok && copyRes.result) {
          const mediaInfo = extractMediaFromMessage(message);
          const msgType = message.caption ? 'caption' : 'media';
          await saveMessageMapping(chatId, message.message_id, currentTarget, copyRes.result.message_id, msgType, mediaInfo ? mediaInfo.type : null, !!message.reply_markup);
        }
      }
    }
    return;
  }

  // 普通访客消息处理
  return handleGuestMessage(message);
}

async function handleGuestMessage(message) {
  const userId = message.from.id;

  if (await isUserBlocked(userId)) {
    return sendMessage({
      chat_id: userId,
      text: '您已被屏蔽，无法发送消息！'
    });
  }

  if (await isVerified(userId)) {
    // 已验证
  } else {
    const lockKey = 'verify-lock-' + userId;
    const lockVal = await nfd.get(lockKey, { type: "json" });
    if (lockVal && Number(lockVal) > Date.now()) {
      const remain = Number(lockVal) - Date.now();
      const minutes = Math.floor(remain/60000);
      const seconds = Math.floor((remain%60000)/1000);
      const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendMessage({ chat_id: userId, text: `验证失败次数(含超时)已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
      return;
    }
    // 未验证且未锁定：先处理可能的超时/过期，再发送验证
    const expiredHandled = await handleExpiredVerification(userId);
    if (!expiredHandled) {
      await sendVerify(userId);
    }
    return;
  }

  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();
  if (currentMode === 'group' && groupChatId) {
    const userInfo = await getUserInfo(userId);
    const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${userId}`;
    const nicknameEsc = escapeMarkdown(nicknamePlain);
    let topicId = await ensureUserTopic(userId, nicknamePlain);
    if (!topicId) {
      console.error('无法创建话题，群组ID可能不正确或机器人无权限');
      return;
    }
    const isFirst = !(await nfd.get('topic_initialized_' + topicId));
    if (isFirst) {
      await sendAdminButtonsInTopic(topicId, userId, nicknamePlain, nicknameEsc);
      await putWithTTL('topic_initialized_' + topicId, '1');
    }
    await forwardUserMessageToTopic(userId, topicId, message);
    return;
  } else {
    const copyReq = await copyMessage({
      chat_id: ADMIN_UID,
      from_chat_id: userId,
      message_id: message.message_id
    });

    if (copyReq.ok && copyReq.result) {
      const mediaInfo = extractMediaFromMessage(message);
      const msgType = message.text ? 'text' : (message.caption ? 'caption' : 'media');
      await saveMessageMapping(userId, message.message_id, ADMIN_UID, copyReq.result.message_id, msgType, mediaInfo ? mediaInfo.type : null, !!message.reply_markup);
      await putWithTTL('msg-map-' + copyReq.result.message_id, userId);

      const currentTarget = await getCurrentChatTarget();
      if (currentTarget !== userId) {
        const userInfo = await getUserInfo(userId);
        const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${userId}`;
        const nicknameEsc = escapeMarkdown(nicknamePlain);
        let messageText = `👤: [*${nicknameEsc}*](tg://user?id=${userId})\n🆔: ${userId}`;
        if (await isFraud(userId)) {
          messageText += `\n\n⚠️ *请注意，该用户是骗子！*`;
        }
        await sendMessage({
          chat_id: ADMIN_UID,
          parse_mode: 'MarkdownV2',
          text: messageText,
          ...generateAdminCommandKeyboard(userId, nicknamePlain, 'private')
        });
      }
      await saveRecentChatTargets(userId);
    } else {
      console.error('[私聊转发] copyMessage 失败:', copyReq);
    }
    return;
  }
}

// 以下辅助函数用于处理带自动删除的管理员命令（引用命令消息）
async function handleBlock(message, event, commandMsgId, chatId, threadId) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  if (String(guestChatId) === ADMIN_UID) {
    const sendOptions = {
      chat_id: chatId,
      text: '不能屏蔽自己',
      reply_to_message_id: commandMsgId
    };
    if (threadId) sendOptions.message_thread_id = threadId;
    const sent = await sendMessage(sendOptions);
    if (sent && sent.ok && sent.result && event) {
      scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
    }
    return;
  }
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  await blockUser(guestChatId);
  const sendOptions = {
    chat_id: chatId,
    text: `用户 ${nickname} 已被屏蔽`,
    reply_to_message_id: commandMsgId
  };
  if (threadId) sendOptions.message_thread_id = threadId;
  const sent = await sendMessage(sendOptions);
  if (sent && sent.ok && sent.result && event) {
    scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
  }
}

async function handleUnBlock(message, event, commandMsgId, chatId, threadId) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  await unblockUser(guestChatId);
  const sendOptions = {
    chat_id: chatId,
    text: `用户 ${nickname} 已解除屏蔽`,
    reply_to_message_id: commandMsgId
  };
  if (threadId) sendOptions.message_thread_id = threadId;
  const sent = await sendMessage(sendOptions);
  if (sent && sent.ok && sent.result && event) {
    scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
  }
}

async function checkBlock(message, event, commandMsgId, chatId, threadId) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  const blocked = await isUserBlocked(guestChatId);
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  const sendOptions = {
    chat_id: chatId,
    text: `用户 ${nickname}${blocked ? ' 已被屏蔽' : ' 未被屏蔽'}`,
    reply_to_message_id: commandMsgId
  };
  if (threadId) sendOptions.message_thread_id = threadId;
  const sent = await sendMessage(sendOptions);
  if (sent && sent.ok && sent.result && event) {
    scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
  }
}

async function listBlockedUsers(event, commandMsgId, chatId, threadId) {
  const blockedUsers = await getBlockedUsers();
  let text;
  if (blockedUsers.length === 0) {
    text = '没有被屏蔽的用户。';
  } else {
    const blockedListText = await Promise.all(blockedUsers.map(async (uid, index) => {
      const userInfo = await getUserInfo(uid);
      const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
      return `${index + 1}. UID: ${uid}, 昵称: ${nickname}`;
    }));
    text = `被屏蔽的用户列表:\n${blockedListText.join('\n')}`;
  }
  const sendOptions = {
    chat_id: chatId,
    text: text,
    reply_to_message_id: commandMsgId
  };
  if (threadId) sendOptions.message_thread_id = threadId;
  const sent = await sendMessage(sendOptions);
  if (sent && sent.ok && sent.result && event) {
    scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
  }
}

async function unblockByIndex(index, event, commandMsgId, chatId, threadId) {
  const blockedUsers = await getBlockedUsers();
  if (index < 1 || index > blockedUsers.length) {
    const sendOptions = {
      chat_id: chatId,
      text: '无效的序号。',
      reply_to_message_id: commandMsgId
    };
    if (threadId) sendOptions.message_thread_id = threadId;
    const sent = await sendMessage(sendOptions);
    if (sent && sent.ok && sent.result && event) {
      scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
    }
    return;
  }
  const guestChatId = blockedUsers[index - 1];
  await unblockUser(guestChatId);
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  const sendOptions = {
    chat_id: chatId,
    text: `用户 ${nickname} 已解除屏蔽`,
    reply_to_message_id: commandMsgId
  };
  if (threadId) sendOptions.message_thread_id = threadId;
  const sent = await sendMessage(sendOptions);
  if (sent && sent.ok && sent.result && event) {
    scheduleDeletion(chatId, [commandMsgId, sent.result.message_id], 3000, event);
  }
}

// -------------------- 回调处理 --------------------
async function onCallbackQuery(callbackQuery, event) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  const parts = data.split('_');
  const action = parts[0];
  const rest = parts.slice(1);

  if (action === 'verify') {
    const chatId = rest[0];
    const selIdx = parseInt(rest[1], 10);
    if (String(callbackQuery.from.id) !== String(chatId)) {
      try {
        await requestTelegram('answerCallbackQuery', makeReqBody({
          callback_query_id: callbackQuery.id,
          text: '不要乱动别人的操作哟👻',
          show_alert: true
        }));
      } catch (e) {}
      return;
    }
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id
      }));
    } catch (e) {}

    const key = 'verify-' + chatId;
    const recRaw = await nfd.get(key);
    if (!recRaw) {
      await sendMessage({ chat_id: chatId, text: '验证已过期或不存在，请重试。' });
      await sendVerify(chatId);
      return;
    }
    const rec = JSON.parse(recRaw);
    if (Date.now() > rec.expires) {
      // 超时处理：调用统一的超时失败计数逻辑
      await handleExpiredVerification(chatId);
      return;
    }
    const lockKey = 'verify-lock-' + chatId;
    const lockVal = await nfd.get(lockKey, { type: "json" });
    if (lockVal && Number(lockVal) > Date.now()) {
      const remain = Number(lockVal) - Date.now();
      const minutes = Math.floor(remain/60000);
      const seconds = Math.floor((remain%60000)/1000);
      const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendMessage({ chat_id: chatId, text: `验证失败次数(含超时)已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
      return;
    }
    const attemptKey = 'verify-attempts-' + chatId;
    let attempts = await nfd.get(attemptKey, { type: "json" }) || 0;
    if (selIdx === rec.correctIndex) {
      await setVerified(chatId);
      await nfd.delete(key);
      await nfd.delete(attemptKey);
      try {
        if (rec.message_id) {
          await requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: rec.message_id }));
        }
      } catch (e) {}
      const startMsg = await getStartMessage();
      await sendMessage({
        chat_id: chatId,
        text: startMsg
      });
      await initUserTopicIfNeeded(chatId);
      return;
    } else {
      attempts = Number(attempts) + 1;
      await putWithTTL(attemptKey, JSON.stringify(attempts));
      if (attempts >= 3) {
        const until = await lockUser(chatId);
        await deleteOldVerifyMsg(chatId);
        await nfd.delete(attemptKey);
        const remainMs = until - Date.now();
        const minutes = Math.floor(remainMs/60000);
        const seconds = Math.floor((remainMs%60000)/1000);
        const bj = new Date(until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        await sendMessage({
          chat_id: chatId,
          text: `验证失败次数(含超时)已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试`
        });
        return;
      } else {
        await deleteOldVerifyMsg(chatId);
        await sendVerify(chatId);
        return;
      }
    }
  }

  // 非 verify 回调，检查管理员权限
  if (!isAdmin(callbackQuery.from && callbackQuery.from.id)) {
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id,
        text: '仅限管理员使用该按钮。',
        show_alert: true
      }));
    } catch (e) {
      console.error('answerCallbackQuery 失败', e);
    }
    return;
  }

  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();
  const isGroupMode = (currentMode === 'group' && groupChatId && String(message.chat.id) === String(groupChatId));
  const targetChatId = isGroupMode ? message.chat.id : ADMIN_UID;
  const targetThreadId = isGroupMode ? message.message_thread_id : undefined;

  const parts2 = data.split('_');
  const action2 = parts2[0];
  const uid = parts2.slice(1).join('_');
  let answered = false;

  try {
    switch (action2) {
      case 'select': {
        const selectedChatId = uid;
        const userInfo = await getUserInfo(selectedChatId);
        const namePlain = userInfo ? `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim() : `UID:${selectedChatId}`;
        const currentTarget = await getCurrentChatTarget();
        if (currentTarget !== selectedChatId) {
          await setCurrentChatTarget(selectedChatId);
          await saveRecentChatTargets(selectedChatId);
          chatSessions[ADMIN_UID] = { target: selectedChatId, timestamp: Date.now() };
          await saveChatSession();
          const confirmationText = `已选择当前聊天目标：${namePlain} (${selectedChatId})`;
          const sendOpts = { chat_id: targetChatId, text: confirmationText };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          if (message && message.message_id) sendOpts.reply_to_message_id = message.message_id;
          await sendMessage(sendOpts);
        } else {
          const confirmationText = `已选择当前聊天目标：${namePlain} (${selectedChatId})`;
          const sendOpts = { chat_id: targetChatId, text: confirmationText };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          if (message && message.message_id) sendOpts.reply_to_message_id = message.message_id;
          await sendMessage(sendOpts);
        }

        // 处理待转发消息
        const pending = await consumePendingMessage();
        if (pending) {
          let forwardSuccess = false;
          let errorMsg = '';
          try {
            const copyRes = await copyMessage({
              chat_id: selectedChatId,
              from_chat_id: pending.chat_id,
              message_id: pending.message_id
            });
            if (copyRes.ok && copyRes.result) {
              const msgType = pending.text ? 'text' : (pending.hasMedia ? 'media' : 'unknown');
              await saveMessageMapping(ADMIN_UID, pending.message_id, selectedChatId, copyRes.result.message_id, msgType, null, false);
              forwardSuccess = true;
            } else {
              errorMsg = `copyMessage 失败: ${JSON.stringify(copyRes)}`;
              console.error('[转发待发消息]', errorMsg);
              if (pending.text && !pending.hasMedia) {
                const sendRes = await sendMessage({ chat_id: selectedChatId, text: pending.text });
                if (sendRes.ok && sendRes.result) {
                  await saveMessageMapping(ADMIN_UID, pending.message_id, selectedChatId, sendRes.result.message_id, 'text', null, false);
                  forwardSuccess = true;
                } else {
                  errorMsg = `sendMessage 也失败: ${JSON.stringify(sendRes)}`;
                }
              }
            }
          } catch (err) {
            errorMsg = `异常: ${err.message}`;
            console.error('[转发待发消息]', err);
          }
          const resultText = forwardSuccess
            ? "✅ 消息已成功转发给目标用户。"
            : `❌ 消息转发失败，请手动重新发送。\n原因: ${errorMsg}`;
          await sendMessage({
            chat_id: ADMIN_UID,
            text: resultText,
            reply_to_message_id: pending.message_id
          });
        }
        break;
      }
      case 'search': {
        const searchId = uid;
        const userInfo = await getChat(searchId);
        let text;
        if (userInfo) {
          const nickname = `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim();
          text = `UID: ${searchId}, 昵称: ${nickname}`;
        } else {
          text = `无法找到 UID: ${searchId} 的用户信息`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'block': {
        const guestChatId = uid;
        if (String(guestChatId) === ADMIN_UID) {
          await sendMessage({ chat_id: targetChatId, text: '不能屏蔽自己', ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
          break;
        }
        const userInfo = await getUserInfo(guestChatId);
        const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await blockUser(guestChatId);
        const sendOpts = { chat_id: targetChatId, text: `用户 ${nickname} 已被屏蔽` };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'unblock': {
        const guestChatId = uid;
        const userInfo = await getUserInfo(guestChatId);
        const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await unblockUser(guestChatId);
        const sendOpts = { chat_id: targetChatId, text: `用户 ${nickname} 已解除屏蔽` };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'checkblock': {
        const guestChatId = uid;
        const blocked = await isUserBlocked(guestChatId);
        const userInfo = await getUserInfo(guestChatId);
        const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
        const sendOpts = { chat_id: targetChatId, text: `用户 ${nickname}${blocked ? ' 已被屏蔽' : ' 未被屏蔽'}` };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'fraud': {
        const fraudId = uid;
        const list = await getLocalFraudList();
        if (!list.includes(String(fraudId))) {
          await addLocalFraud(fraudId);
          await sendMessage({ chat_id: targetChatId, text: `已添加骗子ID: ${fraudId}`, ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
        } else {
          await sendMessage({ chat_id: targetChatId, text: `骗子ID ${fraudId} 已存在`, ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
        }
        break;
      }
      case 'unfraud': {
        const fraudId = uid;
        const list = await getLocalFraudList();
        const idx = list.indexOf(String(fraudId));
        if (idx > -1) {
          await removeLocalFraud(fraudId);
          await sendMessage({ chat_id: targetChatId, text: `已移除骗子ID: ${fraudId}`, ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
        } else {
          await sendMessage({ chat_id: targetChatId, text: `骗子ID ${fraudId} 不在本地列表中`, ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
        }
        break;
      }
      case 'list': {
        const frauds = await getLocalFraudList();
        let text;
        if (frauds.length === 0) {
          text = '本地没有骗子ID。';
        } else {
          const fraudListText = await Promise.all(frauds.map(async uid => {
            const userInfo = await getUserInfo(uid);
            const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
            return `UID: ${uid}, 昵称: ${nickname}`;
          }));
          text = `本地骗子ID列表:\n${fraudListText.join('\n')}`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'blocklist': {
        const blockedUsers = await getBlockedUsers();
        let text;
        if (blockedUsers.length === 0) {
          text = '没有被屏蔽的用户。';
        } else {
          const blockedListText = await Promise.all(blockedUsers.map(async (uid, index) => {
            const userInfo = await getUserInfo(uid);
            const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
            return `${index + 1}. UID: ${uid}, 昵称: ${nickname}`;
          }));
          text = `被屏蔽的用户列表:\n${blockedListText.join('\n')}`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'end': {
        const targetUid = uid;
        const chatId = message.chat.id;
        const topicId = message.message_thread_id;

        if (!topicId) {
          await sendMessage({
            chat_id: chatId,
            text: '无法获取话题 ID，请确认消息是否位于话题中。'
          });
          break;
        }

        const delRes = await requestTelegram('deleteForumTopic', makeReqBody({
          chat_id: chatId,
          message_thread_id: topicId
        }));

        if (delRes.ok) {
          await nfd.delete('user_topic_' + targetUid);
          await nfd.delete('topic_user_' + topicId);
          await nfd.delete('topic_initialized_' + topicId);
          await nfd.delete('verified-' + targetUid);
          await nfd.delete('verify-attempts-' + targetUid);
          await nfd.delete('verify-lock-' + targetUid);
          try {
            await requestTelegram('deleteMessage', makeReqBody({
              chat_id: chatId,
              message_id: message.message_id
            }));
          } catch (e) {
            console.warn('[deleteMessage] 删除原消息失败', e);
          }
        } else {
          await sendMessage({
            chat_id: chatId,
            text: `删除话题失败: ${JSON.stringify(delRes)}`
          });
        }
        break;
      }
      case 'cancel': {
        try {
          const namePlain = await getDisplayName(uid, false);
          if (message && message.chat && message.message_id) {
            try {
              await requestTelegram('deleteMessage', makeReqBody({
                chat_id: message.chat.id,
                message_id: message.message_id
              }));
            } catch (e) {
              console.warn('[onCallbackQuery][cancel] deleteMessage failed, will continue', e);
            }
          }
          await consumePendingMessage();
          let text;
          const currentTarget = await getCurrentChatTarget();
          if (currentTarget && String(currentTarget) === String(uid)) {
            await nfd.delete('currentChatTarget');
            text = `已取消当前聊天目标：${namePlain}${uid}`;
          } else {
            text = `已取消选择：${namePlain}${uid}，当前聊天目标保持不变。`;
          }
          const sendOpts = { chat_id: targetChatId, text };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          await sendMessage(sendOpts);
        } catch (e) {
          console.error('[onCallbackQuery][cancel] overall failed', e);
          await consumePendingMessage();
          const sendOpts = { chat_id: targetChatId, text: `已取消操作（UID: ${uid}）。` };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          await sendMessage(sendOpts);
        }
        break;
      }
      default:
        await sendMessage({ chat_id: targetChatId, text: `未知操作: ${action2}`, ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
        break;
    }
  } catch (err) {
    console.error('[onCallbackQuery] handler error', err);
    const sendOpts = { chat_id: targetChatId, text: `处理回调出错: ${err && err.message ? err.message : err}` };
    if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
    await sendMessage(sendOpts);
  }

  if (!answered) {
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id
      }));
    } catch (e) {
      console.warn('[onCallbackQuery] final answerCallbackQuery failed', e);
    }
  }
}
