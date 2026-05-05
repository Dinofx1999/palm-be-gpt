require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const path = require('path');
const app  = express();
const PORT = process.env.PORT || 4000;
const { connect } = require('./config/database');
connect();

// ── Middleware ─────────────────────────────────────────
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({
  origin: process.env.CLIENT_URL || ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Health check ───────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok', app: 'LuxStay PMS API', version: '2.6.0',
  timestamp: new Date().toISOString(),
}));

// ── Routes ─────────────────────────────────────────────
app.use('/api/auth',            require('./routes/auth'));
app.use('/api/rooms',           require('./routes/rooms'));
app.use('/api/bookings',        require('./routes/bookings'));
app.use('/api/customers',       require('./routes/customers'));
app.use('/api/services',        require('./routes/services'));
app.use('/api/invoices',        require('./routes/invoices'));
app.use('/api/dashboard',       require('./routes/dashboard'));
app.use('/api/users',           require('./routes/users'));
app.use('/api/branches',        require('./routes/branche'));
app.use('/api/room-types',      require('./routes/roomTypes'));
app.use('/api/floors',          require('./routes/floors'));
app.use('/api/price-configs',   require('./routes/priceConfigs'));
app.use('/api/payment-methods', require('./routes/paymentMethods'));
app.use('/api/amenities',       require('./routes/amenities'));
app.use('/api/price-policies',  require('./routes/pricePolicies'));
app.use('/api/audit-logs',      require('./routes/auditLogs'));   // ⭐ NEW
app.use('/api/quotes', require('./routes/quotes'));
// ⭐ THÊM: Static serve folder uploads
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, '../uploads')));

// ⭐ THÊM: Route upload
app.use('/api/upload', require('./routes/upload'));

// ── Error handling ─────────────────────────────────────
const { errorHandler, notFound } = require('./middleware/helpers');
app.use(notFound);
app.use(errorHandler);

// ── Start ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏨  LuxStay PMS API  →  http://localhost:${PORT}\n`);
});