const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadRoomImages, deleteRoomImage } = require('../controllers/uploadController');

// POST /api/upload/rooms — upload tối đa 10 ảnh
router.post('/rooms', authenticate, upload.array('images', 10), uploadRoomImages);

// DELETE /api/upload/rooms/:filename
router.delete('/rooms/:filename', authenticate, deleteRoomImage);

module.exports = router;