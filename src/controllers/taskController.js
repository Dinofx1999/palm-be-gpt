// backend/src/controllers/taskController.js
const Task    = require('../models/Task');
const Booking = require('../models/Booking');
const User    = require('../models/User');

/**
 * Lấy tên đầy đủ (fullName) của user đang đăng nhập.
 *   req.user thường chỉ có { id, username, role } (KHÔNG có fullName),
 *   nên query User từ DB để lấy fullName. Fallback username/email nếu thiếu.
 */
async function resolveUserName(reqUser) {
  if (!reqUser) return '';
  // Nếu token đã có sẵn fullName thì dùng luôn (khỏi query)
  if (reqUser.fullName) return reqUser.fullName;
  const uid = reqUser.id || reqUser._id;
  if (!uid) return reqUser.username || reqUser.email || '';
  try {
    const u = await User.findById(uid).select('fullName username email').lean();
    return (u?.fullName || u?.username || u?.email || reqUser.username || '') ?? '';
  } catch {
    return reqUser.username || reqUser.email || '';
  }
}

/**
 * GET /tasks
 *   Query:
 *     - bookingId : lấy task của 1 booking (cho BookingDetailDrawer)
 *     - branchId  : lọc theo chi nhánh (cho chuông header)
 *     - status    : 'pending' (chưa xong) | 'done' | 'all' (mặc định 'all')
 *   Sắp xếp: chưa xong trước, mới nhất trước.
 */
const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.bookingId) filter.bookingId = req.query.bookingId;
    if (req.query.branchId)  filter.branchId  = req.query.branchId;
    if (req.query.status === 'pending') filter.done = false;
    else if (req.query.status === 'done') filter.done = true;

    // ⭐ Lọc theo HẠN HOÀN THÀNH (dueAt): today | tomorrow | week
    //   Mốc ngày tính theo giờ server (Asia/Ho_Chi_Minh).
    const due = req.query.due;
    if (due === 'today' || due === 'tomorrow' || due === 'week') {
      const now = new Date();
      const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
      let from, to;
      if (due === 'today') {
        from = startOfToday;
        to   = new Date(startOfToday); to.setDate(to.getDate() + 1);
      } else if (due === 'tomorrow') {
        from = new Date(startOfToday); from.setDate(from.getDate() + 1);
        to   = new Date(from);         to.setDate(to.getDate() + 1);
      } else { // week: từ đầu hôm nay đến hết Chủ Nhật tuần này (T2 = đầu tuần)
        const dow = (startOfToday.getDay() + 6) % 7; // 0 = Thứ 2
        from = startOfToday;
        to   = new Date(startOfToday); to.setDate(to.getDate() + (7 - dow));
      }
      filter.dueAt = { $gte: from, $lt: to };
    }

    // Sắp xếp: chưa xong trước, rồi theo HẠN gần nhất trước, rồi mới tạo trước.
    const data = await Task.find(filter).sort({ done: 1, dueAt: 1, createdAt: -1 });
    const pending = data.filter(t => !t.done).length;
    res.json({ success: true, data: { data, total: data.length, pending } });
  } catch (err) { next(err); }
};

/**
 * POST /tasks
 *   Body: { title, bookingId? , branchId? }
 *   Nếu có bookingId → tự lấy bookingCode/roomNumber/branchId từ booking.
 */
const create = async (req, res, next) => {
  try {
    const { title, bookingId = null, dueAt = null } = req.body;
    if (!title || !String(title).trim())
      return res.status(400).json({ success: false, message: 'Thiếu tiêu đề công việc' });
    // ⭐ Hạn hoàn thành BẮT BUỘC
    if (!dueAt) return res.status(400).json({ success: false, message: 'Thiếu hạn hoàn thành' });
    const dueDate = new Date(dueAt);
    if (isNaN(dueDate.getTime()))
      return res.status(400).json({ success: false, message: 'Hạn hoàn thành không hợp lệ' });

    const payload = {
      title:         String(title).trim(),
      bookingId:     bookingId || null,
      branchId:      req.body.branchId || null,
      dueAt:         dueDate,
      createdBy:     req.user?.id ?? req.user?._id ?? null,
      createdByName: await resolveUserName(req.user),
    };

    // Nếu gắn booking → lấy thông tin hiển thị nhanh + branchId từ booking
    if (bookingId) {
      const bk = await Booking.findById(bookingId).select('bookingCode roomNumber branchId').lean();
      if (bk) {
        payload.bookingCode = bk.bookingCode ?? '';
        payload.roomNumber  = bk.roomNumber ?? '';
        if (!payload.branchId) payload.branchId = bk.branchId ?? null;
      }
    }

    const task = await Task.create(payload);
    res.status(201).json({ success: true, message: 'Đã thêm công việc', data: { task } });
  } catch (err) { next(err); }
};

/**
 * PATCH /tasks/:id/toggle
 *   Đổi trạng thái done ↔ chưa done. Ghi lại người + thời điểm hoàn thành.
 */
const toggle = async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Không tìm thấy công việc' });

    task.done = !task.done;
    if (task.done) {
      task.doneBy     = req.user?.id ?? req.user?._id ?? null;
      task.doneByName = await resolveUserName(req.user);
      task.doneAt     = new Date();
    } else {
      task.doneBy = null; task.doneByName = ''; task.doneAt = null;
    }
    await task.save();
    res.json({ success: true, message: task.done ? 'Đã hoàn thành' : 'Đã mở lại', data: { task } });
  } catch (err) { next(err); }
};

/**
 * PATCH /tasks/:id  — sửa tiêu đề
 */
const update = async (req, res, next) => {
  try {
    const payload = {};
    if (req.body.title !== undefined) payload.title = String(req.body.title).trim();
    if (req.body.dueAt !== undefined) {
      const d = new Date(req.body.dueAt);
      if (!isNaN(d.getTime())) payload.dueAt = d;
    }
    const task = await Task.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!task) return res.status(404).json({ success: false, message: 'Không tìm thấy công việc' });
    res.json({ success: true, message: 'Đã cập nhật', data: { task } });
  } catch (err) { next(err); }
};

/**
 * DELETE /tasks/:id
 */
const remove = async (req, res, next) => {
  try {
    // ⭐ NEW 25/05/2026: Chỉ Admin/Manager được xoá task.
    const role = String(req.user?.role || '').toLowerCase().trim();
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Chỉ Admin/Manager được xoá công việc' });
    }
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Không tìm thấy công việc' });
    res.json({ success: true, message: 'Đã xoá công việc' });
  } catch (err) { next(err); }
};

module.exports = { getAll, create, toggle, update, remove };