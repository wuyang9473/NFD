// ================= 环境变量 =================
const TOKEN = globalThis.BOT_TOKEN;                             // 机器人的 Telegram Bot API Token（必需）
const SECRET = globalThis.BOT_SECRET;                           // Webhook 验证用的 Secret Token（可选，用于保障请求安全性）
const ADMIN_UID = String(globalThis.ADMIN_UID || '');           // 管理员用户的 Telegram ID（字符串形式，用于权限判断）
const DEFAULT_GROUP_CHAT_ID = globalThis.GROUP_CHAT_ID || null; // 默认的群组 ID（若未在 KV 中设置，则使用此值，可为 null）

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
const WEBHOOK = '/endpoint'         // Webhook 接收路径
const chatSessions = {};            // 内存中存储的聊天会话（按 chatId 索引）
const fraudDb = 'https://raw.githubusercontent.com/wuyangdaily/nfd/main/data/fraud.db';            // 远程骗子库数据源 URL
const startMsgUrl = 'https://raw.githubusercontent.com/wuyangdaily/nfd/main/data/startMessage.md'; // 启动消息模板远程 URL
const DEFAULT_TTL = 7 * 24 * 3600;  // 7天 默认过期时间
const PENDING_MSG_TTL = 300;        // 5分钟 待转发消息过期时间
const CURRENT_TARGET_TTL = 1800;    // 30分钟 当前聊天目标过期时间
const FRAUD_CACHE_TTL = 3600;       // 1小时 骗子库更新间隔
const START_MSG_CACHE_TTL = 3600;   // 1小时 启动消息更新间隔
const VERIFY_TIMEOUT_SECONDS = 5;   // 5秒 验证超时时间
const VERIFY_MAX_ATTEMPTS = 3;      // 验证失败次数（含超时）
const VERIFY_LOCK_HOURS = 1;        // 锁定小时数
const VERIFIED_TTL_DAYS = 1;        // 验证有效期（天）
const AUTO_DELETE_DELAY_MS = 3000;  // 消息自动删除延迟（毫秒）
const VERIFY_OPTIONS_COUNT = 5;     // 验证选项个数（含正确项）
const MAX_RECENT_TARGETS = 5;       // 最近聊天目标最大保留数
const DISPLAY_NAME_CACHE_MAX = 200; // 显示名称缓存最大条目数

console.log(`[初始化] 环境变量已读取: ADMIN_UID=${ADMIN_UID}, GROUP_CHAT_ID=${DEFAULT_GROUP_CHAT_ID}`);

// ================= 内存缓存 =================
const displayNameCache = new Map();

// 持久化 KV 键名
const GROUP_CHAT_ID_KV_KEY = 'group_chat_id';                    // KV 中存储群组 ID 的键名
const MODE_KV_KEY = 'mode';                                      // KV 中存储当前模式（private/group）的键名
const BLOCKED_USERS_KV_KEY = 'blockedUsers';                     // KV 中存储被屏蔽用户列表的键名
const FRAUD_LIST_KV_KEY = 'localFraudList';                      // KV 中存储本地骗子 ID 列表的键名
const FRAUD_CACHE_KV_KEY = 'cached_fraud_db';                    // KV 中缓存远程骗子库数据的键名
const FRAUD_CACHE_TIME_KV_KEY = 'cached_fraud_db_time';          // KV 中存储骗子库缓存更新时间的键名（北京时间字符串）
const START_MSG_CACHE_KV_KEY = 'cached_start_message';           // KV 中缓存启动消息内容的键名
const START_MSG_CACHE_TIME_KV_KEY = 'cached_start_message_time'; // KV 中存储启动消息缓存更新时间的键名（北京时间字符串）

// -------------------- KV 辅助函数 --------------------
async function getJson(key) {
  try {
    return await nfd.get(key, { type: 'json' });
  } catch (e) {
    console.error(`[getJson] 读取键 ${key} 失败:`, e);
    return null;
  }
}

async function setJson(key, value, options = {}) {
  if (value === undefined || value === null) {
    console.warn(`[setJson] 尝试存储空值，跳过键 ${key}`);
    return;
  }
  if (!isPermanentKey(key) && !options.expirationTtl) {
    options.expirationTtl = DEFAULT_TTL;
  }
  try {
    await nfd.put(key, JSON.stringify(value), options);
  } catch (e) {
    console.error(`[setJson] 存储键 ${key} 失败:`, e);
  }
}

async function deleteKey(key) {
  try {
    await nfd.delete(key);
  } catch (e) {
    console.warn(`[deleteKey] 删除键 ${key} 失败:`, e);
  }
}

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
        await deleteKey(key.name);
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
  const trimmed = message.text.trimStart();
  if (trimmed.length === 0 || trimmed[0] !== '/') return null;
  const match = trimmed.match(/^\/(\w+)(?:@\w+)?/);
  return match ? '/' + match[1] : null;
}

// -------------------- 消息类型辅助 --------------------
function getMessageType(message) {
  if (message.text) return 'text';
  if (message.caption) return 'caption';
  return 'media';
}

// -------------------- 自动删除辅助函数 --------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scheduleDeletion(chatId, messageIds, delay = AUTO_DELETE_DELAY_MS, event = null) {
  if (!event) return;
  event.waitUntil((async () => {
    await sleep(delay);
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    for (const msgId of ids) {
      if (!msgId) continue;
      try {
        await deleteTelegramMessage(chatId, msgId);
      } catch (e) {
        console.warn(`[自动删除] 删除消息 ${msgId} 失败:`, e);
      }
    }
  })());
}

// 安全删除消息
async function safeDeleteMessage(chatId, messageId) {
  try {
    await deleteTelegramMessage(chatId, messageId);
  } catch (e) {
    console.warn(`[safeDeleteMessage] 删除消息 ${messageId} 失败:`, e);
  }
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
    headers:{ 'content-type':'application/json' },
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

// 发送消息到指定 chat，自动合并 extra 参数
async function sendToTarget(chatId, text, extra = {}) {
  return await sendMessage({ chat_id: chatId, text, ...extra });
}

// 发送消息到指定 chat 并指定话题 ID（如果有），自动合并 extra
async function sendToTargetWithThread(chatId, text, threadId, extra = {}) {
  if (threadId) {
    extra.message_thread_id = threadId;
  }
  return sendToTarget(chatId, text, extra);
}

// 发送消息并自动删除被回复消息和自身（3秒后）
async function replyAndDelete(chatId, text, replyToMsgId, threadId, event, extraOptions = {}) {
  const res = await sendToTarget(chatId, text, {
    reply_to_message_id: replyToMsgId,
    message_thread_id: threadId,
    ...extraOptions
  });
  if (res && res.ok && res.result && event) {
    scheduleDeletion(chatId, [replyToMsgId, res.result.message_id], AUTO_DELETE_DELAY_MS, event);
  }
  return res;
}

function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
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

// ---------- 封装删除消息 ----------
async function deleteTelegramMessage(chatId, messageId) {
  return requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: messageId }));
}

// ---------- 封装 answerCallbackQuery ----------
async function answerCallbackQuery(queryId, text = null, showAlert = false) {
  const body = { callback_query_id: queryId };
  if (text) { body.text = text; body.show_alert = showAlert; }
  return requestTelegram('answerCallbackQuery', makeReqBody(body));
}

