const AuditLog = require('../models/AuditLog');

/**
 * Ghi audit log. Gọi từ controller sau khi thực hiện action.
 *
 * @param {Object} params
 * @param {string} params.entityType   - 'Booking' | 'Invoice' | ...
 * @param {ObjectId} params.entityId
 * @param {string} params.action       - vd 'create', 'checkin', 'add_service'
 * @param {string} params.description  - Mô tả ngắn cho user đọc
 * @param {Object} params.user         - req.user (có id, name, email)
 * @param {Object} [params.metadata]   - Context bổ sung
 * @param {Object} [params.before]     - Snapshot trước khi thay đổi
 * @param {Object} [params.after]      - Snapshot sau khi thay đổi
 * @param {ObjectId} [params.branchId]
 *
 * KHÔNG throw lỗi — log thất bại không nên crash flow chính
 */
async function logAction(params) {
  try {
    const {
      entityType, entityId, action, description = '',
      user = {}, metadata = {}, before = null, after = null, branchId = null,
    } = params

    if (!entityType || !entityId || !action) {
      console.warn('[AuditLog] missing required fields', params)
      return
    }

    await AuditLog.create({
      entityType,
      entityId,
      action,
      description,
      userId:    user?.id  ?? user?._id ?? null,
      userName:  user?.fullName ?? user?.username ?? '',
      userEmail: user?.email ?? '',
      metadata,
      before,
      after,
      branchId,
    })
  } catch (err) {
  console.error('[AuditLog] failed to log:', err)
  if (err?.errors) console.error('[AuditLog] details:', JSON.stringify(err.errors, null, 2))
}
}


module.exports = { logAction };