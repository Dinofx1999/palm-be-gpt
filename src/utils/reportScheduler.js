// backend/src/utils/reportScheduler.js
// ════════════════════════════════════════════════════════════════════
// Lập lịch + GỬI BÁO CÁO DOANH THU CHI TIẾT theo từng chi nhánh (cron).
//   - Báo cáo NGÀY: chỉ số + so sánh hôm qua + biểu đồ 7 ngày gần nhất + top khoản.
//   - Báo cáo THÁNG: chỉ số + so sánh 6 tháng + biểu đồ cột/đường + top danh mục.
//   Biểu đồ render bằng QuickChart (ảnh PNG qua URL) vì email không chạy JS.
//
// ⚠️ CÀI: npm i node-cron
// ════════════════════════════════════════════════════════════════════
const cron = require('node-cron');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const SystemSetting = require('../models/SystemSetting');
const { getSettings } = require('../controllers/settingsController');

const TZ = 'Asia/Ho_Chi_Minh';
let _jobs = [];

const fmtMoney  = (v) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(v) || 0))}đ`;
const fmtShort  = (v) => {                       // rút gọn cho nhãn trục: 1.2tr, 850k
  const n = Math.abs(Number(v) || 0);
  if (n >= 1e9) return `${(v/1e9).toFixed(1)}tỷ`;
  if (n >= 1e6) return `${(v/1e6).toFixed(1)}tr`;
  if (n >= 1e3) return `${Math.round(v/1e3)}k`;
  return String(Math.round(v||0));
};
const pct = (cur, prev) => {
  if (!prev) return cur ? { txt: 'mới', up: true } : { txt: '0%', up: true };
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  return { txt: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%`, up: d >= 0 };
};

