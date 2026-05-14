// backend/src/routes/chatHistory.js
// ============================================================
// API lấy lịch sử chat từ DB
//
// User endpoints (xem của mình):
//   GET    /api/chat-history/sessions          — List sessions của user hiện tại
//   GET    /api/chat-history/sessions/:id      — Get 1 session + tất cả messages
//   PATCH  /api/chat-history/sessions/:id      — Đổi title / pin / archive
//   DELETE /api/chat-history/sessions/:id      — Xoá session (+ messages)
//
// Admin endpoints:
//   GET    /api/chat-history/admin/sessions    — List tất cả sessions (filter)
//   GET    /api/chat-history/admin/stats       — Stats: tổng chat, top user, cost
// ============================================================

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const router = express.Router();

const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');

// ============================================================
// MIDDLEWARE — Parse JWT (bắt buộc cho route này)
// Tương tự inline trong /api/chat/message, nhưng REQUIRED
// ============================================================
async function requireAuth(req, res, next) {
  // Đã có req.user (qua middleware khác) → bỏ qua
  if (req.user?.id || req.user?._id) return next();

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Fallback: cho phép FE truyền userId qua query (cho app nội bộ, validate ObjectId)
  const bodyUserId = req.query.userId || req.body?.userId;

  if (token && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = {
        id: decoded.id || decoded._id || decoded.userId || decoded.sub,
        _id: decoded._id || decoded.id || decoded.userId,
        role: decoded.role,
        branchId: decoded.branchId,
        fullName: decoded.fullName || decoded.name,
      };
      return next();
    } catch (e) {
      // JWT invalid → tiếp tục thử fallback
    }
  }

  // Fallback userId từ query (app nội bộ)
  if (bodyUserId && /^[0-9a-fA-F]{24}$/.test(String(bodyUserId))) {
    req.user = { id: String(bodyUserId), _id: String(bodyUserId) };
    return next();
  }

  return res.status(401).json({ message: 'Cần đăng nhập để xem lịch sử chat' });
}

