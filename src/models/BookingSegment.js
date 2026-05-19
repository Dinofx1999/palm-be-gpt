// backend/src/models/BookingSegment.js
//
// ⭐ v24 (19/05/2026): Schema GỌN
//   Segment chỉ chứa METADATA (room, time, mode, transferFee).
//   KHÔNG lưu amount/breakdown — mọi lúc compute qua segmentBill.computeBill().
//
//   Lý do: tránh bug DB stale, recompute từ source of truth (policy + time).

'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * 5 transfer modes:
 *   INITIAL_CHECKIN — segment đầu tiên (lúc create booking)
 *   KEEP_OLD_RATE   — Phòng mới giữ giá phòng cũ (lỗi KS)
 *   USE_NEW_RATE    — Phòng mới dùng dayPrice của phòng mới (upgrade/downgrade)
 *   HOURLY_NEW_ROOM — Phòng mới tính giờ (gần CO, không qua đêm)
 *   FREE            — Phòng mới 0đ (compensate)
 */
const TRANSFER_MODES = Object.freeze({
  INITIAL_CHECKIN: 'INITIAL_CHECKIN',
  KEEP_OLD_RATE:   'KEEP_OLD_RATE',
  USE_NEW_RATE:    'USE_NEW_RATE',
  HOURLY_NEW_ROOM: 'HOURLY_NEW_ROOM',
  FREE:            'FREE',
});

const SEGMENT_STATUSES = Object.freeze({
  ACTIVE:    'active',
  CLOSED:    'closed',
  CANCELLED: 'cancelled',
});

// ──────────────── Sub-schema: BookingSegment ────────────────
const BookingSegmentSchema = new Schema(
  {
    // ─── Identification ──────────────────────────────
    sequenceNumber: { type: Number, required: true },  // 1, 2, 3... thứ tự

    // ─── Room ────────────────────────────────────────
    roomId:     { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    roomNumber: { type: String, required: true },
    roomType:   { type: String, default: '' },
    typeId:     { type: Schema.Types.ObjectId, ref: 'RoomType' },

    // ─── Time range ──────────────────────────────────
    startAt: { type: Date, required: true },
    endAt:   { type: Date, default: null },        // null = segment đang active

    // ─── Policy reference ────────────────────────────
    policyId:   { type: Schema.Types.ObjectId, ref: 'PricePolicy' },
    policyName: { type: String, default: '' },

    // ─── Transfer info ───────────────────────────────
    transferMode: {
      type: String,
      enum: Object.values(TRANSFER_MODES),
      default: TRANSFER_MODES.INITIAL_CHECKIN,
    },
    transferReason: { type: String, default: '', maxlength: 500 },
    transferFee:    { type: Number, default: 0, min: 0 },

    // ─── Audit ───────────────────────────────────────
    createdBy:     { type: Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
    createdAt:     { type: Date, default: Date.now },
    closedBy:      { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt:      { type: Date, default: null },

    // ─── Status ──────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(SEGMENT_STATUSES),
      default: SEGMENT_STATUSES.ACTIVE,
    },

    // ─── Flag bồi thường (cho mode FREE) ─────────────
    isCompensation: { type: Boolean, default: false },
  },
  { _id: true },
);

// ──────────────── Helpers exported (cho controller dùng) ────────────────

/**
 * Build initial segment khi tạo booking mới.
 */
function buildInitialSegment({ room, startAt, policy, userId, userName }) {
  return {
    sequenceNumber: 1,
    roomId:     room._id,
    roomNumber: room.number,
    roomType:   room.typeName || room.typeId?.name || '',
    typeId:     room.typeId?._id || room.typeId,
    startAt:    new Date(startAt),
    endAt:      null,
    policyId:   policy?._id || null,
    policyName: policy?.name || '',
    transferMode: TRANSFER_MODES.INITIAL_CHECKIN,
    transferReason: '',
    transferFee: 0,
    createdBy:   userId || null,
    createdByName: userName || '',
    createdAt: new Date(),
    status: SEGMENT_STATUSES.ACTIVE,
    isCompensation: false,
  };
}

/**
 * Get active segment (status='active' && endAt=null)
 */
function getActiveSegment(booking) {
  const segs = booking?.segments || [];
  return segs.find(s => s.status === SEGMENT_STATUSES.ACTIVE && !s.endAt) || null;
}

/**
 * Get segments sorted by sequenceNumber
 */
function getOrderedSegments(booking) {
  return [...(booking?.segments || [])]
    .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
}

/**
 * Get next sequence number for new segment
 */
function getNextSequenceNumber(booking) {
  const segs = booking?.segments || [];
  if (segs.length === 0) return 1;
  return Math.max(...segs.map(s => s.sequenceNumber || 0)) + 1;
}

/**
 * Tổng transferFees của booking (cho summary)
 */
function totalTransferFees(booking) {
  return (booking?.segments || [])
    .filter(s => s.status !== SEGMENT_STATUSES.CANCELLED &&
                 s.transferMode !== TRANSFER_MODES.INITIAL_CHECKIN)
    .reduce((sum, s) => sum + (s.transferFee || 0), 0);
}

module.exports = {
  BookingSegmentSchema,
  TRANSFER_MODES,
  SEGMENT_STATUSES,
  buildInitialSegment,
  getActiveSegment,
  getOrderedSegments,
  getNextSequenceNumber,
  totalTransferFees,
};