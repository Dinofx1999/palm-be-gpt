const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const {
  uploadRoomImages, deleteRoomImage,
  uploadAvatar, deleteAvatar,   // ⭐ NEW
} = require('../controllers/uploadController');

// POST /api/upload/rooms — upload tối đa 10 ảnh
router.post('/rooms', authenticate, upload.array('images', 10), uploadRoomImages);
router.delete('/rooms/:filename', authenticate, deleteRoomImage);

// ⭐ NEW: POST /api/upload/avatar — upload 1 ảnh, field tên "file"
router.post('/avatar', authenticate, upload.single('file'), uploadAvatar);
router.delete('/avatar/:filename', authenticate, deleteAvatar);

module.exports = router;