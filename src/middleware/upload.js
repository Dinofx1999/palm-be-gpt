const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Đảm bảo folder uploads tồn tại ─────────────
const uploadDir = path.join(__dirname, '../../uploads/rooms');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ── Multer: nhận vào memory rồi sharp xử lý ────
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp/;
  const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mime = allowedTypes.test(file.mimetype);
  if (ext && mime) cb(null, true);
  else cb(new Error('Chỉ chấp nhận ảnh JPG, PNG, WEBP'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB/file (trước khi resize)
});

module.exports = { upload, uploadDir };