// ============================================================
// GET /api/chat-history/sessions
//   List sessions của user hiện tại (mới nhất trước)
//   Query params: ?limit=50&before=ISO_DATE
// ============================================================
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const filter = { userId };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!isNaN(before.getTime())) filter.lastMessageAt = { $lt: before };
    }

    const sessions = await ChatSession.find(filter)
      .sort({ isPinned: -1, lastMessageAt: -1 })
      .limit(limit)
      .select('_id title messageCount lastMessageText lastMessageAt isArchived isPinned estimatedCostVND totalTokensUsed createdAt')
      .lean();

    res.json({
      count: sessions.length,
      sessions: sessions.map(s => ({
        id: String(s._id),
        title: s.title,
        messageCount: s.messageCount || 0,
        lastMessageText: s.lastMessageText || '',
        lastMessageAt: s.lastMessageAt,
        isArchived: s.isArchived || false,
        isPinned: s.isPinned || false,
        estimatedCostVND: s.estimatedCostVND || 0,
        totalTokensUsed: s.totalTokensUsed || 0,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error('[GET /chat-history/sessions]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// GET /api/chat-history/sessions/:id
//   Get 1 session với tất cả messages
// ============================================================
router.get('/sessions/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: 'sessionId không hợp lệ' });
    }
    const userId = req.user.id || req.user._id;

    const session = await ChatSession.findOne({ _id: id, userId }).lean();
    if (!session) {
      return res.status(404).json({ message: 'Không tìm thấy session (hoặc không có quyền)' });
    }

    const messages = await ChatMessage.find({ sessionId: id })
      .sort({ createdAt: 1 })
      .select('_id role text toolCalls feedback createdAt messageId tokensUsed')
      .lean();

    res.json({
      session: {
        id: String(session._id),
        title: session.title,
        messageCount: session.messageCount,
        isArchived: session.isArchived,
        isPinned: session.isPinned,
        createdAt: session.createdAt,
        lastMessageAt: session.lastMessageAt,
        totalTokensUsed: session.totalTokensUsed,
        estimatedCostVND: session.estimatedCostVND,
      },
      messages: messages.map(m => ({
        id: String(m._id),
        role: m.role,
        text: m.text,
        toolCalls: m.toolCalls || [],
        feedback: m.feedback || null,
        time: new Date(m.createdAt).getTime(),
        messageId: m.messageId,
        tokensUsed: m.tokensUsed,
      })),
    });
  } catch (err) {
    console.error('[GET /chat-history/sessions/:id]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// PATCH /api/chat-history/sessions/:id
//   Update title / archive / pin
// ============================================================
router.patch('/sessions/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: 'sessionId không hợp lệ' });
    }
    const userId = req.user.id || req.user._id;

    const { title, isArchived, isPinned } = req.body;
    const update = {};
    if (typeof title === 'string' && title.trim().length > 0 && title.length <= 200) {
      update.title = title.trim();
    }
    if (typeof isArchived === 'boolean') update.isArchived = isArchived;
    if (typeof isPinned === 'boolean') update.isPinned = isPinned;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'Không có trường nào để update' });
    }

    const session = await ChatSession.findOneAndUpdate(
      { _id: id, userId },
      { $set: update },
      { new: true }
    );
    if (!session) return res.status(404).json({ message: 'Không tìm thấy session' });

    res.json({ success: true, session: { id: String(session._id), ...update } });
  } catch (err) {
    console.error('[PATCH /chat-history/sessions/:id]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// DELETE /api/chat-history/messages/:id
//   Xoá 1 message duy nhất (vd chỉ xoá câu trả lời AI)
//   Tự động giảm messageCount của session
// ============================================================
router.delete('/messages/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: 'messageId không hợp lệ' });
    }
    const userId = req.user.id || req.user._id;

    // Tìm message + verify ownership qua userId
    const msg = await ChatMessage.findOne({ _id: id, userId });
    if (!msg) return res.status(404).json({ message: 'Không tìm thấy tin nhắn' });

    const sessionId = msg.sessionId;
    await ChatMessage.deleteOne({ _id: id });

    // Update messageCount của session
    const remaining = await ChatMessage.countDocuments({ sessionId });
    await ChatSession.updateOne(
      { _id: sessionId },
      { $set: { messageCount: remaining } }
    );

    res.json({ success: true, sessionId: String(sessionId), remaining });
  } catch (err) {
    console.error('[DELETE /chat-history/messages/:id]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// POST /api/chat-history/messages/delete-pair
//   Xoá 1 cặp tin nhắn (user msg + assistant msg liền kề)
//   Body: { userMessageId, assistantMessageId }
// ============================================================
router.post('/messages/delete-pair', requireAuth, async (req, res) => {
  try {
    const { userMessageId, assistantMessageId } = req.body;
    const userId = req.user.id || req.user._id;

    const ids = [userMessageId, assistantMessageId].filter(
      id => id && /^[0-9a-fA-F]{24}$/.test(id)
    );
    if (ids.length === 0) {
      return res.status(400).json({ message: 'Cần ít nhất 1 messageId hợp lệ' });
    }

    // Verify ownership
    const messages = await ChatMessage.find({ _id: { $in: ids }, userId }).select('sessionId');
    if (messages.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy tin nhắn (hoặc không có quyền)' });
    }

    const sessionId = messages[0].sessionId;
    const result = await ChatMessage.deleteMany({ _id: { $in: ids }, userId });

    // Update messageCount
    const remaining = await ChatMessage.countDocuments({ sessionId });
    await ChatSession.updateOne(
      { _id: sessionId },
      { $set: { messageCount: remaining } }
    );

    res.json({
      success: true,
      deletedCount: result.deletedCount,
      remaining,
    });
  } catch (err) {
    console.error('[POST /chat-history/messages/delete-pair]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// DELETE /api/chat-history/sessions/:id
//   Xoá 1 session + tất cả messages của nó
// ============================================================
router.delete('/sessions/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: 'sessionId không hợp lệ' });
    }
    const userId = req.user.id || req.user._id;

    const session = await ChatSession.findOne({ _id: id, userId });
    if (!session) return res.status(404).json({ message: 'Không tìm thấy session' });

    // Xoá messages trước
    const msgResult = await ChatMessage.deleteMany({ sessionId: id });
    // Rồi xoá session
    await ChatSession.deleteOne({ _id: id });

    res.json({
      success: true,
      deletedMessages: msgResult.deletedCount,
    });
  } catch (err) {
    console.error('[DELETE /chat-history/sessions/:id]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// DELETE /api/chat-history/sessions (delete all of current user)
// ============================================================
router.delete('/sessions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const sessions = await ChatSession.find({ userId }).select('_id').lean();
    const sessionIds = sessions.map(s => s._id);

    const msgResult = await ChatMessage.deleteMany({ sessionId: { $in: sessionIds } });
    const sessResult = await ChatSession.deleteMany({ userId });

    res.json({
      success: true,
      deletedSessions: sessResult.deletedCount,
      deletedMessages: msgResult.deletedCount,
    });
  } catch (err) {
    console.error('[DELETE /chat-history/sessions]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ════════════════════════════════════════════════════════════
// ⭐ ADMIN ENDPOINTS — xem chat của tất cả user
// ════════════════════════════════════════════════════════════
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ message: 'Chỉ Admin được xem' });
  }
  next();
}

// ============================================================
// GET /api/chat-history/admin/sessions
//   List ALL sessions với filter + pagination
//
// Query params:
//   - userId       (ObjectId)             Filter user cụ thể
//   - branchId     (ObjectId)             Filter chi nhánh
//   - fromDate     (ISO date)             Từ ngày
//   - toDate       (ISO date)             Đến ngày
//   - hasTool      (boolean)              Chỉ session có tool calls
//   - search       (string)               Search trong title / lastMessageText
//   - minCost      (number)               Min cost VND
//   - page         (number, default 1)
//   - limit        (number, default 30, max 100)
// ============================================================
router.get('/admin/sessions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      userId, branchId, fromDate, toDate, search,
      hasTool, minCost,
    } = req.query;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const skip = (page - 1) * limit;

    const filter = {};
    if (userId && /^[0-9a-fA-F]{24}$/.test(String(userId))) filter.userId = userId;
    if (branchId && /^[0-9a-fA-F]{24}$/.test(String(branchId))) filter.branchId = branchId;

    if (fromDate || toDate) {
      filter.lastMessageAt = {};
      if (fromDate) {
        const d = new Date(fromDate);
        if (!isNaN(d.getTime())) filter.lastMessageAt.$gte = d;
      }
      if (toDate) {
        const d = new Date(toDate);
        if (!isNaN(d.getTime())) {
          d.setHours(23, 59, 59, 999);    // toDate = cuối ngày
          filter.lastMessageAt.$lte = d;
        }
      }
    }

    if (search && String(search).trim()) {
      const re = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: re }, { lastMessageText: re }];
    }

    if (minCost) {
      const min = parseFloat(minCost);
      if (!isNaN(min)) filter.estimatedCostVND = { $gte: min };
    }

    // hasTool: nếu true → cần subquery tới chatmessages
    let sessionIds = null;
    if (hasTool === 'true' || hasTool === '1') {
      const sessions = await ChatMessage.distinct('sessionId', {
        toolCalls: { $exists: true, $not: { $size: 0 } },
      });
      sessionIds = sessions;
      filter._id = { $in: sessionIds };
    }

    const [sessions, total] = await Promise.all([
      ChatSession.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'fullName username role')
        .populate('branchId', 'name')
        .lean(),
      ChatSession.countDocuments(filter),
    ]);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sessions: sessions.map(s => ({
        id: String(s._id),
        title: s.title,
        messageCount: s.messageCount || 0,
        totalTokensUsed: s.totalTokensUsed || 0,
        estimatedCostVND: s.estimatedCostVND || 0,
        lastMessageText: s.lastMessageText || '',
        lastMessageAt: s.lastMessageAt,
        createdAt: s.createdAt,
        user: s.userId ? {
          id: String(s.userId._id),
          fullName: s.userId.fullName,
          username: s.userId.username,
          role: s.userId.role,
        } : { fullName: s.userName, role: s.userRole },
        branch: s.branchId ? {
          id: String(s.branchId._id),
          name: s.branchId.name,
        } : (s.branchName ? { name: s.branchName } : null),
      })),
    });
  } catch (err) {
    console.error('[GET /chat-history/admin/sessions]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// GET /api/chat-history/admin/sessions/:id
//   Get bất kỳ session nào (không cần là chủ session)
// ============================================================
router.get('/admin/sessions/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: 'sessionId không hợp lệ' });
    }

    const session = await ChatSession.findById(id)
      .populate('userId', 'fullName username role')
      .populate('branchId', 'name')
      .lean();
    if (!session) return res.status(404).json({ message: 'Không tìm thấy session' });

    const messages = await ChatMessage.find({ sessionId: id })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      session: {
        id: String(session._id),
        title: session.title,
        messageCount: session.messageCount,
        totalTokensUsed: session.totalTokensUsed,
        estimatedCostVND: session.estimatedCostVND,
        createdAt: session.createdAt,
        lastMessageAt: session.lastMessageAt,
        user: session.userId ? {
          id: String(session.userId._id),
          fullName: session.userId.fullName,
          username: session.userId.username,
          role: session.userId.role,
        } : { fullName: session.userName, role: session.userRole },
        branch: session.branchId ? {
          id: String(session.branchId._id),
          name: session.branchId.name,
        } : (session.branchName ? { name: session.branchName } : null),
      },
      messages: messages.map(m => ({
        id: String(m._id),
        role: m.role,
        text: m.text,
        toolCalls: m.toolCalls || [],
        tokensUsed: m.tokensUsed,
        feedback: m.feedback,
        time: new Date(m.createdAt).getTime(),
        modelUsed: m.modelUsed,
        iterations: m.iterations,
      })),
    });
  } catch (err) {
    console.error('[GET /chat-history/admin/sessions/:id]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ============================================================
// GET /api/chat-history/admin/stats
//   Stats tổng quan:
//   - Tổng cost AI 30 ngày
//   - Top users
//   - Chat per day (cho biểu đồ)
//
// Query: ?days=30  (mặc định 30 ngày)
// ============================================================
router.get('/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Tổng cost + token + session count
    const [aggregateRes] = await ChatSession.aggregate([
      { $match: { lastMessageAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          totalMessages: { $sum: '$messageCount' },
          totalCost: { $sum: '$estimatedCostVND' },
          totalTokens: { $sum: '$totalTokensUsed' },
        },
      },
    ]);

    // Top 10 users — dùng tổng cost
    const topUsersRaw = await ChatSession.aggregate([
      { $match: { lastMessageAt: { $gte: since } } },
      {
        $group: {
          _id: '$userId',
          userName: { $first: '$userName' },
          userRole: { $first: '$userRole' },
          sessionCount: { $sum: 1 },
          messageCount: { $sum: '$messageCount' },
          totalCost: { $sum: '$estimatedCostVND' },
          totalTokens: { $sum: '$totalTokensUsed' },
        },
      },
      { $sort: { totalCost: -1 } },
      { $limit: 10 },
    ]);

    // Populate user info (cho người dùng đã đổi tên)
    const User = require('../models/User');
    const userIds = topUsersRaw.map(u => u._id).filter(Boolean);
    const userMap = new Map();
    if (userIds.length > 0) {
      const users = await User.find({ _id: { $in: userIds } })
        .select('fullName username role')
        .lean();
      users.forEach(u => userMap.set(String(u._id), u));
    }

    const topUsers = topUsersRaw.map(u => {
      const user = userMap.get(String(u._id));
      return {
        userId: u._id ? String(u._id) : null,
        userName: user?.fullName || user?.username || u.userName || 'N/A',
        userRole: user?.role || u.userRole || '',
        sessionCount: u.sessionCount,
        messageCount: u.messageCount,
        totalCost: u.totalCost,
        totalTokens: u.totalTokens,
      };
    });

    // Số chat/ngày (cho biểu đồ time series)
    const chatPerDay = await ChatSession.aggregate([
      { $match: { lastMessageAt: { $gte: since } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$lastMessageAt' },
          },
          sessions: { $sum: 1 },
          messages: { $sum: '$messageCount' },
          cost: { $sum: '$estimatedCostVND' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      days,
      since,
      overview: {
        totalSessions: aggregateRes?.totalSessions || 0,
        totalMessages: aggregateRes?.totalMessages || 0,
        totalCost: aggregateRes?.totalCost || 0,
        totalTokens: aggregateRes?.totalTokens || 0,
      },
      topUsers,
      chatPerDay: chatPerDay.map(d => ({
        date: d._id,
        sessions: d.sessions,
        messages: d.messages,
        cost: d.cost,
      })),
    });
  } catch (err) {
    console.error('[GET /chat-history/admin/stats]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;