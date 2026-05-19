/**
 * ════════════════════════════════════════════════════════════════════════════
 * segmentCalculator.js — v24 (19/05/2026)
 *
 * THIN wrapper — chỉ còn `previewTransfer()` cho modal "Đổi phòng".
 *
 * Logic tính bill thật sự nằm trong `segmentBill.computeBill()`.
 * previewTransfer mô phỏng "nếu bấm chuyển" sẽ tạo segment mới như thế nào,
 * rồi gọi computeBill để tính total mới.
 * ════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const { computeBill, TRANSFER_MODES } = require('./segmentBill');

/**
 * Preview kết quả khi user bấm "Đổi phòng".
 *
 * @param {Object} input
 * @param {Object} input.booking — booking hiện tại (có segments[])
 * @param {Date}   input.transferAt — thời gian chuyển
 * @param {string} input.transferMode — KEEP_OLD_RATE | USE_NEW_RATE | HOURLY_NEW_ROOM | FREE
 * @param {number} input.transferFee — phí chuyển phòng
 * @param {string} input.transferReason
 * @param {Object} input.newRoom — { _id, number, typeName, typeId, etc. }
 * @param {Object} input.oldPolicy — policy phòng cũ
 * @param {Object} input.newPolicy — policy phòng mới
 * @param {Object} input.branch — { toleranceMinutes }
 * @param {number} input.paidAmount — số tiền đã thanh toán
 *
 * @returns {Object} {
 *   oldBill,         // bill hiện tại (chưa chuyển)
 *   newBill,         // bill nếu chuyển
 *   diff,            // newTotal - oldTotal
 *   refundNeeded,    // > 0 nếu paid > newTotal
 *   requiresRefund,
 *   warnings: [string],
 * }
 */
function previewTransfer({
  booking,
  transferAt,
  transferMode,
  transferFee = 0,
  transferReason = '',
  newRoom,
  oldPolicy,
  newPolicy,
  branch = {},
  paidAmount = 0,
}) {
  if (!Object.values(TRANSFER_MODES).includes(transferMode)) {
    throw new Error(`Invalid transferMode: ${transferMode}`);
  }
  if (transferMode === TRANSFER_MODES.INITIAL_CHECKIN) {
    throw new Error(`Cannot preview with INITIAL_CHECKIN mode`);
  }

  const activeSeg = (booking.segments || []).find(s => s.status === 'active' && !s.endAt);
  if (!activeSeg) {
    throw new Error('Booking không có active segment');
  }

  const tAt = new Date(transferAt);
  const warnings = [];

  // Validation: transferAt phải sau startAt của active segment
  if (tAt <= new Date(activeSeg.startAt)) {
    throw new Error('Thời gian chuyển phải sau giờ bắt đầu của segment hiện tại');
  }

  // Validation: transferAt phải trước plannedCheckOut
  if (tAt >= new Date(booking.checkOut)) {
    throw new Error('Thời gian chuyển phải trước giờ trả phòng dự kiến');
  }

  // ─── BILL HIỆN TẠI (chưa chuyển): segments giữ nguyên, effectiveCheckOut = plannedCO ───
  const policiesOld = {};
  // Build policiesBySegmentId từ booking hiện tại
  for (const seg of (booking.segments || [])) {
    if (String(seg._id) === String(activeSeg._id)) {
      policiesOld[String(seg._id)] = oldPolicy;
    } else {
      // Segment cũ closed dùng policy đã lưu (segment.policyId) — caller tự load nếu cần
      policiesOld[String(seg._id)] = seg._populatedPolicy || oldPolicy;
    }
  }
  const oldBill = computeBill({
    booking,
    policiesBySegmentId: policiesOld,
    branch,
    effectiveCheckOut: new Date(booking.checkOut),
  });

  // ─── BILL MỚI: mô phỏng "nếu bấm chuyển bây giờ" ───
  // Tạo bản copy booking.segments + đóng active + mở segment mới
  const simulatedSegments = (booking.segments || []).map(s => {
    const obj = s.toObject ? s.toObject() : { ...s };
    if (String(obj._id) === String(activeSeg._id)) {
      obj.endAt = tAt;
      obj.status = 'closed';
    }
    return obj;
  });

  const maxSeq = Math.max(...simulatedSegments.map(s => s.sequenceNumber || 0));
  const simulatedNewSeg = {
    _id: 'PREVIEW_NEW_SEG',  // fake ID cho computeBill
    sequenceNumber: maxSeq + 1,
    roomId: newRoom._id,
    roomNumber: newRoom.number,
    roomType: newRoom.typeName || newRoom.typeId?.name || '',
    typeId: newRoom.typeId?._id || newRoom.typeId,
    startAt: tAt,
    endAt: null,
    transferMode,
    transferReason: String(transferReason || '').slice(0, 500),
    transferFee: Math.max(0, Number(transferFee) || 0),
    status: 'active',
    policyId: newPolicy?._id || null,
    policyName: newPolicy?.name || '',
  };
  simulatedSegments.push(simulatedNewSeg);

  const policiesNew = { ...policiesOld };
  policiesNew[String(simulatedNewSeg._id)] = newPolicy;
  // KEEP_OLD_RATE: segmentBill cần policy "trước đó" = oldPolicy
  // (đã có sẵn vì simulatedNewSeg.sequenceNumber - 1 = activeSeg.sequenceNumber → policiesOld[activeSeg._id] = oldPolicy)

  const newBill = computeBill({
    booking: { ...booking, segments: simulatedSegments },
    policiesBySegmentId: policiesNew,
    branch,
    effectiveCheckOut: new Date(booking.checkOut),
  });

  // Warnings
  if (transferMode === TRANSFER_MODES.HOURLY_NEW_ROOM) {
    const hourlyLine = newBill.lines.find(l => l.meta?.hourly);
    if (!hourlyLine) {
      warnings.push('Mode HOURLY_NEW_ROOM được chọn nhưng không tìm thấy slot giờ phù hợp — đã fallback');
    }
  }
  if (transferMode === TRANSFER_MODES.FREE) {
    warnings.push('Mode FREE: phòng mới được miễn phí (compensate)');
  }

  // Diff vs paid
  const newTotalAmount = newBill.totals.grand;
  const oldTotalAmount = oldBill.totals.grand;
  const diff = newTotalAmount - oldTotalAmount;
  const remainingAmount = Math.max(0, newTotalAmount - paidAmount);
  const refundNeeded = Math.max(0, paidAmount - newTotalAmount);
  const requiresRefund = refundNeeded > 0;

  return {
    oldBill,
    newBill,
    simulatedNewSegment: {
      ...simulatedNewSeg,
      _id: undefined,  // bỏ fake ID
    },
    closedOldSegment: {
      _id: activeSeg._id,
      endAt: tAt,
      status: 'closed',
    },
    totals: {
      oldTotal: oldTotalAmount,
      newTotal: newTotalAmount,
      diff,
      paidAmount,
      remainingAmount,
      refundNeeded,
    },
    requiresRefund,
    warnings,
  };
}

module.exports = {
  previewTransfer,
  TRANSFER_MODES,
};