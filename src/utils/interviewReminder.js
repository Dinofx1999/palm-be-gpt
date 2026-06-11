// backend/src/utils/interviewReminder.js
// ════════════════════════════════════════════════════════════════════
// Thông báo phỏng vấn cho module Tuyển dụng:
//   - sendInterviewConfirmation(app): gửi NGAY khi vừa lên lịch
//   - initInterviewReminderCron():    cron quét lịch sắp tới → nhắc trước giờ
//
// Kênh:
//   - Ứng viên  → email (nếu có email; không thì bỏ qua)
//   - Nhà tuyển dụng → Telegram kênh chi nhánh (nếu bật) + email Manager/Admin chi nhánh
// ════════════════════════════════════════════════════════════════════
const cron = require('node-cron');
const JobApplication = require('../models/JobApplication');
const JobPosting = require('../models/JobPosting');
const Branch = require('../models/Branch');
const User = require('../models/User');
const { sendMailSafe } = require('./mailer');

let tg = null;
try { tg = require('../controllers/telegramController'); } catch { tg = null; }

const fmtTime = (d) =>
  new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'full', timeStyle: 'short' });

// ── Lấy email Manager/Admin của chi nhánh (để báo nhà tuyển dụng) ──
async function getRecruiterEmails(branchId) {
  try {
    const users = await User.find({
      branchId,
      role: { $in: ['Admin', 'Manager'] },
      isActive: true,
      email: { $ne: '' },
    }).select('email').lean();
    return users.map((u) => u.email).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Build nội dung email cho ứng viên ──
function candidateEmailHtml({ fullName, jobTitle, branchName, interviewAt, location, isReminder }) {
  const heading = isReminder ? 'Nhắc lịch phỏng vấn' : 'Xác nhận lịch phỏng vấn';
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #eee;border-radius:12px;overflow:hidden">
    <div style="background:#7C3AED;color:#fff;padding:16px 20px;font-size:18px;font-weight:700">${heading}</div>
    <div style="padding:20px;color:#1f2937;font-size:15px;line-height:1.6">
      <p>Xin chào <b>${fullName}</b>,</p>
      <p>${isReminder ? 'Đây là lời nhắc cho buổi phỏng vấn sắp tới của bạn' : 'Bạn đã được mời phỏng vấn'} cho vị trí <b>${jobTitle || ''}</b>${branchName ? ` tại <b>${branchName}</b>` : ''}.</p>
      <div style="background:#F3E8FF;border-radius:10px;padding:14px 16px;margin:16px 0">
        <div>🕐 <b>Thời gian:</b> ${fmtTime(interviewAt)}</div>
        ${location ? `<div style="margin-top:6px">📍 <b>Địa điểm / ghi chú:</b> ${location}</div>` : ''}
      </div>
      <p>Vui lòng đến đúng giờ. Nếu cần thay đổi, hãy liên hệ lại với chúng tôi.</p>
      <p style="color:#6b7280;font-size:13px;margin-top:20px">Trân trọng,<br/>${branchName || 'Bộ phận tuyển dụng'}</p>
    </div>
  </div>`;
}

// ── Gửi 1 lần thông báo (dùng chung cho confirmation + reminder) ──
async function dispatchInterviewNotice(appId, { isReminder }) {
  const app = await JobApplication.findById(appId).lean();
  if (!app || !app.interviewAt) return;

  const job = app.jobPostingId
    ? await JobPosting.findById(app.jobPostingId).select('title position').lean()
    : null;
  const branch = app.branchId
    ? await Branch.findById(app.branchId).select('name').lean()
    : null;
  const jobTitle = job?.title || job?.position || 'Vị trí tuyển dụng';
  const branchName = branch?.name || '';

  // 1) Ứng viên (email, nếu có)
  if (app.email) {
    sendMailSafe({
      to: app.email,
      subject: `${isReminder ? '[Nhắc] ' : ''}Lịch phỏng vấn - ${jobTitle}`,
      html: candidateEmailHtml({
        fullName: app.fullName,
        jobTitle, branchName,
        interviewAt: app.interviewAt,
        location: app.interviewLocation,
        isReminder,
      }),
      branchId: app.branchId,
    });
  }

  // 2) Nhà tuyển dụng — Telegram (nếu bật cho hồ sơ này)
  if (app.interviewNotifyTelegram && tg && typeof tg.sendMessage === 'function') {
    const tgText =
      `📅 <b>${isReminder ? 'NHẮC phỏng vấn' : 'Lịch phỏng vấn mới'}</b>\n` +
      `👤 Ứng viên: <b>${app.fullName}</b> (${app.phone})\n` +
      `💼 Vị trí: ${jobTitle}\n` +
      `🕐 Thời gian: ${fmtTime(app.interviewAt)}\n` +
      (app.interviewLocation ? `📍 ${app.interviewLocation}\n` : '') +
      (app.email ? `✉️ ${app.email}` : '');
    tg.sendMessage(tgText, { branchId: app.branchId, parseMode: 'HTML' });
  }

  // 3) Nhà tuyển dụng — email Manager/Admin chi nhánh
  const recruiterEmails = await getRecruiterEmails(app.branchId);
  if (recruiterEmails.length > 0) {
    sendMailSafe({
      to: recruiterEmails.join(','),
      subject: `${isReminder ? '[Nhắc] ' : ''}Phỏng vấn: ${app.fullName} - ${jobTitle}`,
      html: `
        <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">
          <p><b>${isReminder ? 'Nhắc lịch phỏng vấn' : 'Lịch phỏng vấn mới được tạo'}</b></p>
          <ul>
            <li>Ứng viên: <b>${app.fullName}</b> (${app.phone}${app.email ? `, ${app.email}` : ''})</li>
            <li>Vị trí: ${jobTitle}</li>
            <li>Thời gian: <b>${fmtTime(app.interviewAt)}</b></li>
            ${app.interviewLocation ? `<li>Địa điểm/ghi chú: ${app.interviewLocation}</li>` : ''}
          </ul>
        </div>`,
      branchId: app.branchId,
    });
  }
}

// Public: gửi xác nhận NGAY khi lên lịch (non-blocking)
function sendInterviewConfirmation(appId) {
  dispatchInterviewNotice(appId, { isReminder: false })
    .catch((e) => console.error('[interviewReminder] confirmation error:', e.message));
}

// ── Cron: quét lịch sắp tới và nhắc ──
//   Điều kiện nhắc: status='interviewing', chưa gửi nhắc, có reminderMinutes>0,
//   và đang trong cửa sổ [interviewAt - reminderMinutes, interviewAt].
async function scanAndRemind() {
  const now = new Date();
  try {
    // Lấy các hồ sơ có lịch trong tương lai gần, chưa nhắc, có bật nhắc
    const candidates = await JobApplication.find({
      status: 'interviewing',
      interviewReminderSent: false,
      interviewAt: { $gte: now },
      interviewReminderMinutes: { $gt: 0 },
    }).select('_id interviewAt interviewReminderMinutes').lean();

    for (const c of candidates) {
      const remindAt = new Date(new Date(c.interviewAt).getTime() - c.interviewReminderMinutes * 60000);
      if (now >= remindAt) {
        // Đến giờ nhắc → gửi + đánh dấu (atomic để tránh gửi trùng nếu cron chồng)
        const upd = await JobApplication.findOneAndUpdate(
          { _id: c._id, interviewReminderSent: false },
          { $set: { interviewReminderSent: true } },
          { new: false }
        ).lean();
        if (upd && upd.interviewReminderSent === false) {
          await dispatchInterviewNotice(c._id, { isReminder: true });
        }
      }
    }
  } catch (e) {
    console.error('[interviewReminder] scan error:', e.message);
  }
}

function initInterviewReminderCron() {
  // chạy mỗi phút
  cron.schedule('* * * * *', scanAndRemind, { timezone: 'Asia/Ho_Chi_Minh' });
  console.log('⏰  Interview reminder cron started (mỗi phút)');
}

module.exports = { sendInterviewConfirmation, initInterviewReminderCron, scanAndRemind };