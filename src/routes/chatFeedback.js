// backend/src/routes/chatFeedback.js
// ============================================================
// API endpoints:
//   - POST /api/chat-feedback              (user submit 👍/👎)
//   - GET  /api/chat-feedback              (admin xem list)
//   - GET  /api/chat-feedback/stats        (admin stats)
//   - POST /api/chat-feedback/:id/convert  (admin convert → few-shot)
//   - POST /api/chat-feedback/:id/dismiss  (admin bỏ qua)
//
//   - GET    /api/chat-fewshots            (admin list)
//   - POST   /api/chat-fewshots            (admin create)
//   - PATCH  /api/chat-fewshots/:id        (admin update)
//   - DELETE /api/chat-fewshots/:id        (admin delete)
//   - GET    /api/chat-fewshots/export     (export JSON)
//   - POST   /api/chat-fewshots/refresh-cache (invalidate cache)
// ============================================================

const express = require('express');
const router = express.Router();

// ⭐ Auth middleware — đồng bộ với các route khác trong dự án
const { authenticate, authorize } = require('../middleware/auth');

const ChatFeedback = require('../models/ChatFeedback');
const ChatFewShot = require('../models/ChatFewShot');
const { invalidateAllCaches, getStats: getCacheStats } = require('../services/chatCache');

// ============================================================
// Auth helpers
// ============================================================
// User endpoints chỉ cần authenticate (mọi role đăng nhập đều submit feedback được)
// Admin endpoints cần authenticate + authorize('Admin')
const requireAdmin = [authenticate, authorize('Admin')];

// ============================================================
// USER ENDPOINTS
// ============================================================

