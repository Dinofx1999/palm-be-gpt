// backend/src/controllers/newsController.js
const News = require('../models/News');

/* ─────────────── PUBLIC (không cần auth) ─────────────── */

// GET /api/public/news?branchId=...  — chỉ tin đã publish
//   Trả tin CHUNG (branchId=null) + tin của chi nhánh (nếu có branchId)
const publicList = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const filter = { isPublished: true };
    if (branchId) {
      filter.$or = [{ branchId: null }, { branchId }];
    } else {
      filter.branchId = null;   // không truyền branch → chỉ tin chung
    }
    const data = await News.find(filter)
      .sort({ publishedAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

// GET /api/public/news/:slug — chi tiết 1 bài (+ tăng view)
const publicDetail = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const item = await News.findOneAndUpdate(
      { slug, isPublished: true },
      { $inc: { views: 1 } },
      { new: true },
    ).lean();
    if (!item) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    res.json({ success: true, data: item });
  } catch (err) { next(err); }
};

/* ─────────────── ADMIN (cần auth) ─────────────── */

// GET /api/news  — tất cả (kể cả nháp), cho trang quản lý
const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branchId) filter.branchId = req.query.branchId;
    if (req.query.category) filter.category = req.query.category;
    if (req.query.isPublished !== undefined) filter.isPublished = req.query.isPublished === 'true';
    const data = await News.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const item = await News.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    res.json({ success: true, data: { news: item } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Thiếu tiêu đề' });
    const allowed = ['title', 'slug', 'excerpt', 'content', 'coverImage', 'category', 'branchId', 'author', 'isPublished', 'publishedAt'];
    const payload = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });
    if (payload.branchId === '' || payload.branchId === undefined) payload.branchId = null;
    const news = await News.create(payload);
    res.status(201).json({ success: true, message: 'Tạo bài viết thành công', data: { news } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const allowed = ['title', 'slug', 'excerpt', 'content', 'coverImage', 'category', 'branchId', 'author', 'isPublished', 'publishedAt'];
    const payload = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });
    if (payload.branchId === '') payload.branchId = null;
    const news = await News.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!news) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { news } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const news = await News.findByIdAndDelete(req.params.id);
    if (!news) return res.status(404).json({ success: false, message: 'Không tìm thấy bài viết' });
    res.json({ success: true, message: 'Đã xoá bài viết' });
  } catch (err) { next(err); }
};

module.exports = { publicList, publicDetail, getAll, getOne, create, update, remove };