// ── QuickChart: build URL ảnh biểu đồ từ cấu hình Chart.js ───────────
//   Trả URL PNG; nhúng trực tiếp <img src=...> trong email.
function chartUrl(config, w = 600, h = 280) {
  const c = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?w=${w}&h=${h}&bkg=white&c=${c}`;
}

// ── Tổng hợp 1 chi nhánh trong [start, end) ──────────────────────────
async function aggregateRevenue(branchId, start, end) {
  const match = {
    occurredOn: { $gte: start, $lt: end },
    isCancelled: { $ne: true },
    branchId: new mongoose.Types.ObjectId(branchId),
  };
  const [totals, cats] = await Promise.all([
    Transaction.aggregate([
      { $match: match },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: match },
      { $group: { _id: { type: '$type', category: '$category' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),
  ]);
  let income = 0, expense = 0, incomeCount = 0, expenseCount = 0;
  for (const r of totals) {
    if (r._id === 'income')  { income  = r.total; incomeCount  = r.count; }
    if (r._id === 'expense') { expense = r.total; expenseCount = r.count; }
  }
  return {
    income, expense, net: income - expense, incomeCount, expenseCount,
    breakdown: cats.map(c => ({ type: c._id.type, category: c._id.category, total: c.total, count: c.count })),
  };
}

// Doanh thu theo từng ngày trong N ngày gần nhất (tính tới ngày `endBase`, gồm endBase)
async function dailySeries(branchId, endBase, days) {
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endBase);
    d.setDate(d.getDate() - i);
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const r = await aggregateRevenue(branchId, s, e);
    series.push({
      label: `${String(s.getDate()).padStart(2,'0')}/${String(s.getMonth()+1).padStart(2,'0')}`,
      income: r.income, expense: r.expense, net: r.net,
    });
  }
  return series;
}

// Doanh thu theo từng tháng trong N tháng gần nhất (gồm tháng chứa `endBase`)
async function monthlySeries(branchId, endBase, months) {
  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const s = new Date(endBase.getFullYear(), endBase.getMonth() - i, 1);
    const e = new Date(endBase.getFullYear(), endBase.getMonth() - i + 1, 1);
    const r = await aggregateRevenue(branchId, s, e);
    series.push({
      label: `T${s.getMonth()+1}/${String(s.getFullYear()).slice(-2)}`,
      income: r.income, expense: r.expense, net: r.net,
    });
  }
  return series;
}

// ── Component HTML nhỏ ───────────────────────────────────────────────
function kpiCards(data, cmp) {
  const card = (label, value, color, bg, sub) => `
    <td style="padding:6px;">
      <div style="background:${bg};border-radius:10px;padding:12px 14px;">
        <div style="font-size:12px;color:#64748B;">${label}</div>
        <div style="font-size:19px;font-weight:800;color:${color};line-height:1.3;">${value}</div>
        ${sub ? `<div style="font-size:11px;color:${sub.up ? '#10B981' : '#EF4444'};font-weight:600;margin-top:2px;">${sub.txt}</div>` : ''}
      </div>
    </td>`;
  return `
    <table style="width:100%;border-collapse:collapse;margin:8px 0;"><tr>
      ${card('Tổng thu', fmtMoney(data.income), '#10B981', '#ECFDF5', cmp?.income)}
      ${card('Tổng chi', fmtMoney(data.expense), '#EF4444', '#FEF2F2', cmp?.expense)}
      ${card('Thực thu', fmtMoney(data.net), '#0B76EF', '#EFF6FF', cmp?.net)}
    </tr></table>`;
}

function topTable(title, rows, color) {
  if (!rows.length) return '';
  const body = rows.slice(0, 6).map(r => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;">${r.category}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;text-align:center;color:#94A3B8;font-size:12px;">${r.count}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;text-align:right;color:${color};font-weight:600;">${fmtMoney(r.total)}</td>
    </tr>`).join('');
  return `
    <h4 style="margin:14px 0 4px;font-size:14px;">${title}</h4>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#F8FAFC;">
        <th style="padding:6px 12px;text-align:left;color:#64748B;font-weight:600;">Danh mục</th>
        <th style="padding:6px 12px;text-align:center;color:#64748B;font-weight:600;">SL</th>
        <th style="padding:6px 12px;text-align:right;color:#64748B;font-weight:600;">Số tiền</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function shell(branchName, title, periodLabel, inner) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1E293B;background:#fff;">
    <div style="background:linear-gradient(135deg,#0B76EF,#1E40AF);padding:20px 24px;border-radius:12px 12px 0 0;">
      <div style="color:#BFDBFE;font-size:13px;">${branchName}</div>
      <div style="color:#fff;font-size:22px;font-weight:800;">${title}</div>
      <div style="color:#DBEAFE;font-size:13px;margin-top:2px;">Kỳ báo cáo: ${periodLabel}</div>
    </div>
    <div style="padding:16px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px;">
      ${inner}
      <p style="color:#94A3B8;font-size:11px;margin-top:20px;border-top:1px solid #F1F5F9;padding-top:10px;">
        Email tự động từ LuxHotel PMS · ${new Date().toLocaleString('vi-VN', { timeZone: TZ })}
      </p>
    </div>
  </div>`;
}

async function branchName(branchId) {
  try {
    const Branch = require('../models/Branch');
    const b = await Branch.findById(branchId).select('name').lean();
    return b?.name || 'Chi nhánh';
  } catch { return 'Chi nhánh'; }
}