// Submit feedback — cần đăng nhập (mọi role)
router.post('/chat-feedback', authenticate, async (req, res) => {
  try {
    const {
      sessionId,
      messageId,
      userQuestion,
      aiAnswer,
      rating,         // 1 hoặc -1
      reason = '',
      modelUsed = '',
    } = req.body;

    if (!sessionId || !messageId || !userQuestion || !aiAnswer || ![1, -1].includes(rating)) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu trường bắt buộc hoặc rating không hợp lệ (1 hoặc -1)',
      });
    }

    // Check trùng — 1 message chỉ feedback 1 lần
    const existing = await ChatFeedback.findOne({ messageId });
    if (existing) {
      // Update rating thay vì tạo mới
      existing.rating = rating;
      existing.reason = reason;
      await existing.save();
      return res.json({ success: true, message: 'Đã cập nhật feedback', data: existing });
    }

    const feedback = await ChatFeedback.create({
      sessionId,
      messageId,
      userQuestion,
      aiAnswer,
      rating,
      reason,
      modelUsed,
      userRole: req.user?.role || 'Receptionist',
      branchId: req.user?.branchId?._id || req.user?.branchId || null,
      branchName: req.user?.branchId?.name || '',
      submittedBy: req.user?.id || null,
    });

    res.status(201).json({ success: true, message: 'Cảm ơn phản hồi của bạn!', data: feedback });
  } catch (err) {
    console.error('[chatFeedback] POST error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// ADMIN: FEEDBACK MANAGEMENT
// ============================================================

// List feedback (default: pending 👎)
router.get('/chat-feedback', requireAdmin, async (req, res) => {
  try {
    const {
      rating,
      status = 'pending',
      page = 1,
      limit = 20,
    } = req.query;

    const filter = {};
    if (rating !== undefined) filter.rating = Number(rating);
    if (status !== 'all') filter.status = status;

    const total = await ChatFeedback.countDocuments(filter);
    const data = await ChatFeedback.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .populate('submittedBy', 'username fullName')
      .populate('reviewedBy', 'username fullName')
      .lean();

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } });
  } catch (err) {
    console.error('[chatFeedback] GET error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Stats
router.get('/chat-feedback/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await ChatFeedback.aggregate([
      {
        $group: {
          _id: { rating: '$rating', status: '$status' },
          count: { $sum: 1 },
        },
      },
    ]);

    const summary = {
      total: 0,
      thumbsUp: 0,
      thumbsDown: 0,
      pendingReview: 0,
      reviewed: 0,
      converted: 0,
      dismissed: 0,
    };

    for (const s of stats) {
      summary.total += s.count;
      if (s._id.rating === 1) summary.thumbsUp += s.count;
      if (s._id.rating === -1) summary.thumbsDown += s.count;
      if (s._id.status === 'pending') summary.pendingReview += s.count;
      if (s._id.status === 'reviewed') summary.reviewed += s.count;
      if (s._id.status === 'converted') summary.converted += s.count;
      if (s._id.status === 'dismissed') summary.dismissed += s.count;
    }

    summary.satisfactionRate = summary.total > 0
      ? Math.round((summary.thumbsUp / summary.total) * 100)
      : 0;

    res.json({ success: true, data: summary });
  } catch (err) {
    console.error('[chatFeedback] stats error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Convert feedback → few-shot
router.post('/chat-feedback/:id/convert', requireAdmin, async (req, res) => {
  try {
    const { title, category, assistantOutput, priority = 7 } = req.body;
    if (!title || !category || !assistantOutput) {
      return res.status(400).json({
        success: false,
        message: 'Cần: title, category, assistantOutput',
      });
    }

    const feedback = await ChatFeedback.findById(req.params.id);
    if (!feedback) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy feedback' });
    }

    // Tạo few-shot mới từ feedback
    const fewShot = await ChatFewShot.create({
      title,
      category,
      pattern: feedback.reason || '',
      userInput: feedback.userQuestion,
      assistantOutput,
      priority,
      isActive: true,
      source: 'from_feedback',
      sourceFeedbackId: feedback._id,
      createdBy: req.user?.id || null,
    });

    // Update feedback status
    feedback.status = 'converted';
    feedback.convertedToFewShotId = fewShot._id;
    feedback.reviewedBy = req.user?.id || null;
    feedback.reviewedAt = new Date();
    await feedback.save();

    // ⭐ Invalidate cache để lần sau load few-shot mới
    invalidateAllCaches();

    res.json({
      success: true,
      message: 'Đã convert thành few-shot example. Cache đã được refresh.',
      data: { feedback, fewShot },
    });
  } catch (err) {
    console.error('[chatFeedback] convert error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Dismiss feedback
router.post('/chat-feedback/:id/dismiss', requireAdmin, async (req, res) => {
  try {
    const { adminNote = '' } = req.body;
    const feedback = await ChatFeedback.findByIdAndUpdate(
      req.params.id,
      {
        status: 'dismissed',
        adminNote,
        reviewedBy: req.user?.id || null,
        reviewedAt: new Date(),
      },
      { new: true }
    );
    if (!feedback) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy feedback' });
    }
    res.json({ success: true, message: 'Đã bỏ qua feedback', data: feedback });
  } catch (err) {
    console.error('[chatFeedback] dismiss error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// ADMIN: FEW-SHOTS MANAGEMENT
// ============================================================

router.get('/chat-fewshots', requireAdmin, async (req, res) => {
  try {
    const { category, isActive, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const total = await ChatFewShot.countDocuments(filter);
    const data = await ChatFewShot.find(filter)
      .sort({ priority: -1, createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .populate('branchId', 'name')
      .lean();

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/chat-fewshots', requireAdmin, async (req, res) => {
  try {
    const { title, userInput, assistantOutput, category } = req.body;
    if (!title || !userInput || !assistantOutput || !category) {
      return res.status(400).json({
        success: false,
        message: 'Cần: title, userInput, assistantOutput, category',
      });
    }
    const fewShot = await ChatFewShot.create({
      ...req.body,
      source: 'manual',
      createdBy: req.user?.id || null,
    });
    invalidateAllCaches();
    res.status(201).json({ success: true, message: 'Đã tạo. Cache đã refresh.', data: fewShot });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/chat-fewshots/:id', requireAdmin, async (req, res) => {
  try {
    const fewShot = await ChatFewShot.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!fewShot) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    invalidateAllCaches();
    res.json({ success: true, message: 'Đã cập nhật. Cache đã refresh.', data: fewShot });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/chat-fewshots/:id', requireAdmin, async (req, res) => {
  try {
    const fewShot = await ChatFewShot.findByIdAndDelete(req.params.id);
    if (!fewShot) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    invalidateAllCaches();
    res.json({ success: true, message: 'Đã xoá. Cache đã refresh.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Export tất cả few-shots ra JSON
router.get('/chat-fewshots/export', requireAdmin, async (req, res) => {
  try {
    const fewShots = await ChatFewShot.find({ isActive: true })
      .select('-_id title category pattern priority userInput assistantOutput source')
      .sort({ priority: -1, category: 1 })
      .lean();

    const filename = `chat-fewshots-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(fewShots);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Manual refresh cache
router.post('/chat-fewshots/refresh-cache', requireAdmin, (req, res) => {
  invalidateAllCaches();
  res.json({ success: true, message: 'Cache đã được refresh', stats: getCacheStats() });
});

// Cache stats
router.get('/chat-fewshots/cache-stats', requireAdmin, (req, res) => {
  res.json({ success: true, data: getCacheStats() });
});

module.exports = router;