// 辅助函数：从消息中提取媒体信息
function extractMediaFromMessage(msg) {
  if (msg.photo) {
    const largest = msg.photo.reduce((a, b) => (a.file_size > b.file_size ? a : b), msg.photo[0]);
    return { type: 'photo', file_id: largest.file_id };
  }
  if (msg.video) return { type: 'video', file_id: msg.video.file_id };
  if (msg.animation) return { type: 'animation', file_id: msg.animation.file_id };
  if (msg.audio) return { type: 'audio', file_id: msg.audio.file_id };
  if (msg.document) return { type: 'document', file_id: msg.document.file_id };
  if (msg.sticker) return { type: 'sticker', file_id: msg.sticker.file_id };
  if (msg.voice) return { type: 'voice', file_id: msg.voice.file_id };
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
  await setJson(key, data);
  const reverseKey = `msg_map_rev_${targetChatId}_${targetMsgId}`;
  await setJson(reverseKey, { source_chat_id: sourceChatId, source_message_id: sourceMsgId, type: msgType, media_type: mediaType });
  console.log(`[映射保存] ${sourceChatId}:${sourceMsgId} -> ${targetChatId}:${targetMsgId} (type: ${msgType}, media: ${mediaType})`);
}

async function getTargetMessage(sourceChatId, sourceMsgId) {
  const key = `msg_map_${sourceChatId}_${sourceMsgId}`;
  const data = await getJson(key);
  console.log(`[映射查询] ${sourceChatId}:${sourceMsgId} -> ${data ? JSON.stringify(data) : 'null'}`);
  return data;
}

async function getSourceMessage(targetChatId, targetMsgId) {
  const key = `msg_map_rev_${targetChatId}_${targetMsgId}`;
  return await getJson(key);
}

// -------------------- 辅助：映射 guest ID 到消息 --------------------
async function saveGuestIdMapping(targetMsgId, userId) {
  await setJson('msg-map-' + targetMsgId, userId);
}

async function getGuestIdFromReply(replyMsgId) {
  return await getJson('msg-map-' + replyMsgId);
}

// -------------------- KV 存储操作 --------------------
async function saveChatSession() {
  await setJson('chatSessions', chatSessions);
}

async function loadChatSession() {
  const storedSessions = await getJson('chatSessions');
  if (storedSessions) {
    Object.assign(chatSessions, storedSessions);
  }
}

async function generateRecentChatButtons() {
  const recentChatTargets = await getRecentChatTargets();
  const buttons = await Promise.all(recentChatTargets.map(async chatId => {
    const nickname = await getDisplayName(chatId, false);
    return {
      text: `发给：${nickname}`,
      callback_data: `select_${chatId}`
    };
  }));
  return generateKeyboard(buttons);
}

// 屏蔽列表操作
async function isUserBlocked(userId) {
  const blockedList = await getJson(BLOCKED_USERS_KV_KEY) || [];
  return blockedList.includes(String(userId));
}

async function blockUser(userId) {
  let blockedList = await getJson(BLOCKED_USERS_KV_KEY) || [];
  if (!blockedList.includes(String(userId))) {
    blockedList.push(String(userId));
    await setJson(BLOCKED_USERS_KV_KEY, blockedList);
  }
}

async function unblockUser(userId) {
  let blockedList = await getJson(BLOCKED_USERS_KV_KEY) || [];
  const idx = blockedList.indexOf(String(userId));
  if (idx !== -1) {
    blockedList.splice(idx, 1);
    await setJson(BLOCKED_USERS_KV_KEY, blockedList);
  }
}

async function getBlockedUsers() {
  return await getJson(BLOCKED_USERS_KV_KEY) || [];
}

// 本地骗子列表操作
async function getLocalFraudList() {
  return await getJson(FRAUD_LIST_KV_KEY) || [];
}

async function addLocalFraud(userId) {
  let list = await getLocalFraudList();
  if (!list.includes(String(userId))) {
    list.push(String(userId));
    await setJson(FRAUD_LIST_KV_KEY, list);
  }
}

async function removeLocalFraud(userId) {
  let list = await getLocalFraudList();
  const idx = list.indexOf(String(userId));
  if (idx !== -1) {
    list.splice(idx, 1);
    await setJson(FRAUD_LIST_KV_KEY, list);
  }
}

// ---------- 获取当前北京时间字符串 ----------
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

// 通用缓存更新函数
async function fetchAndCache(cacheKey, cacheTimeKey, fetchFn, ttl) {
  const now = Date.now();
  let lastUpdateStr = await nfd.get(cacheTimeKey);
  let cachedData = await nfd.get(cacheKey);
  
  let lastUpdate = null;
  if (lastUpdateStr) {
    lastUpdate = beijingStringToTimestamp(lastUpdateStr);
    if (isNaN(lastUpdate)) lastUpdate = null;
  }
  
  let needUpdate = false;
  if (!cachedData) {
    needUpdate = true;
  } else if (!lastUpdate || (now - lastUpdate) > ttl * 1000) {
    needUpdate = true;
  }
  
  if (needUpdate) {
    console.log(`[fetchAndCache] 需要更新 ${cacheKey}，开始拉取远程数据...`);
    try {
      const data = await fetchFn();
      await nfd.put(cacheKey, data);
      const beijingTimeStr = getBeijingTimeString();
      await nfd.put(cacheTimeKey, beijingTimeStr);
      console.log(`[fetchAndCache] 已更新 ${cacheKey}，更新时间: ${beijingTimeStr}`);
      return data;
    } catch (err) {
      console.error(`[fetchAndCache] 拉取失败，使用旧缓存`, err);
      if (cachedData) return cachedData;
      throw err;
    }
  }
  
  console.log(`[fetchAndCache] 使用缓存中的 ${cacheKey}`);
  return cachedData;
}

// 远程骗子库缓存
async function getFraudSet() {
  const data = await fetchAndCache(
    FRAUD_CACHE_KV_KEY,
    FRAUD_CACHE_TIME_KV_KEY,
    async () => {
      const response = await fetch(fraudDb);
      const text = await response.text();
      const lines = text.split('\n').filter(v => v.trim().length > 0);
      return JSON.stringify(lines);
    },
    FRAUD_CACHE_TTL
  );
  return new Set(JSON.parse(data));
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
  return await fetchAndCache(
    START_MSG_CACHE_KV_KEY,
    START_MSG_CACHE_TIME_KV_KEY,
    async () => {
      const response = await fetch(startMsgUrl);
      return await response.text();
    },
    START_MSG_CACHE_TTL
  );
}

async function saveRecentChatTargets(chatId) {
  let recentChatTargets = await getJson('recentChatTargets') || [];
  recentChatTargets = recentChatTargets.filter(id => id !== chatId.toString());
  recentChatTargets.unshift(chatId.toString());
  if (recentChatTargets.length > MAX_RECENT_TARGETS) {
    recentChatTargets.pop();
  }
  await setJson('recentChatTargets', recentChatTargets);
}

async function getRecentChatTargets() {
  return (await getJson('recentChatTargets') || []).map(id => id.toString());
}

// 当前聊天目标
async function getCurrentChatTarget() {
  const data = await getJson('currentChatTarget');
  return data ? data.target : null;
}

async function setCurrentChatTarget(target) {
  await setJson('currentChatTarget', { target }, { expirationTtl: CURRENT_TARGET_TTL });
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
  await setJson(key, data, { expirationTtl: PENDING_MSG_TTL });
}

