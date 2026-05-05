const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { uploadDir } = require('../middleware/upload');

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

module.exports = { uploadRoomImages, deleteRoomImage };