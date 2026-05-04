const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'luxstay-secret-2025';

const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader)
      return res.status(401).json({ success: false, message: 'Không có token xác thực' });

    const token   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = {
      id:       decoded.id,
      username: decoded.username,
      role:     decoded.role,
      branchId: decoded.branchId,
    };

    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token hết hạn hoặc không hợp lệ' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user)
    return res.status(401).json({ success: false, message: 'Chưa xác thực' });
  if (!roles.includes(req.user.role))
    return res.status(403).json({ success: false, message: `Không có quyền. Yêu cầu: ${roles.join(', ')}` });
  next();
};

module.exports = { authenticate, authorize, JWT_SECRET };
