const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { uploadDir } = require('../middleware/upload');
// Thư mục lưu avatar — tạo nếu chưa có
const avatarDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(avatarDir)) {
  fs.mkdirSync(avatarDir, { recursive: true });
}
const displayDir = path.join(__dirname, '../../uploads/display');
if (!fs.existsSync(displayDir)) fs.mkdirSync(displayDir, { recursive: true });
// ── Upload nhiều ảnh ───────────────────────────
const uploadRoomImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'Không có file' });
    }

    const urls = [];
    for (const file of req.files) {
      // Tên file unique: timestamp-random.webp
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
      const filepath = path.join(uploadDir, filename);

      // ⭐ Sharp: resize max 1600px, convert WEBP, quality 82
      await sharp(file.buffer)
        .rotate() // tự động xoay theo EXIF
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(filepath);

      // URL trả về cho FE
      const url = `${req.protocol}://${req.get('host')}/uploads/rooms/${filename}`;
      urls.push(url);
    }

    res.json({ success: true, data: { urls } });
  } catch (err) {
    next(err);
  }
};

// ── Xoá 1 ảnh (cleanup) ────────────────────────
const deleteRoomImage = async (req, res, next) => {
  try {
    const { filename } = req.params;
    // ⭐ Bảo mật: chặn path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ success: false, message: 'Tên file không hợp lệ' });
    }
    const filepath = path.join(uploadDir, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      return res.json({ success: true, message: 'Đã xoá ảnh' });
    }
    res.status(404).json({ success: false, message: 'File không tồn tại' });
  } catch (err) {
    next(err);
  }
};
// POST /api/upload/avatar — upload 1 ảnh đại diện

 
// POST /api/upload/avatar — upload 1 ảnh đại diện (field "file")
const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: 'Không có file được tải lên' });
 
    // Tên file duy nhất
    const filename = `avatar-${req.user.id}-${Date.now()}.webp`;
    const filePath = path.join(avatarDir, filename);
 
    // Resize vuông 400x400, nén webp — xử lý từ buffer trong RAM
    await sharp(req.file.buffer)
      .resize(400, 400, { fit: 'cover', position: 'center' })
      .webp({ quality: 85 })
      .toFile(filePath);
 
    // ⚠️ url phải khớp với cách express phục vụ static.
    //   Xem controller rooms build url thế nào → làm y hệt phần domain/prefix.
    const url = `/uploads/avatars/${filename}`;
 
    res.json({ success: true, data: { url } });
  } catch (err) { next(err); }
};
 
// DELETE /api/upload/avatar/:filename — (tùy chọn) xoá ảnh cũ
const deleteAvatar = async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename); // chặn path traversal
    const filePath = path.join(avatarDir, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Đã xoá ảnh' });
  } catch (err) { next(err); }
};

const uploadDisplayMedia = async (req, res, next) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: 'Không có file được tải lên' });
 
    const base = `${req.protocol}://${req.get('host')}`;   // URL đầy đủ (màn phụ ở port khác vẫn load được)
    const isVideo = (req.file.mimetype || '').startsWith('video');
    const rand = Math.random().toString(36).slice(2, 8);
 
    if (isVideo) {
      // Video: lưu nguyên buffer, giữ đuôi gốc
      const ext = (req.file.originalname.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
      const filename = `disp-${Date.now()}-${rand}.${ext || 'mp4'}`;
      fs.writeFileSync(path.join(displayDir, filename), req.file.buffer);
      return res.json({ success: true, data: { url: `${base}/uploads/display/${filename}`, type: 'video' } });
    }
 
    // Ảnh: tự xoay theo EXIF, resize max 1600, convert webp
    const filename = `disp-${Date.now()}-${rand}.webp`;
    await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(displayDir, filename));
    res.json({ success: true, data: { url: `${base}/uploads/display/${filename}`, type: 'image' } });
  } catch (err) { next(err); }
};
 
// ⭐ Thêm vào module.exports của uploadController.js:
// module.exports = { uploadRoomImages, deleteRoomImage, uploadAvatar, deleteAvatar };

module.exports = { uploadRoomImages, deleteRoomImage, uploadAvatar, deleteAvatar, uploadDisplayMedia };