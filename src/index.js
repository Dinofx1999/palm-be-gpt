//index.js
require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const path = require('path');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;

const { connect } = require('./config/database');
const { seedAdminIfEmpty } = require('./utils/seedAdmin');

// ── Middleware ─────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());

const allowedOrigins = [
  'https://palmhotel.com.vn',
  'https://www.palmhotel.com.vn',
  'http://localhost:5173',
  'http://192.168.1.33:5174',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Health check ───────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok', app: 'LuxStay PMS API', version: '2.8.0',
  timestamp: new Date().toISOString(),
}));

// ── Routes ────────────────────────────────────────────
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/rooms',             require('./routes/rooms'));
app.use('/api/bookings',          require('./routes/bookings'));
app.use('/api/customers',         require('./routes/customers'));
app.use('/api/services',          require('./routes/services'));
app.use('/api/service-categories', require('./routes/serviceCategoryRoutes'));  // ⭐ NEW 11/05/2026
app.use('/api/invoices',          require('./routes/invoices'));
app.use('/api/dashboard',         require('./routes/dashboard'));
app.use('/api/users',             require('./routes/users'));
app.use('/api/branches',          require('./routes/branche'));
app.use('/api/room-types',        require('./routes/roomTypes'));
app.use('/api/floors',            require('./routes/floors'));
app.use('/api/price-configs',     require('./routes/priceConfigs'));
app.use('/api/payment-methods',   require('./routes/paymentMethods'));
app.use('/api/amenities',         require('./routes/amenities'));
app.use('/api/price-policies',    require('./routes/pricePolicies'));
app.use('/api/audit-logs',        require('./routes/auditLogs'));
app.use('/api/quotes',            require('./routes/quotes'));
app.use('/api/salary',            require('./routes/salaryy'));
app.use('/api/salary-advances',   require('./routes/salaryAdvanceRoutes'));  // ⭐ NEW 11/05/2026
app.use('/api/penalty',           require('./routes/penalty'));
app.use('/api/workshift',         require('./routes/workshift'));
app.use('/api/attendance',        require('./routes/attendance'));
app.use('/api/admin',             require('./routes/device-security'));
app.use('/api/chat',              require('./routes/chat'));

// ⭐ NEW 13/05/2026: AI Chat Feedback + Few-shot management
app.use('/api',                   require('./routes/chatFeedback'));

// ⭐ NEW 14/05/2026: AI Chat History — lưu/load lịch sử chat từ MongoDB
app.use('/api/chat-history',      require('./routes/chatHistory'));

// ⭐ NEW 12/05/2026: Module Tuyển dụng (Careers)
app.use('/api/job-postings',      require('./routes/jobPostingRoutes'));
app.use('/api/job-applications',  require('./routes/jobApplicationRoutes'));
app.use('/api/public/careers',    require('./routes/publicCareersRoutes'));

// ⭐ NEW 13/05/2026: Module Quy trình Nhân viên
app.use('/api/procedures',        require('./routes/procedureRoutes'));

// ─────────────────────────────────────────────────────
// ⭐ NEW 14/05/2026: Module Tài chính (Thu/Chi + Bàn giao ca + Đối soát)
//   - /api/transactions:    Thu/Chi (CRUD, filter, summary)
//   - /api/profit:          Báo cáo lợi nhuận (P&L)
//   - /api/shifts:          Bàn giao ca (open/close/handover)
//   - /api/reconciliations: Đối soát thu chi (daily/weekly/monthly)
// ─────────────────────────────────────────────────────
app.use('/api/transactions',     require('./routes/transactions'));
app.use('/api/profit',           require('./routes/profit'));
app.use('/api/shifts',           require('./routes/shifts'));
app.use('/api/reconciliations',  require('./routes/reconciliation'));

// Static serve folder uploads
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, '../uploads')));

app.use('/api/upload', require('./routes/upload'));

// ── Error handling ─────────────────────────────────────
const { errorHandler, notFound } = require('./middleware/helpers');
app.use(notFound);
app.use(errorHandler);

// ── Start ──────────────────────────────────────────────
(async () => {
  try {
    await connect();
    await seedAdminIfEmpty();

    app.listen(PORT, () => {
      console.log(`\n🏨  LuxStay PMS API  →  http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('❌  Không thể khởi động server:', err);
    process.exit(1);
  }
})();