// ════════════════════════════════════════════════════════════════════
// BÁO CÁO NGÀY
// ════════════════════════════════════════════════════════════════════
async function sendDailyReport(branchId, coversYesterday) {
  const { sendMail } = require('./mailer');
  const { reports } = await getSettings(branchId);
  const to = (reports?.recipients || []).filter(Boolean);
  if (to.length === 0) { console.warn(`[report] (ngày) ${branchId}: chưa có người nhận`); return; }

  const now = new Date();
  const base = new Date(now);
  if (coversYesterday) base.setDate(base.getDate() - 1);
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const dayEnd   = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  const prevStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1);

  const [data, prev, series, name] = await Promise.all([
    aggregateRevenue(branchId, dayStart, dayEnd),
    aggregateRevenue(branchId, prevStart, dayStart),
    dailySeries(branchId, base, 7),
    branchName(branchId),
  ]);

  const cmp = {
    income: pct(data.income, prev.income),
    expense: pct(data.expense, prev.expense),
    net: pct(data.net, prev.net),
  };

  // Biểu đồ cột thu/chi 7 ngày + đường thực thu
  const chart = chartUrl({
    type: 'bar',
    data: {
      labels: series.map(s => s.label),
      datasets: [
        { label: 'Thu',  backgroundColor: '#10B981', data: series.map(s => s.income) },
        { label: 'Chi',  backgroundColor: '#EF4444', data: series.map(s => s.expense) },
        { label: 'Thực thu', type: 'line', borderColor: '#0B76EF', backgroundColor: '#0B76EF', fill: false, data: series.map(s => s.net) },
      ],
    },
    options: {
      title: { display: true, text: 'Doanh thu 7 ngày gần nhất' },
      legend: { position: 'bottom' },
      scales: { yAxes: [{ ticks: { callback: (v) => fmtShort(v) } }] },
    },
  });

  const inner = `
    ${kpiCards(data, cmp)}
    <p style="font-size:13px;color:#64748B;margin:4px 0 0;">
      ${data.incomeCount} giao dịch thu · ${data.expenseCount} giao dịch chi · so với hôm trước: thực thu ${cmp.net.txt}
    </p>
    <div style="text-align:center;margin:16px 0;">
      <img src="${chart}" alt="Biểu đồ 7 ngày" width="600" style="max-width:100%;border-radius:8px;" />
    </div>
    ${topTable('Top khoản thu', data.breakdown.filter(b => b.type === 'income'), '#10B981')}
    ${topTable('Top khoản chi', data.breakdown.filter(b => b.type === 'expense'), '#EF4444')}
  `;

  const periodLabel = dayStart.toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
  const html = shell(name, 'Báo cáo doanh thu NGÀY', periodLabel, inner);

  await sendMail({ to: to.join(','), branchId, subject: `[${name}] Doanh thu ngày ${periodLabel}`, html });
  console.log(`[report] Đã gửi báo cáo ngày ${periodLabel} — ${name} → ${to.length} người`);
}

