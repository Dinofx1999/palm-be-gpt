// backend/src/models/Task.js
const mongoose = require('mongoose');

/**
 * Task — "Việc cần làm" trong khách sạn.
 *   2 loại:
 *     - Task GẮN BOOKING (bookingId có giá trị): vd "Viết hoá đơn", "Dọn phòng 302".
 *       → Hiển thị trong BookingDetailDrawer + chuông header.
 *     - Task CHUNG (bookingId = null): vd "Dọn vệ sinh khu lễ tân", "Kiểm tra kho".
 *       → Chỉ hiển thị trên chuông header.
 *   Mọi nhân viên đều tạo / tick xong được.
 */
const taskSchema = new mongoose.Schema({
  // Task thuộc chi nhánh nào (để chuông header lọc theo chi nhánh đang chọn)
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  title:       { type: String, required: true, trim: true },

  // null = task CHUNG; có giá trị = task gắn booking cụ thể
  bookingId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null, index: true },
  // Lưu kèm để hiển thị nhanh trên chuông header (khỏi populate)
  bookingCode: { type: String, default: '' },   // vd "BK_2N7NXK"
  roomNumber:  { type: String, default: '' },   // vd "302"

  // ⭐ Hạn hoàn thành (deadline) — ngày + giờ. BẮT BUỘC khi tạo.
  //   Khác với doneAt (thời điểm THỰC SỰ bấm hoàn thành).
  dueAt:       { type: Date, default: null, index: true },

  // Trạng thái hoàn thành
  done:        { type: Boolean, default: false, index: true },
  doneBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  doneByName:  { type: String, default: '' },
  doneAt:      { type: Date, default: null },

  // Người tạo
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByName: { type: String, default: '' },
}, { timestamps: true });

// Index phục vụ truy vấn chuông header: task chưa xong của chi nhánh, mới nhất trước.
taskSchema.index({ branchId: 1, done: 1, createdAt: -1 });
// Index phục vụ drawer: task của 1 booking.
taskSchema.index({ bookingId: 1, done: 1 });
// Index phục vụ lọc theo hạn hoàn thành.
taskSchema.index({ branchId: 1, dueAt: 1 });

module.exports = mongoose.model('Task', taskSchema);