async function consumePendingMessage() {
  const key = `pending_msg_${ADMIN_UID}`;
  const data = await getJson(key);
  if (data) {
    await deleteKey(key);
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
  await nfd.put(MODE_KV_KEY, mode);
}

async function getGroupChatId() {
  let gid = DEFAULT_GROUP_CHAT_ID;
  if (!gid) {
    gid = await nfd.get(GROUP_CHAT_ID_KV_KEY);
  }
  return gid || null;
}

async function setGroupChatId(gid) {
  await nfd.put(GROUP_CHAT_ID_KV_KEY, gid);
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
  let topicId = await getJson('user_topic_' + userId);
  if (!topicId && groupChatId) {
    topicId = await createForumTopic(groupChatId, displayName, userId);
    if (topicId) {
      await setJson('user_topic_' + userId, topicId);
      await setJson('topic_user_' + topicId, userId);
    }
  }
  return topicId;
}

// ---------- 统一发送管理员操作界面（支持私聊和群组话题） ----------
async function sendAdminInterface(userId, targetChatId, threadId, mode) {
  const nicknamePlain = await getDisplayName(userId, false);
  const nicknameEsc = escapeMarkdown(nicknamePlain);
  let text = `👤：[*${nicknameEsc}*](tg://user?id=${userId})\n🆔：${userId}`;
  if (await isFraud(userId)) {
    text += `\n\n⚠️ *请注意，该用户是骗子！*`;
  }
  const extra = {
    parse_mode: 'MarkdownV2',
    ...generateAdminCommandKeyboard(userId, nicknamePlain, mode)
  };
  if (threadId) extra.message_thread_id = threadId;
  await sendToTarget(targetChatId, text, extra);
}

// ---------- 在话题中发送管理按钮（兼容旧调用） ----------
async function sendAdminButtonsInTopic(topicId, userId) {
  const groupChatId = await getGroupChatId();
  if (!groupChatId) return;
  await sendAdminInterface(userId, groupChatId, topicId, 'group');
}

async function forwardUserMessageToTopic(userId, topicId, message) {
  const groupChatId = await getGroupChatId();
  if (!groupChatId) {
    console.error('[转发] 未设置群组ID');
    return;
  }
  const result = await forwardMessageToChat(message, groupChatId, null, { message_thread_id: topicId });
  if (!result.ok) {
    console.error('[转发] 复制消息失败:', result.error);
  }
  return result;
}

async function initUserTopicIfNeeded(userId) {
  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();
  if (currentMode !== 'group' || !groupChatId) return;

  let topicId = await getJson('user_topic_' + userId);
  if (topicId) {
    const isInitialized = await nfd.get('topic_initialized_' + topicId);
    if (isInitialized) return;
  }

  const nicknamePlain = await getDisplayName(userId, false);
  topicId = await ensureUserTopic(userId, nicknamePlain);
  if (topicId) {
    await sendAdminButtonsInTopic(topicId, userId);
    await nfd.put('topic_initialized_' + topicId, '1');
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
    const v = await getJson(key);
    if (v && v.message_id) {
      await safeDeleteMessage(chatId, v.message_id);
    }
    await deleteKey(key);
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

// ---------- 发送锁定提示 ----------
async function sendLockMessage(userId, until) {
  const remainMs = until - Date.now();
  const minutes = Math.floor(remainMs / 60000);
  const seconds = Math.floor((remainMs % 60000) / 1000);
  const bj = new Date(until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  await sendToTarget(userId, `验证失败次数(含超时)已达到 ${VERIFY_MAX_ATTEMPTS} 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试`);
}

// ---------- 检查是否被锁定 ----------
async function isVerifyLocked(userId) {
  const lockVal = await getJson('verify-lock-' + userId);
  if (lockVal && Number(lockVal) > Date.now()) {
    await sendLockMessage(userId, Number(lockVal));
    return true;
  }
  return false;
}

// 处理验证超时并累计失败次数
async function handleExpiredVerification(userId) {
  if (await isVerifyLocked(userId)) return true;

  const key = 'verify-' + userId;
  const recRaw = await nfd.get(key);
  if (!recRaw) return false;
  
  const rec = JSON.parse(recRaw);
  if (Date.now() <= rec.expires) return false;
  
  const attemptKey = 'verify-attempts-' + userId;
  let attempts = await getJson(attemptKey) || 0;
  attempts++;
  await setJson(attemptKey, attempts);
  
  await deleteOldVerifyMsg(userId);
  
  if (attempts >= VERIFY_MAX_ATTEMPTS) {
    const until = await lockUser(userId);
    await deleteKey(attemptKey);
    await sendLockMessage(userId, until);
    return true;
  } else {
    await sendToTarget(userId, '验证已超时，请重新验证。');
    await sendVerify(userId);
    return true;
  }
}

async function sendVerify(chatId) {
  if (await isVerifyLocked(chatId)) return;

  await deleteOldVerifyMsg(chatId);

  const q = createMathQuestion();
  const correct = q.value;
  const options = new Set();
  options.add(String(correct));
  while (options.size < VERIFY_OPTIONS_COUNT) {
    const delta = randInt(-5, 5);
    let candidate = correct + delta;
    if (candidate <= 0) candidate = randInt(1, 10);
    if (candidate === correct) candidate += randInt(1, 3);
    options.add(String(candidate));
  }
  
  const optsArr = Array.from(options);
  shuffleArray(optsArr);
  const correctIndex = optsArr.findIndex(x => String(x) === String(correct));

  const btns = optsArr.map((t, idx) => ({
    text: t,
    callback_data: `verify_${chatId}_${idx}`
  }));

  const text = `请先通过验证（${VERIFY_TIMEOUT_SECONDS} 秒内回答）:\n${q.expr} = ?\n（错误或超时${VERIFY_MAX_ATTEMPTS}次将被锁定${VERIFY_LOCK_HOURS}小时）`;

  const sent = await sendToTarget(chatId, text, oneLineKeyboardForOptions(chatId, btns));

  const key = 'verify-' + chatId;
  const rec = {
    expr: q.expr,
    correct: String(correct),
    options: optsArr,
    correctIndex,
    message_id: sent && sent.result ? sent.result.message_id : (sent && sent.message_id) || null,
    expires: Date.now() + VERIFY_TIMEOUT_SECONDS * 1000
  };
  await setJson(key, rec);
}

async function lockUser(chatId) {
  const lockKey = 'verify-lock-' + chatId;
  const until = Date.now() + VERIFY_LOCK_HOURS * 60 * 60 * 1000;
  await setJson(lockKey, until, { expirationTtl: VERIFY_LOCK_HOURS * 3600 });
  return until;
}

// ================= 验证流程封装 =================
async function ensureVerifiedOrPrompt(userId) {
  if (await isVerified(userId)) return true;
  if (await isVerifyLocked(userId)) return false;
  const expiredHandled = await handleExpiredVerification(userId);
  if (!expiredHandled) await sendVerify(userId);
  return false;
}

// ================= 清理用户话题映射并删除实际话题 =================
async function clearUserTopicMapping(userId) {
  try {
    const groupChatId = await getGroupChatId();
    const topicId = await getJson('user_topic_' + userId);
    if (topicId) {
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
      await deleteKey('user_topic_' + userId);
      await deleteKey('topic_user_' + topicId);
      await deleteKey('topic_initialized_' + topicId);
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

// ================= isVerified：验证有效期 =================
async function isVerified(chatId) {
  const key = 'verified-' + chatId;
  const v = await getJson(key);
  if (!v) return false;
  const ts = Number(v);
  if (!ts) return false;
  if (Date.now() - ts < VERIFIED_TTL_DAYS * 24 * 3600 * 1000) return true;
  await deleteKey(key);
  return false;
}

async function setVerified(chatId) {
  await setJson('verified-' + chatId, Date.now(), { expirationTtl: VERIFIED_TTL_DAYS * 24 * 3600 });
}

// -------------------- 管理端点 --------------------
async function setBotCommands() {
  try {
    const commands = [
      { command: 'start', description: '启动机器人' },
      { command: 'help', description: '显示帮助信息 (管理员)' },
      { command: 'mode', description: '私聊/话题 模式切换 (管理员)' },
      { command: 'setgroup', description: '设置群组ID (管理员)' },
      { command: 'del', description: '删除临时数据 (管理员)' },
      { command: 'search', description: '查看用户昵称 (管理员)' },
      { command: 'block', description: '屏蔽用户 (管理员)' },
      { command: 'unblock', description: '解除屏蔽 (管理员)' },
      { command: 'checkblock', description: '检查屏蔽状态 (管理员)' },
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
  try {
    if (update.message) {
      await onMessage(update.message, event);
    } else if (update.edited_message) {
      await onEditedMessage(update.edited_message, event);
    } else if (update.callback_query) {
      await onCallbackQuery(update.callback_query, event);
    }
  } catch (err) {
    console.error('[onUpdate] 未捕获的异常:', err);
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

// 获取用户显示名称
async function getDisplayName(uid, forMarkdownV2 = false) {
  const cacheKey = `${uid}_${forMarkdownV2}`;
  if (displayNameCache.has(cacheKey)) {
    return displayNameCache.get(cacheKey);
  }

  try {
    const userInfo = await getUserInfo(uid);
    let name;
    if (userInfo) {
      name = `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim();
      if (!name) name = `UID:${uid}`;
    } else {
      name = `UID:${uid}`;
    }
    const result = forMarkdownV2 ? escapeMarkdown(name) : name;

    if (displayNameCache.size >= DISPLAY_NAME_CACHE_MAX) {
      const firstKey = displayNameCache.keys().next().value;
      if (firstKey) displayNameCache.delete(firstKey);
    }
    displayNameCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.warn('[getDisplayName] failed for', uid, e);
    const fallback = forMarkdownV2 ? escapeMarkdown(`UID:${uid}`) : `UID:${uid}`;
    if (displayNameCache.size < DISPLAY_NAME_CACHE_MAX) {
      displayNameCache.set(cacheKey, fallback);
    }
    return fallback;
  }
}

// ---------- 格式化用户列表（HTML） ----------
async function formatUserListHTML(userIds, title) {
  if (userIds.length === 0) return `${title}: 无`;
  const items = await Promise.all(userIds.map(async (uid, index) => {
    let nickname = await getDisplayName(uid, false);
    if (nickname === `UID:${uid}`) {
      nickname = '未命名';
    }
    const nicknameHtml = nickname.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${index + 1}.昵称：<a href="tg://user?id=${uid}">${nicknameHtml}</a>,UID：${uid}`;
  }));
  return `${title}:\n${items.join('\n')}`;
}

// 发送用户列表（自动 HTML）
async function sendUserList(chatId, userIds, title, extra = {}) {
  const text = await formatUserListHTML(userIds, title);
  return sendToTarget(chatId, text, { ...extra, parse_mode: 'HTML' });
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
    scheduleDeletion(chatTarget, [commandMsgId, res.result.message_id], AUTO_DELETE_DELAY_MS, event);
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
          scheduleDeletion(senderId, [commandMsgId, fallbackRes.result.message_id], AUTO_DELETE_DELAY_MS, event);
        }
      } catch (e2) {
        console.error('[requireAdmin] fallback sendMessage failed', e2);
      }
    }
  }

  return false;
}

// ================= 命令处理函数 =================
async function handleHelpCommand(message, event, args, chatId, threadId, commandMsgId) {
  let helpMsg = "可用指令列表:\n" +
                "/start - 启动机器人\n" +
                "/help - 显示帮助信息 (管理员)\n" +
                "/mode - 私聊/话题 模式切换 (管理员)\n" +
                "/setgroup - 设置群组ID (管理员)\n" +
                "/del - 删除临时数据 (管理员)\n" +
                "/search - 查看用户昵称 (管理员)\n" +
                "/block - 屏蔽用户 (管理员)\n" +
                "/unblock - 解除屏蔽 (管理员)\n" +
                "/checkblock - 检查屏蔽状态 (管理员)\n" +
                "/fraud - 添加骗子ID - [本地库] (管理员)\n" +
                "/unfraud - 移除骗子ID - [本地库] (管理员)\n" +
                "/list - 查看骗子ID列表 - [本地库] (管理员)\n" +
                "/blocklist - 查看屏蔽用户列表 - [本地库] (管理员)\n";
  await replyAndDelete(chatId, helpMsg, commandMsgId, threadId, event);
}

async function handleModeCommand(message, event, args, chatId, threadId, commandMsgId) {
  const newMode = args.trim().toLowerCase();
  const curMode = await getCurrentMode();
  if (newMode === '') {
    if (curMode === 'private') {
      const gid = await getGroupChatId();
      if (!gid) {
        await replyAndDelete(chatId, '无法切换到群组模式：未设置群组ID。请先使用 /setgroup 设置群组ID或配置环境变量 GROUP_CHAT_ID。', commandMsgId, threadId, event);
        return;
      }
      await setCurrentMode('group');
      await replyAndDelete(chatId, '已切换到群组模式。所有用户消息将转发到群组话题中。', commandMsgId, threadId, event);
    } else {
      await setCurrentMode('private');
      await replyAndDelete(chatId, '已切换到私聊模式。所有用户消息将私聊转发给管理员。', commandMsgId, threadId, event);
    }
    return;
  } else if (newMode === 'group') {
    const gid = await getGroupChatId();
    if (!gid) {
      await replyAndDelete(chatId, '请先设置群组ID（环境变量 GROUP_CHAT_ID 或使用 /setgroup 命令）。', commandMsgId, threadId, event);
      return;
    }
    await setCurrentMode('group');
    await replyAndDelete(chatId, '已切换到群组模式。所有用户消息将转发到群组话题中。', commandMsgId, threadId, event);
  } else if (newMode === 'private') {
    await setCurrentMode('private');
    await replyAndDelete(chatId, '已切换到私聊模式。所有用户消息将私聊转发给管理员。', commandMsgId, threadId, event);
  } else {
    await replyAndDelete(chatId, `当前模式: ${curMode}\n使用方法: /mode 或 /mode private 或 /mode group`, commandMsgId, threadId, event);
  }
}

async function handleSetGroupCommand(message, event, args, chatId, threadId, commandMsgId) {
  const newGroupId = args.trim();
  if (!newGroupId) {
    await replyAndDelete(chatId, '使用方法: /setgroup 群组ID', commandMsgId, threadId, event);
    return;
  }
  await setGroupChatId(newGroupId);
  await replyAndDelete(chatId, `群组ID已设置为: ${newGroupId}（持久化保存）`, commandMsgId, threadId, event);
}

async function handleDelCommand(message, event, args, chatId, threadId, commandMsgId) {
  const topicCount = await clearAllUserTopics();
  const kvCount = await clearTempKV();
  await replyAndDelete(chatId, `已删除 ${topicCount} 个用户话题，并清理 ${kvCount} 个临时 KV 数据。`, commandMsgId, threadId, event);
}

async function handleListCommand(message, event, args, chatId, threadId, commandMsgId) {
  const fraudList = await getLocalFraudList();
  if (fraudList.length === 0) {
    await replyAndDelete(chatId, '本地没有骗子ID。', commandMsgId, threadId, event);
  } else {
    const listHtml = await formatUserListHTML(fraudList, '本地骗子ID列表');
    await replyAndDelete(chatId, listHtml, commandMsgId, threadId, event, { parse_mode: 'HTML' });
  }
}

// ---------- 辅助：从回复或参数中获取目标用户ID ----------
async function getUserIdFromReplyOrArgs(message, args, requireReply = false, commandName = '') {
  let userId = null;
  let error = null;
  const cmdPrefix = commandName ? `/${commandName}` : '该命令';

  if (message.reply_to_message) {
    userId = await getGuestIdFromReply(message.reply_to_message.message_id);
    if (!userId) {
      error = '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。';
      return { userId, error };
    }
  } else if (args && args.trim()) {
    const parts = args.trim().split(/\s+/);
    if (parts.length > 0 && parts[0]) {
      userId = parts[0];
      if (!/^\d+$/.test(userId)) {
        error = '无效的用户ID，必须为数字。';
        return { userId: null, error };
      }
    } else {
      error = '未提供用户ID。';
    }
  } else {
    if (requireReply) {
      error = `使用方法：请回复某条消息并输入 ${cmdPrefix}`;
    } else {
      error = `使用方法: 请回复某条消息并输入 ${cmdPrefix}，或输入 ${cmdPrefix} 用户UID`;
    }
    return { userId: null, error };
  }

  if (requireReply && !message.reply_to_message) {
    error = `使用方法：请回复某条消息并输入 ${cmdPrefix}`;
    userId = null;
  }

  return { userId, error };
}

// ---------- 统一转发消息到目标聊天 ----------
async function forwardMessageToChat(sourceMessage, targetChatId, replyToMsgId = null, extraOptions = {}) {
  // ---------- 自动解析引用 ----------
  if (!replyToMsgId && sourceMessage.reply_to_message) {
    const refChatId = sourceMessage.reply_to_message.chat.id;
    const refMsgId = sourceMessage.reply_to_message.message_id;
    let foundId = null;

    // 如果引用消息就在目标聊天中，直接使用
    if (String(refChatId) === String(targetChatId)) {
      foundId = refMsgId;
    } else {
      // 尝试正向映射：源 -> 目标
      const mapping = await getTargetMessage(refChatId, refMsgId);
      if (mapping && String(mapping.target_chat_id) === String(targetChatId)) {
        foundId = mapping.target_message_id;
      } else {
        // 尝试反向映射：目标 -> 源
        const revMapping = await getSourceMessage(refChatId, refMsgId);
        if (revMapping && String(revMapping.source_chat_id) === String(targetChatId)) {
          foundId = revMapping.source_message_id;
        }
      }
    }

    if (foundId) {
      replyToMsgId = foundId;
      console.log(`[转发引用] 找到映射引用 ${refChatId}:${refMsgId} -> ${targetChatId}:${foundId}`);
    } else {
      console.log(`[转发引用] 未找到映射，忽略引用`);
    }
  }

  // ---------- 转发逻辑 ----------
  try {
    let sendRes;
    const chatId = sourceMessage.chat.id;
    const msgId = sourceMessage.message_id;
    let targetMsgId = null;
    let msgType = getMessageType(sourceMessage);
    let mediaInfo = extractMediaFromMessage(sourceMessage);

    if (sourceMessage.text) {
      const sendObj = {
        chat_id: targetChatId,
        text: sourceMessage.text,
        entities: sourceMessage.entities,
        ...extraOptions
      };
      if (replyToMsgId) sendObj.reply_to_message_id = replyToMsgId;
      sendRes = await sendMessage(sendObj);
    } else {
      const copyObj = {
        chat_id: targetChatId,
        from_chat_id: chatId,
        message_id: msgId,
        ...extraOptions
      };
      if (replyToMsgId) copyObj.reply_to_message_id = replyToMsgId;
      sendRes = await copyMessage(copyObj);
    }

    if (sendRes.ok && sendRes.result) {
      targetMsgId = sendRes.result.message_id;
      await saveMessageMapping(chatId, msgId, targetChatId, targetMsgId, msgType, mediaInfo ? mediaInfo.type : null, !!sourceMessage.reply_markup);
      return { ok: true, targetMsgId, error: null };
    } else {
      const errorMsg = (sendRes && sendRes.description) ? sendRes.description : '转发失败';
      return { ok: false, targetMsgId: null, error: errorMsg };
    }
  } catch (err) {
    return { ok: false, targetMsgId: null, error: err.message || '未知错误' };
  }
}

// ---------- 搜索命令 ----------
async function handleSearchCommand(message, event, args, chatId, threadId, commandMsgId) {
  const { userId, error } = await getUserIdFromReplyOrArgs(message, args, false, 'search');
  if (error) {
    await replyAndDelete(chatId, error, commandMsgId, threadId, event);
    return;
  }
  const userInfo = await getUserInfo(userId);
  if (!userInfo) {
    await replyAndDelete(chatId, `无法找到 UID：${userId} 的用户信息`, commandMsgId, threadId, event);
    return;
  }
  const nickname = await getDisplayName(userId, false);
  await replyAndDelete(chatId, `昵称：${nickname},UID：${userId}`, commandMsgId, threadId, event);
}

// ---------- 通用 fraud 切换 ----------
async function handleFraudToggle(message, event, args, chatId, threadId, commandMsgId, action) {
  let userId = null;
  let error = null;
  const isRemove = (action === 'remove');

  if (message.reply_to_message) {
    userId = await getGuestIdFromReply(message.reply_to_message.message_id);
    if (!userId) {
      error = '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。';
    }
  } else if (args && args.trim()) {
    const trimmed = args.trim().split(/\s+/)[0];
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (isRemove) {
        const list = await getLocalFraudList();
        if (num >= 1 && num <= list.length) {
          userId = list[num - 1];
        } else {
          userId = trimmed;
        }
      } else {
        userId = trimmed;
      }
    } else {
      error = '无效的用户ID或序号，必须为数字。';
    }
  } else {
    if (isRemove) {
      error = '使用方法: 请回复某条消息并输入 /unfraud，或 使用 /unfraud 序号 来移除骗子ID。\n序号可以通过 /list 获取';
    } else {
      error = '使用方法: 请回复某条消息并输入 /fraud，或输入 /fraud 用户UID';
    }
  }

  if (error) {
    await replyAndDelete(chatId, error, commandMsgId, threadId, event);
    return;
  }

  const idStr = String(userId);
  const list = await getLocalFraudList();
  const exists = list.includes(idStr);

  if (action === 'add') {
    if (!exists) {
      await addLocalFraud(idStr);
      await replyAndDelete(chatId, `已添加骗子ID: ${idStr}`, commandMsgId, threadId, event);
    } else {
      await replyAndDelete(chatId, `骗子ID ${idStr} 已存在`, commandMsgId, threadId, event);
    }
  } else { // remove
    if (exists) {
      await removeLocalFraud(idStr);
      await replyAndDelete(chatId, `已移除骗子ID: ${idStr}`, commandMsgId, threadId, event);
    } else {
      await replyAndDelete(chatId, `骗子ID ${idStr} 不在本地列表中`, commandMsgId, threadId, event);
    }
  }
}

// ---------- 通用 block 命令 ----------
async function handleBlockCommand(message, event, args, chatId, threadId, commandMsgId) {
  const { userId, error } = await getUserIdFromReplyOrArgs(message, args, false, 'block');
  if (error) {
    await replyAndDelete(chatId, error, commandMsgId, threadId, event);
    return;
  }
  if (String(userId) === ADMIN_UID) {
    await replyAndDelete(chatId, '不能屏蔽自己', commandMsgId, threadId, event);
    return;
  }
  const nickname = await getDisplayName(userId, false);
  await blockUser(userId);
  await replyAndDelete(chatId, `用户 ${nickname} 已被屏蔽`, commandMsgId, threadId, event);
}

async function handleCheckBlockCommand(message, event, args, chatId, threadId, commandMsgId) {
  const { userId, error } = await getUserIdFromReplyOrArgs(message, args, false, 'checkblock');
  if (error) {
    await replyAndDelete(chatId, error, commandMsgId, threadId, event);
    return;
  }
  const blocked = await isUserBlocked(userId);
  const nickname = await getDisplayName(userId, false);
  await replyAndDelete(chatId, `用户 ${nickname}${blocked ? ' 已被屏蔽' : ' 未被屏蔽'}`, commandMsgId, threadId, event);
}

async function handleUnblockCommand(message, event, args, chatId, threadId, commandMsgId) {
  if (message.reply_to_message) {
    const guestChatId = await getGuestIdFromReply(message.reply_to_message.message_id);
    if (guestChatId) {
      const nickname = await getDisplayName(guestChatId, false);
      await unblockUser(guestChatId);
      await replyAndDelete(chatId, `用户 ${nickname} 已解除屏蔽`, commandMsgId, threadId, event);
      return;
    } else {
      await replyAndDelete(chatId, '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。', commandMsgId, threadId, event);
      return;
    }
  }
  if (args) {
    const index = parseInt(args.split(' ')[0], 10);
    if (!isNaN(index)) {
      await unblockByIndex(index, event, commandMsgId, chatId, threadId);
      return;
    } else {
      await replyAndDelete(chatId, '无效的序号。', commandMsgId, threadId, event);
      return;
    }
  }
  await replyAndDelete(chatId, '使用方法: 请回复某条消息并输入 /unblock，或 使用 /unblock 序号 来解除屏蔽用户。\n序号可以通过 /blocklist 获取', commandMsgId, threadId, event);
}

// ---------- 显示屏蔽列表 ----------
async function listBlockedUsers(message, event, args, chatId, threadId, commandMsgId) {
  try {
    const blockedUsers = await getBlockedUsers();
    if (blockedUsers.length === 0) {
      await replyAndDelete(chatId, '没有被屏蔽的用户。', commandMsgId, threadId, event);
    } else {
      const listHtml = await formatUserListHTML(blockedUsers, '被屏蔽的用户列表');
      await replyAndDelete(chatId, listHtml, commandMsgId, threadId, event, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('[listBlockedUsers] 发送失败:', err);
    await replyAndDelete(chatId, `获取屏蔽列表失败: ${err.message || '未知错误'}`, commandMsgId, threadId, event);
  }
}

// ---------- 命令处理器映射表 ----------
const COMMAND_HANDLERS = {
  '/help': { handler: handleHelpCommand, requiresAdmin: true },
  '/mode': { handler: handleModeCommand, requiresAdmin: true },
  '/setgroup': { handler: handleSetGroupCommand, requiresAdmin: true },
  '/del': { handler: handleDelCommand, requiresAdmin: true },
  '/list': { handler: handleListCommand, requiresAdmin: true },
  '/search': { handler: handleSearchCommand, requiresAdmin: true },
  '/fraud': { handler: (m,e,a,c,t,msgId) => handleFraudToggle(m,e,a,c,t,msgId,'add'), requiresAdmin: true },
  '/unfraud': { handler: (m,e,a,c,t,msgId) => handleFraudToggle(m,e,a,c,t,msgId,'remove'), requiresAdmin: true },
  '/block': { handler: handleBlockCommand, requiresAdmin: true },
  '/checkblock': { handler: handleCheckBlockCommand, requiresAdmin: true },
  '/unblock': { handler: handleUnblockCommand, requiresAdmin: true },
  '/blocklist': { handler: listBlockedUsers, requiresAdmin: true },
};

// ---------- 通用命令处理函数 ----------
async function processCommand(message, event, command, args, chatId, threadId, commandMsgId) {
  const entry = COMMAND_HANDLERS[command];
  if (!entry) {
    if (await requireAdmin(message, event, commandMsgId)) {
      await replyAndDelete(chatId, `未知命令: ${command}`, commandMsgId, threadId, event);
    }
    return true;
  }
  if (entry.requiresAdmin) {
    if (!(await requireAdmin(message, event, commandMsgId))) return true;
  }
  await entry.handler(message, event, args, chatId, threadId, commandMsgId);
  return true;
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
    if (!originalMediaType) {
      console.log('[编辑] 原消息不是媒体，无法替换为媒体，忽略');
      return;
    }
    const newMedia = extractMediaFromMessage(message);
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

// ---------- 转发待发消息 ----------
async function forwardPendingMessage(targetUserId, event) {
  const pending = await consumePendingMessage();
  if (!pending) return { success: true, msg: '无待转发消息' };

  let forwardSuccess = false;
  let errorMsg = '';
  try {
    const copyRes = await copyMessage({
      chat_id: targetUserId,
      from_chat_id: pending.chat_id,
      message_id: pending.message_id
    });
    if (copyRes.ok && copyRes.result) {
      const msgType = pending.text ? 'text' : (pending.hasMedia ? 'media' : 'unknown');
      await saveMessageMapping(ADMIN_UID, pending.message_id, targetUserId, copyRes.result.message_id, msgType, null, false);
      forwardSuccess = true;
    } else {
      errorMsg = `copyMessage 失败: ${copyRes?.description || '未知错误'}`;
      console.error('[转发待发消息]', errorMsg);
      if (pending.text && !pending.hasMedia) {
        const sendRes = await sendMessage({ chat_id: targetUserId, text: pending.text });
        if (sendRes.ok && sendRes.result) {
          await saveMessageMapping(ADMIN_UID, pending.message_id, targetUserId, sendRes.result.message_id, 'text', null, false);
          forwardSuccess = true;
        } else {
          errorMsg = `sendMessage 失败: ${sendRes?.description || '未知错误'}`;
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
  const res = await sendToTarget(ADMIN_UID, resultText, { reply_to_message_id: pending.message_id });
  if (res && res.ok && res.result && event) {
    scheduleDeletion(ADMIN_UID, res.result.message_id, AUTO_DELETE_DELAY_MS, event);
  }
  return { success: forwardSuccess, msg: resultText };
}

// -------------------- 消息处理 --------------------
async function onMessage(message, event) {
  try { console.log('[onMessage] raw message:', JSON.stringify(message)); } catch(e){}

  const fromId = message.from ? message.from.id : null;
  const chatId = message.chat.id.toString();
  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();

  // 忽略群组中的非管理员消息
  if (message.chat.type !== 'private' && !isAdmin(fromId)) {
    console.log('[忽略] 群组中的普通用户消息，来自', fromId);
    return;
  }

  // 加载会话
  if (!chatSessions[chatId]) {
    chatSessions[chatId] = { step: 0, lastInteraction: Date.now() };
  }
  chatSessions[chatId].lastInteraction = Date.now();

  const command = getCommandFromMessage(message);
  const args = message.text ? message.text.slice((command||'').length).trim() : '';
  const commandMsgId = message.message_id;
  const threadId = message.message_thread_id;

  // ================= 处理 /start 命令 =================
  if (command === '/start') {
    const userId = fromId;
    if (isAdmin(userId)) {
      await sendToTarget(userId, await getStartMessage());
      await setVerified(userId);
      return;
    }
    if (await isVerified(userId)) {
      await sendToTarget(userId, await getStartMessage());
      await initUserTopicIfNeeded(userId);
    } else {
      const expiredHandled = await handleExpiredVerification(userId);
      if (!expiredHandled) await sendVerify(userId);
    }
    return;
  }

  // ================= 统一处理所有其他命令 =================
  if (command && command !== '/start') {
    await processCommand(message, event, command, args, chatId, threadId, commandMsgId);
    return;
  }

  // ================= 非命令消息按角色处理 =================

  // 普通用户（非管理员）私聊消息
  if (!isAdmin(fromId)) {
    await handleGuestMessage(message);
    return;
  }

  // 管理员在群组中的回复
  if (groupChatId && String(chatId) === String(groupChatId) && isAdmin(fromId)) {
    await handleGroupAdminReply(message, event, groupChatId);
    return;
  }

  // 管理员私聊消息（非命令）
  if (isAdmin(fromId) && message.chat.type === 'private') {
    await handlePrivateAdminForward(message, event, chatId);
    return;
  }

  // 理论上不会到达这里
  console.log('[onMessage] 未处理的消息', JSON.stringify(message));
}

// ---------- 群组管理员回复 ----------
async function handleGroupAdminReply(message, event, groupChatId) {
  let targetUserId = null;
  if (message.message_thread_id) {
    targetUserId = await getJson('topic_user_' + message.message_thread_id);
  }

  if (targetUserId) {
    let originalUserMsgId = null;
    if (message.reply_to_message) {
      const sourceInfo = await getSourceMessage(groupChatId, message.reply_to_message.message_id);
      if (sourceInfo) originalUserMsgId = sourceInfo.source_message_id;
    }

    const result = await forwardMessageToChat(message, targetUserId, originalUserMsgId);
    if (!result.ok) {
      const errMsg = `❌ 发送失败: ${result.error || '未知错误'}`;
      const sent = await sendToTargetWithThread(groupChatId, errMsg, message.message_thread_id, {
        reply_to_message_id: message.message_id
      });
      if (sent && sent.ok && sent.result && event) {
        scheduleDeletion(groupChatId, sent.result.message_id, AUTO_DELETE_DELAY_MS, event);
      }
    }
  } else {
    let errorMsg = '⚠️ 无法确定要发送给哪位用户。\n\n';
    if (message.message_thread_id) {
      errorMsg += `当前话题ID: ${message.message_thread_id}\n未找到对应的用户映射。\n\n`;
    } else {
      errorMsg += '当前消息不在话题中（缺少 message_thread_id）。\n\n';
    }
    errorMsg += '请确保：\n1️⃣ 消息发送在机器人创建的话题内\n2️⃣ 话题已正确关联用户（用户曾发过消息）\n3️⃣ 如问题持续，请让用户重新发一条消息以重建映射。';
    
    const sent = await sendToTargetWithThread(groupChatId, errorMsg, message.message_thread_id, {
      reply_to_message_id: message.message_id
    });
    if (sent && sent.ok && sent.result && event) {
      scheduleDeletion(groupChatId, sent.result.message_id, AUTO_DELETE_DELAY_MS, event);
    }
  }
}

// ---------- 私聊管理员转发 ----------
async function handlePrivateAdminForward(message, event, chatId) {
  if (message.reply_to_message) {
    const guestChatId = await getGuestIdFromReply(message.reply_to_message.message_id);
    if (guestChatId) {
      await setCurrentChatTarget(guestChatId);
      await saveRecentChatTargets(guestChatId);
      const result = await forwardMessageToChat(message, guestChatId);
      if (result.ok) {
        await deleteKey('msg-map-' + message.reply_to_message.message_id);
      } else {
        const errorMsg = `❌ 消息转发失败: ${result.error || '未知错误'}`;
        const sent = await sendToTarget(chatId, errorMsg, { reply_to_message_id: message.message_id });
        if (sent && sent.ok && sent.result && event) {
          scheduleDeletion(chatId, sent.result.message_id, AUTO_DELETE_DELAY_MS, event);
        }
      }
      return;
    }
  }

  let currentTarget = await getCurrentChatTarget();
  if (!currentTarget) {
    await savePendingMessage(message);
    const recentChatButtons = await generateRecentChatButtons();
    const sent = await sendToTarget(ADMIN_UID, "没有设置当前聊天目标!\n请先通过【回复某条消息】或【点击下方按钮】来设置聊天目标。", {
      reply_markup: recentChatButtons.reply_markup
    });
    if (sent && sent.ok && sent.result && event) {
      scheduleDeletion(ADMIN_UID, sent.result.message_id, AUTO_DELETE_DELAY_MS, event);
    }
    return;
  }
  const result = await forwardMessageToChat(message, currentTarget);
  if (!result.ok) {
    const errorMsg = `❌ 消息转发失败: ${result.error || '未知错误'}`;
    const sent = await sendToTarget(chatId, errorMsg, { reply_to_message_id: message.message_id });
    if (sent && sent.ok && sent.result && event) {
      scheduleDeletion(chatId, sent.result.message_id, AUTO_DELETE_DELAY_MS, event);
    }
  }
}

// -------------------- 访客消息处理（普通用户私聊） --------------------
async function handleGuestMessage(message) {
  const userId = message.from.id;

  if (await isUserBlocked(userId)) {
    return sendToTarget(userId, '您已被屏蔽，无法发送消息！');
  }

  // 使用封装的验证流程
  const verified = await ensureVerifiedOrPrompt(userId);
  if (!verified) return;

  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();
  if (currentMode === 'group' && groupChatId) {
    const nicknamePlain = await getDisplayName(userId, false);
    let topicId = await ensureUserTopic(userId, nicknamePlain);
    if (!topicId) {
      console.error('无法创建话题，群组ID可能不正确或机器人无权限');
      return;
    }
    const isFirst = !(await nfd.get('topic_initialized_' + topicId));
    if (isFirst) {
      await sendAdminButtonsInTopic(topicId, userId);
      await nfd.put('topic_initialized_' + topicId, '1');
    }
    await forwardUserMessageToTopic(userId, topicId, message);
    return;
  } else {
    const result = await forwardMessageToChat(message, ADMIN_UID);
    if (result.ok && result.targetMsgId) {
      await saveGuestIdMapping(result.targetMsgId, userId);

      const currentTarget = await getCurrentChatTarget();
      if (currentTarget !== userId) {
        await sendAdminInterface(userId, ADMIN_UID, null, 'private');
      }
      await saveRecentChatTargets(userId);
    } else {
      console.error('[私聊转发] 转发失败:', result.error);
    }
    return;
  }
}

// -------------------- 辅助函数（命令处理） --------------------
async function unblockByIndex(index, event, commandMsgId, chatId, threadId) {
  const blockedUsers = await getBlockedUsers();
  if (index < 1 || index > blockedUsers.length) {
    await replyAndDelete(chatId, '无效的序号。', commandMsgId, threadId, event);
    return;
  }
  const guestChatId = blockedUsers[index - 1];
  await unblockUser(guestChatId);
  const nickname = await getDisplayName(guestChatId, false);
  await replyAndDelete(chatId, `用户 ${nickname} 已解除屏蔽`, commandMsgId, threadId, event);
}

// ================= 回调处理 =================
async function handleVerifyCallback(callbackQuery, chatId, selIdx) {
  if (String(callbackQuery.from.id) !== String(chatId)) {
    await answerCallbackQuery(callbackQuery.id, '不要乱动别人的操作哟👻', true);
    return;
  }
  await answerCallbackQuery(callbackQuery.id);

  const key = 'verify-' + chatId;
  const rec = await getJson(key);
  if (!rec) {
    await sendToTarget(chatId, '验证已过期或不存在，请重试。');
    await sendVerify(chatId);
    return;
  }
  if (Date.now() > rec.expires) {
    await handleExpiredVerification(chatId);
    return;
  }
  if (await isVerifyLocked(chatId)) return;

  const attemptKey = 'verify-attempts-' + chatId;
  let attempts = await getJson(attemptKey) || 0;
  if (selIdx === rec.correctIndex) {
    await setVerified(chatId);
    await deleteKey(key);
    await deleteKey(attemptKey);
    if (rec.message_id) await safeDeleteMessage(chatId, rec.message_id);
    await sendToTarget(chatId, await getStartMessage());
    await initUserTopicIfNeeded(chatId);
    return;
  } else {
    attempts = Number(attempts) + 1;
    await setJson(attemptKey, attempts);
    if (attempts >= VERIFY_MAX_ATTEMPTS) {
      const until = await lockUser(chatId);
      await deleteOldVerifyMsg(chatId);
      await deleteKey(attemptKey);
      await sendLockMessage(chatId, until);
      return;
    } else {
      await deleteOldVerifyMsg(chatId);
      await sendVerify(chatId);
      return;
    }
  }
}

// 处理管理员回调动作
async function handleAdminCallback(action, uid, targetChatId, targetThreadId, message, event) {
  // 内部辅助：发送消息并自动删除
  async function sendAndDelete(chatId, text, threadId, extra = {}) {
    const res = await sendToTargetWithThread(chatId, text, threadId, extra);
    if (res && res.ok && res.result && event) {
      scheduleDeletion(chatId, res.result.message_id, AUTO_DELETE_DELAY_MS, event);
    }
    return res;
  }

  // 内部辅助：处理列表显示
  async function handleListCallback(listType) {
    try {
      const list = listType === 'fraud' ? await getLocalFraudList() : await getBlockedUsers();
      const title = listType === 'fraud' ? '本地骗子ID列表' : '被屏蔽的用户列表';
      const text = await formatUserListHTML(list, title);
      await sendAndDelete(targetChatId, text, targetThreadId, { parse_mode: 'HTML' });
    } catch (err) {
      await sendAndDelete(targetChatId, `获取列表失败: ${err.message || '未知错误'}`, targetThreadId);
    }
  }

  // 内部辅助：处理用户修改操作
  async function handleUserModify(actionType) {
    const uidStr = String(uid);
    const namePlain = await getDisplayName(uidStr, false);
    switch (actionType) {
      case 'block':
        if (uidStr === ADMIN_UID) {
          await sendAndDelete(targetChatId, '不能屏蔽自己', targetThreadId);
          return;
        }
        await blockUser(uidStr);
        await sendAndDelete(targetChatId, `用户 ${namePlain} 已被屏蔽`, targetThreadId);
        break;
      case 'unblock':
        await unblockUser(uidStr);
        await sendAndDelete(targetChatId, `用户 ${namePlain} 已解除屏蔽`, targetThreadId);
        break;
      case 'checkblock': {
        const blocked = await isUserBlocked(uidStr);
        await sendAndDelete(targetChatId, `用户 ${namePlain}${blocked ? ' 已被屏蔽' : ' 未被屏蔽'}`, targetThreadId);
        break;
      }
      case 'fraud': {
        const list = await getLocalFraudList();
        if (!list.includes(uidStr)) {
          await addLocalFraud(uidStr);
          await sendAndDelete(targetChatId, `已添加骗子ID: ${uidStr}`, targetThreadId);
        } else {
          await sendAndDelete(targetChatId, `骗子ID ${uidStr} 已存在`, targetThreadId);
        }
        break;
      }
      case 'unfraud': {
        const list = await getLocalFraudList();
        const idx = list.indexOf(uidStr);
        if (idx > -1) {
          await removeLocalFraud(uidStr);
          await sendAndDelete(targetChatId, `已移除骗子ID: ${uidStr}`, targetThreadId);
        } else {
          await sendAndDelete(targetChatId, `骗子ID ${uidStr} 不在本地列表中`, targetThreadId);
        }
        break;
      }
      default:
        await sendAndDelete(targetChatId, `未知操作: ${actionType}`, targetThreadId);
    }
  }

  switch (action) {
    case 'select': {
      const namePlain = await getDisplayName(uid, false);
      await setCurrentChatTarget(uid);
      await saveRecentChatTargets(uid);
      chatSessions[ADMIN_UID] = { target: uid, timestamp: Date.now() };
      await saveChatSession();
      await sendAndDelete(targetChatId, `已选择当前聊天目标：${namePlain} ${uid}`, targetThreadId, {
        reply_to_message_id: message ? message.message_id : undefined
      });
      await forwardPendingMessage(uid, event);
      break;
    }
    case 'search': {
      const userInfo = await getUserInfo(uid);
      if (!userInfo) {
        await sendAndDelete(targetChatId, `无法找到 UID：${uid} 的用户信息`, targetThreadId);
        break;
      }
      const nickname = await getDisplayName(uid, false);
      await sendAndDelete(targetChatId, `昵称：${nickname},UID：${uid}`, targetThreadId);
      break;
    }
    case 'block':
    case 'unblock':
    case 'checkblock':
    case 'fraud':
    case 'unfraud':
      await handleUserModify(action);
      break;
    case 'list':
      await handleListCallback('fraud');
      break;
    case 'blocklist':
      await handleListCallback('block');
      break;
    case 'end': {
      const chatId = message.chat.id;
      const topicId = message.message_thread_id;
      if (!topicId) {
        await sendAndDelete(chatId, '无法获取话题 ID，请确认消息是否位于话题中。', targetThreadId);
        break;
      }
      const delRes = await requestTelegram('deleteForumTopic', makeReqBody({
        chat_id: chatId,
        message_thread_id: topicId
      }));
      if (delRes.ok) {
        await deleteKey('user_topic_' + uid);
        await deleteKey('topic_user_' + topicId);
        await deleteKey('topic_initialized_' + topicId);
        await deleteKey('verified-' + uid);
        await deleteKey('verify-attempts-' + uid);
        await deleteKey('verify-lock-' + uid);
        await safeDeleteMessage(chatId, message.message_id);
      } else {
        await sendAndDelete(chatId, `删除话题失败: ${JSON.stringify(delRes)}`, targetThreadId);
      }
      break;
    }
    case 'cancel': {
      try {
        const namePlain = await getDisplayName(uid, false);
        if (message && message.chat && message.message_id) {
          await safeDeleteMessage(message.chat.id, message.message_id);
        }
        await consumePendingMessage();
        const currentTarget = await getCurrentChatTarget();
        let text;
        if (currentTarget && String(currentTarget) === String(uid)) {
          await deleteKey('currentChatTarget');
          text = `已取消当前聊天目标：${namePlain} ${uid}`;
        } else {
          text = `已取消选择：${namePlain} ${uid}，当前聊天目标保持不变。`;
        }
        await sendAndDelete(targetChatId, text, targetThreadId);
      } catch (e) {
        console.error('[onCallbackQuery][cancel] overall failed', e);
        await consumePendingMessage();
        await sendAndDelete(targetChatId, `已取消操作 UID：${uid}`, targetThreadId);
      }
      break;
    }
    default:
      await sendAndDelete(targetChatId, `未知操作: ${action}`, targetThreadId);
  }
}

async function onCallbackQuery(callbackQuery, event) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  // 统一解析回调数据
  const [action, ...args] = data.split('_');

  // ===== 验证回调 =====
  if (action === 'verify') {
    const chatId = args[0];
    const selIdx = parseInt(args[1], 10);
    await handleVerifyCallback(callbackQuery, chatId, selIdx);
    return;
  }

  // ===== 非 verify 回调，需要管理员权限 =====
  if (!isAdmin(callbackQuery.from && callbackQuery.from.id)) {
    await answerCallbackQuery(callbackQuery.id, '仅限管理员使用该按钮。', true);
    return;
  }

  // 确定目标聊天和话题
  const currentMode = await getCurrentMode();
  const groupChatId = await getGroupChatId();
  const isGroupMode = (currentMode === 'group' && groupChatId && String(message.chat.id) === String(groupChatId));
  const targetChatId = isGroupMode ? message.chat.id : ADMIN_UID;
  const targetThreadId = isGroupMode ? message.message_thread_id : undefined;

  // 提取 UID（对于 list/blocklist 等操作，UID 可能被忽略）
  const uid = args.length > 0 ? args.join('_') : '';

try {
  await handleAdminCallback(action, uid, targetChatId, targetThreadId, message, event);
} catch (err) {
  console.error('[onCallbackQuery] handler error', err);
  const errRes = await sendToTargetWithThread(targetChatId, `处理回调出错: ${err && err.message ? err.message : err}`, targetThreadId);
  if (errRes && errRes.ok && errRes.result && event) {
    scheduleDeletion(targetChatId, errRes.result.message_id, AUTO_DELETE_DELAY_MS, event);
  }
}

  // 应答回调
  try {
    await answerCallbackQuery(callbackQuery.id);
  } catch (e) {
    console.warn('[onCallbackQuery] final answerCallbackQuery failed', e);
  }
}