// ════════════════════════════════════════════════════════════════════
// BÁO CÁO THÁNG (tháng trước, so sánh 6 tháng)
// ════════════════════════════════════════════════════════════════════
async function sendMonthlyReport(branchId) {
  const { sendMail } = require('./mailer');
  const { reports } = await getSettings(branchId);
  const to = (reports?.recipients || []).filter(Boolean);
  if (to.length === 0) { console.warn(`[report] (tháng) ${branchId}: chưa có người nhận`); return; }

  const now = new Date();
  // Tháng trước (tháng báo cáo)
  const mStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const mEnd   = new Date(now.getFullYear(), now.getMonth(), 1);
  // Tháng liền trước nữa (để so sánh %)
  const pStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);

  const [data, prev, series, name] = await Promise.all([
    aggregateRevenue(branchId, mStart, mEnd),
    aggregateRevenue(branchId, pStart, mStart),
    monthlySeries(branchId, mStart, 6),     // 6 tháng tính tới tháng báo cáo
    branchName(branchId),
  ]);

  const cmp = {
    income: pct(data.income, prev.income),
    expense: pct(data.expense, prev.expense),
    net: pct(data.net, prev.net),
  };

  // Biểu đồ: cột thu & chi + đường thực thu qua 6 tháng
  const chart = chartUrl({
    type: 'bar',
    data: {
      labels: series.map(s => s.label),
      datasets: [
        { label: 'Thu', backgroundColor: '#10B981', data: series.map(s => s.income) },
        { label: 'Chi', backgroundColor: '#EF4444', data: series.map(s => s.expense) },
        { label: 'Thực thu', type: 'line', borderColor: '#0B76EF', backgroundColor: '#0B76EF', fill: false, data: series.map(s => s.net) },
      ],
    },
    options: {
      title: { display: true, text: 'So sánh 6 tháng gần nhất' },
      legend: { position: 'bottom' },
      scales: { yAxes: [{ ticks: { callback: (v) => fmtShort(v) } }] },
    },
  }, 600, 300);

  // Bảng so sánh tháng
  const cmpRows = series.map(s => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;">${s.label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;text-align:right;color:#10B981;">${fmtMoney(s.income)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;text-align:right;color:#EF4444;">${fmtMoney(s.expense)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #F1F5F9;text-align:right;font-weight:700;">${fmtMoney(s.net)}</td>
    </tr>`).join('');

  const inner = `
    ${kpiCards(data, cmp)}
    <p style="font-size:13px;color:#64748B;margin:4px 0 0;">
      ${data.incomeCount} giao dịch thu · ${data.expenseCount} giao dịch chi · so với tháng trước: thực thu ${cmp.net.txt}
    </p>
    <div style="text-align:center;margin:16px 0;">
      <img src="${chart}" alt="Biểu đồ 6 tháng" width="600" style="max-width:100%;border-radius:8px;" />
    </div>
    <h4 style="margin:14px 0 4px;font-size:14px;">Chi tiết 6 tháng</h4>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#F8FAFC;">
        <th style="padding:6px 12px;text-align:left;color:#64748B;">Tháng</th>
        <th style="padding:6px 12px;text-align:right;color:#64748B;">Thu</th>
        <th style="padding:6px 12px;text-align:right;color:#64748B;">Chi</th>
        <th style="padding:6px 12px;text-align:right;color:#64748B;">Thực thu</th>
      </tr></thead>
      <tbody>${cmpRows}</tbody>
    </table>
    ${topTable('Top khoản thu trong tháng', data.breakdown.filter(b => b.type === 'income'), '#10B981')}
    ${topTable('Top khoản chi trong tháng', data.breakdown.filter(b => b.type === 'expense'), '#EF4444')}
  `;

  const periodLabel = `Tháng ${mStart.getMonth() + 1}/${mStart.getFullYear()}`;
  const html = shell(name, 'Báo cáo doanh thu THÁNG', periodLabel, inner);

  await sendMail({ to: to.join(','), branchId, subject: `[${name}] Doanh thu ${periodLabel}`, html });
  console.log(`[report] Đã gửi báo cáo ${periodLabel} — ${name} → ${to.length} người`);
}

const parseTime = (t, defH, defM) => {
  const mm = /^(\d{1,2}):(\d{1,2})$/.exec(String(t || ''));
  if (!mm) return { h: defH, m: defM };
  return { h: Math.min(23, +mm[1]), m: Math.min(59, +mm[2]) };
};

// ── Khởi tạo / nạp lại lịch cron cho TẤT CẢ chi nhánh ────────────────
async function initReportSchedulers() {
  for (const j of _jobs) { try { j.stop(); } catch { /* ignore */ } }
  _jobs = [];

  let docs = [];
  try {
    docs = await SystemSetting.find({
      $or: [{ 'reports.daily.enabled': true }, { 'reports.monthly.enabled': true }],
    }).select('branchId reports').lean();
  } catch (e) {
    console.warn('[report] Không đọc được cấu hình báo cáo:', e.message);
    return;
  }

  for (const doc of docs) {
    const bid = String(doc.branchId);
    const rp = doc.reports || {};

    if (rp.daily?.enabled) {
      const { h, m } = parseTime(rp.daily.time, 22, 0);
      const job = cron.schedule(`${m} ${h} * * *`, () => {
        sendDailyReport(bid, !!rp.daily.coversYesterday)
          .catch(e => console.error(`[report] daily ${bid} error:`, e.message));
      }, { timezone: TZ });
      _jobs.push(job);
      console.log(`[report] Lịch NGÀY chi nhánh ${bid} lúc ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }

    if (rp.monthly?.enabled) {
      const { h, m } = parseTime(rp.monthly.time, 8, 0);
      const dom = Math.min(28, Math.max(1, Number(rp.monthly.dayOfMonth) || 1));
      const job = cron.schedule(`${m} ${h} ${dom} * *`, () => {
        sendMonthlyReport(bid).catch(e => console.error(`[report] monthly ${bid} error:`, e.message));
      }, { timezone: TZ });
      _jobs.push(job);
      console.log(`[report] Lịch THÁNG chi nhánh ${bid} ngày ${dom} lúc ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }
  }
  console.log(`[report] Đã lên ${_jobs.length} lịch báo cáo (toàn bộ chi nhánh).`);
}

module.exports = {
  initReportSchedulers,
  sendDailyReport,
  sendMonthlyReport,
  aggregateRevenue,
};