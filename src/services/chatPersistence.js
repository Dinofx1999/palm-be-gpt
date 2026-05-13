// backend/src/services/chatPersistence.js
// ============================================================
// Service lưu phiên chat + tin nhắn vào DB
// Tách khỏi chat.js để code gọn + dễ test
//
// Sử dụng:
//   const persistence = require('./chatPersistence');
//   const session = await persistence.ensureSession({ userId, branchId, sessionId, firstMessage });
//   await persistence.saveUserMessage(session._id, ...);
//   await persistence.saveAssistantMessage(session._id, ...);
// ============================================================

const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');

// ============================================================
// Auto generate title từ tin nhắn đầu tiên
// ============================================================
function generateTitle(firstMessage) {
  if (!firstMessage) return 'Cuộc trò chuyện mới';
  const cleaned = String(firstMessage).trim().replace(/\s+/g, ' ');
  if (cleaned.length <= 60) return cleaned;
  return cleaned.slice(0, 57) + '...';
}

// ============================================================
// Đảm bảo có ChatSession — tìm theo sessionId từ FE,
// nếu chưa có thì tạo mới
// ============================================================
async function ensureSession({
  sessionId,         // ID từ FE (có thể là UUID local của ChatWidget)
  userId,
  userName,
  userRole,
  branchId,
  branchName,
  firstMessage,
}) {
  if (!userId) return null;  // External user — không lưu

  // Tìm session theo (userId + sessionId) — FE gửi sessionId qua param
  let session = null;
  if (sessionId) {
    session = await ChatSession.findOne({
      userId,
      _id: sessionId.match(/^[0-9a-fA-F]{24}$/) ? sessionId : undefined,
    });
  }

  if (!session) {
    // Tạo mới
    session = await ChatSession.create({
      userId,
      userName: userName || '',
      userRole: userRole || '',
      branchId: branchId || null,
      branchName: branchName || '',
      title: generateTitle(firstMessage),
      messageCount: 0,
      lastMessageAt: new Date(),
    });
  }

  return session;
}

// ============================================================
// Lưu tin nhắn user
// ============================================================
async function saveUserMessage(session, {
  text,
  messageId,
}) {
  if (!session) return null;

  const msg = await ChatMessage.create({
    sessionId: session._id,
    userId: session.userId,
    branchId: session.branchId,
    role: 'user',
    text: (text || '').slice(0, 10000),
    messageId,
  });

  // Update session stats
  session.messageCount = (session.messageCount || 0) + 1;
  session.lastMessageText = (text || '').slice(0, 300);
  session.lastMessageAt = new Date();
  // Nếu là tin đầu tiên và title chưa được set rõ → update title
  if (session.messageCount === 1 && session.title === 'Cuộc trò chuyện mới') {
    session.title = generateTitle(text);
  }
  await session.save();

  return msg;
}

// ============================================================
// Lưu tin nhắn assistant + tool calls + usage
// ============================================================
async function saveAssistantMessage(session, {
  text,
  toolCalls = [],
  tokensUsed = {},
  modelUsed = '',
  iterations = 0,
  messageId,
}) {
  if (!session) return null;

  // Compute total + cost
  const total = (tokensUsed.prompt || 0) + (tokensUsed.output || 0);
  const cacheHitRate = tokensUsed.prompt > 0
    ? Math.round(((tokensUsed.cached || 0) / tokensUsed.prompt) * 100)
    : 0;
  const estimatedCostVND = ChatMessage.calcCostVND(tokensUsed);

  const msg = await ChatMessage.create({
    sessionId: session._id,
    userId: session.userId,
    branchId: session.branchId,
    role: 'assistant',
    text: (text || '').slice(0, 10000),
    toolCalls: toolCalls.map(tc => ({
      name: tc.name,
      args: tc.args,
      // Truncate result để tránh phình DB (tool có thể trả về nhiều data)
      result: tc.result ? truncateResult(tc.result) : null,
      error: tc.error || null,
      durationMs: tc.durationMs || 0,
    })),
    tokensUsed: {
      prompt: tokensUsed.prompt || 0,
      cached: tokensUsed.cached || 0,
      output: tokensUsed.output || 0,
      total,
      cacheHitRate,
      estimatedCostVND,
    },
    modelUsed,
    iterations,
    messageId,
  });

  // Update session
  session.messageCount = (session.messageCount || 0) + 1;
  session.lastMessageText = (text || '').slice(0, 300);
  session.lastMessageAt = new Date();
  session.totalTokensUsed = (session.totalTokensUsed || 0) + total;
  session.estimatedCostVND = (session.estimatedCostVND || 0) + estimatedCostVND;
  await session.save();

  return msg;
}

// ============================================================
// Truncate kết quả tool (tránh phình DB nếu tool trả về nhiều data)
// ============================================================
function truncateResult(result) {
  try {
    const str = JSON.stringify(result);
    if (str.length <= 5000) return result;     // < 5KB OK
    // Quá to → chỉ lưu first 5000 chars + flag
    return {
      _truncated: true,
      _originalSize: str.length,
      _preview: str.slice(0, 5000),
    };
  } catch (e) {
    return { _error: 'Cannot serialize result' };
  }
}

// ============================================================
// Update feedback (thumbs up/down) — gọi từ route feedback
// ============================================================
async function updateFeedback(messageId, feedback, note = '') {
  if (!['up', 'down', null].includes(feedback)) {
    throw new Error('Invalid feedback value');
  }
  const msg = await ChatMessage.findOneAndUpdate(
    { messageId },
    { feedback, feedbackNote: note },
    { new: true }
  );
  return msg;
}

module.exports = {
  ensureSession,
  saveUserMessage,
  saveAssistantMessage,
  updateFeedback,
  generateTitle,
};