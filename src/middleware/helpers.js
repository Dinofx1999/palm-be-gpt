// ═══════════════════════════════════════════════════════════════
// Express middleware helpers: notFound + errorHandler
//
// QUAN TRỌNG: file này được mount ở app.js theo thứ tự:
//   1. ...routes
//   2. app.use(notFound)
//   3. app.use(errorHandler)
// Bất kỳ controller nào gọi `next(err)` đều fall vào errorHandler.
// ═══════════════════════════════════════════════════════════════

// ── 404 — endpoint không tồn tại ──
const notFound = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Endpoint không tồn tại: ${req.method} ${req.originalUrl}`,
  });
};

// ── Global error handler ──
// Phải có signature 4 tham số (err, req, res, next) để Express nhận biết
const errorHandler = (err, req, res, next) => {
  // Log đầy đủ vào terminal BE
  console.error('═══════════════════════════════════════════════');
  console.error('[GlobalError]', req.method, req.originalUrl);
  console.error('  Message:', err.message);
  console.error('  Name:   ', err.name);
  if (err.code)   console.error('  Code:   ', err.code);
  if (err.errors) console.error('  Errors: ', JSON.stringify(err.errors, null, 2));
  console.error('  Stack:  ', err.stack);
  console.error('═══════════════════════════════════════════════');

  // Mongoose ValidationError
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Dữ liệu không hợp lệ',
      errors: Object.fromEntries(
        Object.entries(err.errors).map(([k, v]) => [k, v.message])
      ),
    });
  }

  // Mongoose CastError (vd: invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: `${err.path} không hợp lệ: ${err.value}`,
    });
  }

  // MongoDB duplicate key (E11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `Trùng giá trị "${field}". Vui lòng thử lại.`,
      field,
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token hết hạn' });
  }

  // Default 500
  res.status(err.status || err.statusCode || 500).json({
    success: false,
    message: err.message || 'Lỗi server',
    error:   err.message,
  });
};

module.exports = { notFound, errorHandler };