/**
 * ════════════════════════════════════════════════════════════════════════════
 * segmentBill.js — v24 (19/05/2026)
 *
 * MỘT function `computeBill()` tính TOÀN BỘ bill từ segments[].
 * Segment KHÔNG còn lưu amount — mọi lúc compute từ startAt + endAt + policy.
 *
 * SPEC (cực gọn):
 *   1. Mỗi ĐÊM tính theo PHÒNG khách NGỦ QUA đêm đó.
 *      (Probe = thời điểm GIỮA đêm — lúc khách thực sự ngủ)
 *
 *   2. Ranh giới giữa 2 đêm = `policy.dayCheckOutTime` của PHÒNG cuối ngày.
 *      (Phòng 201 có CO 12:00 → đêm dài 12:00 → 12:00 hôm sau)
 *      (Phòng 305 có CO 14:00 → đêm dài 14:00 → 14:00 hôm sau)
 *
 *   3. Đêm đầu: từ actualCheckIn → CO time của phòng đó hôm sau.
 *      Đêm cuối: kết thúc tại effectiveCheckOut.
 *
 *   4. Chuyển phòng + trả cùng ngày (chưa qua đêm phòng mới):
 *      - Default → tính 1 ngày phòng mới
 *      - Mode HOURLY_NEW_ROOM → tính theo slot giờ phòng mới
 *
 *   5. Phụ thu CI sớm / CO trễ áp dụng cho phòng đầu / phòng cuối.
 *      Phí chuyển phòng cộng riêng (transferFee).
 *
 * INPUT segment (METADATA only, không lưu giá):
 *   {
 *     _id, sequenceNumber, roomNumber, roomId, typeId,
 *     startAt, endAt,
 *     policyId, policyName,
 *     transferMode: 'INITIAL_CHECKIN' | 'KEEP_OLD_RATE' | 'USE_NEW_RATE' | 'HOURLY_NEW_ROOM' | 'FREE',
 *     transferFee, transferReason,
 *     status: 'active' | 'closed' | 'cancelled',
 *   }
 * ════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const TRANSFER_MODES = Object.freeze({
  INITIAL_CHECKIN: 'INITIAL_CHECKIN',
  KEEP_OLD_RATE: 'KEEP_OLD_RATE',
  USE_NEW_RATE: 'USE_NEW_RATE',
  HOURLY_NEW_ROOM: 'HOURLY_NEW_ROOM',
  FREE: 'FREE',
});

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const fmtDM = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDT = d => `${fmtDM(d)} ${fmtTime(d)}`;

function parseHHMM(s) {
  const [h, m] = String(s || '12:00').split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

/**
 * Pick hour slot:
 *   - hours < slot nhỏ nhất → slot nhỏ nhất (minimum)
 *   - hours ≥ slot lớn nhất → slot lớn nhất (cap)
 *   - Bình thường: slot lớn nhất có hours ≤ hoursNeeded
 */
function pickHourSlot(slots, hoursNeeded) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const normalized = slots
    .map(s => {
      const t = String(s.time || s.hours || '').trim();
      const h = t.includes(':') ? parseInt(t.split(':')[0], 10) : parseInt(t, 10);
      return { hours: h, price: Number(s.price || 0) };
    })
    .filter(s => Number.isFinite(s.hours) && s.hours > 0)
    .sort((a, b) => a.hours - b.hours);

  if (normalized.length === 0 || hoursNeeded <= 0) return null;
  if (hoursNeeded < normalized[0].hours) return normalized[0];

  let best = normalized[0];
  for (const s of normalized) {
    if (s.hours <= hoursNeeded) best = s;
    else break;
  }
  return best;
}

/**
 * Tìm segment active tại thời điểm t.
 * segment.startAt <= t < segment.endAt (endAt null → Infinity)
 * Fallback: t trước first → first; t sau last → last.
 */
function findSegmentAt(segments, t) {
  const tMs = t.getTime();
  for (const seg of segments) {
    if (seg.status === 'cancelled') continue;
    const s = new Date(seg.startAt).getTime();
    const e = seg.endAt ? new Date(seg.endAt).getTime() : Infinity;
    if (s <= tMs && tMs < e) return seg;
  }
  if (segments.length === 0) return null;
  if (tMs < new Date(segments[0].startAt).getTime()) return segments[0];
  return segments[segments.length - 1];
}

/**
 * Giá 1 đêm theo segment.
 *   - FREE → 0
 *   - KEEP_OLD_RATE → dùng dayPrice của segment trước
 *   - Khác → dayPrice của segment này
 */
function nightlyRate(segment, prevSegment) {
  if (segment.transferMode === TRANSFER_MODES.FREE) return 0;
  if (segment.transferMode === TRANSFER_MODES.KEEP_OLD_RATE && prevSegment?._policy) {
    return prevSegment._policy.dayPrice || 0;
  }
  return segment._policy?.dayPrice || 0;
}

/**
 * Walk từng đêm, dùng CO time của PHÒNG khách ngủ đêm đó.
 *
 * Algorithm:
 *   cursor = startAt của booking
 *   while cursor < effectiveCheckOut:
 *     1. Tentative end = CO time hôm sau theo phòng tại cursor
 *     2. Probe giữa (cursor, tentativeEnd) → phòng ngủ thực sự
 *     3. Nếu phòng ngủ khác phòng tại cursor → re-compute end theo CO time của phòng ngủ
 *     4. Clamp end ≤ effectiveCheckOut
 *     5. Push night, cursor = end
 */
function buildNights({ segments, effectiveCheckOut }) {
  if (segments.length === 0) return [];

  const overallStart = new Date(segments[0].startAt);
  const overallEnd = new Date(effectiveCheckOut);
  if (overallEnd <= overallStart) return [];

  const nights = [];
  let cursor = new Date(overallStart);
  let i = 0;
  const MAX = 365;

  while (cursor < overallEnd && i < MAX) {
    // Step 1: tentative end theo phòng tại cursor
    const segAtCursor = findSegmentAt(segments, cursor);
    const cursorCO = parseHHMM(segAtCursor?._policy?.dayCheckOutTime || '12:00');

    let tentativeEnd = new Date(cursor);
    tentativeEnd.setHours(cursorCO.h, cursorCO.m, 0, 0);
    if (tentativeEnd <= cursor) {
      tentativeEnd = new Date(tentativeEnd.getTime() + 86400000);
    }

    // Step 2: probe phòng ngủ = giữa (cursor, tentativeEnd)
    const probe = new Date((cursor.getTime() + tentativeEnd.getTime()) / 2);
    const sleepingSeg = findSegmentAt(segments, probe);

    // Step 3: nếu phòng ngủ KHÁC → re-compute end theo CO time của phòng ngủ
    let finalEnd = tentativeEnd;
    if (sleepingSeg && String(sleepingSeg._id) !== String(segAtCursor?._id)) {
      const sleepCO = parseHHMM(sleepingSeg._policy?.dayCheckOutTime || '12:00');
      let recomputed = new Date(cursor);
      recomputed.setHours(sleepCO.h, sleepCO.m, 0, 0);
      if (recomputed <= cursor) {
        recomputed = new Date(recomputed.getTime() + 86400000);
      }
      finalEnd = recomputed;
    }

    // Step 4: clamp tại overallEnd
    const isLast = finalEnd >= overallEnd;
    if (isLast) finalEnd = new Date(overallEnd);

    const duration = (finalEnd - cursor) / 3600000;

    nights.push({
      index: i,
      startAt: new Date(cursor),
      endAt: new Date(finalEnd),
      segment: sleepingSeg,
      isLast,
      durationHours: duration,
    });

    cursor = new Date(finalEnd);
    i++;
  }

  return nights;
}

/**
 * Phụ thu CI sớm (segment đầu).
 */
function calcEarlyCheckin(firstSeg, tolerance = 15) {
  const policy = firstSeg._policy;
  if (!policy || !Array.isArray(policy.dayEarlyCheckIn) || policy.dayEarlyCheckIn.length === 0) {
    return null;
  }

  const ciTime = parseHHMM(policy.dayCheckInTime || '14:00');
  const startAt = new Date(firstSeg.startAt);

  const standardCI = new Date(startAt);
  standardCI.setHours(ciTime.h, ciTime.m, 0, 0);

  if (startAt >= standardCI) return null;

  const earlyMin = (standardCI - startAt) / 60000;
  if (earlyMin <= tolerance) return null;

  const fullH = Math.floor(earlyMin / 60);
  const remainder = earlyMin - fullH * 60;
  const earlyHours = remainder <= tolerance ? Math.max(1, fullH) : fullH + 1;

  const slot = pickHourSlot(policy.dayEarlyCheckIn, earlyHours);
  if (!slot) return null;

  return {
    label: `Phụ thu nhận phòng sớm (${earlyHours} giờ)`,
    amount: slot.price,
    type: 'surcharge',
    meta: { earlyCheckin: true, earlyHours, segmentId: firstSeg._id },
  };
}

/**
 * Phụ thu CO trễ (segment cuối).
 */
function calcLateCheckout(lastSeg, effectiveCheckOut, tolerance = 15) {
  const policy = lastSeg._policy;
  if (!policy || !Array.isArray(policy.dayLateCheckOut) || policy.dayLateCheckOut.length === 0) {
    return null;
  }

  const coTime = parseHHMM(policy.dayCheckOutTime || '12:00');
  const co = new Date(effectiveCheckOut);

  const standardCO = new Date(co);
  standardCO.setHours(coTime.h, coTime.m, 0, 0);

  if (co <= standardCO) return null;

  const lateMin = (co - standardCO) / 60000;
  if (lateMin <= tolerance) return null;

  const fullH = Math.floor(lateMin / 60);
  const remainder = lateMin - fullH * 60;
  const lateHours = remainder <= tolerance ? Math.max(1, fullH) : fullH + 1;

  const slot = pickHourSlot(policy.dayLateCheckOut, lateHours);
  if (!slot) return null;

  return {
    label: `Phụ thu trả phòng trễ (${lateHours} giờ)`,
    amount: slot.price,
    type: 'surcharge',
    meta: { lateCheckout: true, lateHours, segmentId: lastSeg._id },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: computeBill
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {Object} input
 * @param {Object} input.booking — booking document (segments[], adults, children, etc.)
 * @param {Object} input.policiesBySegmentId — map { segmentId(string) → policy }
 * @param {Object} input.branch — { toleranceMinutes }
 * @param {Date}   input.effectiveCheckOut — mode='now' → now, mode='checkout' → plannedCO
 *
 * @returns {Object} {
 *   lines: [{kind, label, amount, meta}],   ← FE đọc cái này để hiển thị
 *   nights: [...],                          ← chi tiết từng đêm
 *   transferFees: [...],
 *   surcharges: [...],
 *   totals: { room, transferFee, surcharge, grand }
 * }
 */
function computeBill({ booking, policiesBySegmentId = {}, branch = {}, effectiveCheckOut }) {
  const segments = (booking.segments || [])
    .filter(s => s.status !== 'cancelled')
    .map(s => (s.toObject ? s.toObject() : { ...s }))
    .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));

  if (segments.length === 0) {
    return {
      lines: [], nights: [], transferFees: [], surcharges: [],
      totals: { room: 0, transferFee: 0, surcharge: 0, grand: 0 },
    };
  }

  // Enrich segments với policy
  for (const seg of segments) {
    seg._policy = policiesBySegmentId[String(seg._id)] || null;
  }

  const effectiveEnd = effectiveCheckOut ? new Date(effectiveCheckOut) : new Date(booking.checkOut);
  const tolerance = branch?.toleranceMinutes ?? 15;

  // 1. Build đêm
  const nights = buildNights({ segments, effectiveCheckOut: effectiveEnd });

  // 2. Tính tiền từng đêm
  const lines = [];
  let totalRoom = 0;

  for (let i = 0; i < nights.length; i++) {
    const night = nights[i];
    const seg = night.segment;
    if (!seg) continue;

    const prevSeg = segments.find(s => s.sequenceNumber === seg.sequenceNumber - 1);
    const isLast = i === nights.length - 1;

    // ⭐ TH ĐÊM CUỐI BỊ CẮT NGẮN: nếu đêm cuối < 22h và KHÔNG phải HOURLY/transfer trong đêm
    //   → bỏ qua (sẽ tính qua late CO surcharge). Tránh double counting.
    //   Logic: ranh giới đêm là CO time → nếu khách trả sau CO time một chút → đó là late CO
    //   chứ không phải đêm mới.
    if (isLast && nights.length > 1 && night.durationHours < 22) {
      const lastSeg = segments[segments.length - 1];
      const isHourlyMode = lastSeg.transferMode === TRANSFER_MODES.HOURLY_NEW_ROOM;
      const lastStartsInThisNight =
        new Date(lastSeg.startAt).getTime() > night.startAt.getTime() &&
        new Date(lastSeg.startAt).getTime() < night.endAt.getTime();

      // Nếu KHÔNG phải case HOURLY/transfer-in-night → đêm này là "late CO leftover" → skip
      if (!(isHourlyMode && lastStartsInThisNight)) {
        continue;
      }
    }

    // ⭐ TH ĐẶC BIỆT: trong đêm này có chuyển phòng + segment cuối là HOURLY_NEW_ROOM
    //    → tách thành 2 lines: 1 đêm theo phòng ngủ + slot giờ phòng cuối
    if (isLast) {
      const lastSeg = segments[segments.length - 1];
      const isHourlyMode = lastSeg.transferMode === TRANSFER_MODES.HOURLY_NEW_ROOM;
      const lastStartsInThisNight =
        new Date(lastSeg.startAt).getTime() > night.startAt.getTime() &&
        new Date(lastSeg.startAt).getTime() < night.endAt.getTime();
      const lastIsDifferentFromSleeping = String(lastSeg._id) !== String(seg._id);

      if (isHourlyMode && lastStartsInThisNight && lastIsDifferentFromSleeping) {
        // Line A: 1 đêm phòng ngủ
        const rate = nightlyRate(seg, prevSeg);
        lines.push({
          kind: 'night',
          label: `[${seg.roomNumber}] Giá ngày (${fmtDT(night.startAt)} → ${fmtDT(new Date(lastSeg.startAt))})`,
          amount: rate,
          meta: { roomNumber: seg.roomNumber, segmentId: seg._id, nightIndex: i },
        });
        totalRoom += rate;

        // Line B: slot giờ phòng HOURLY
        const hourlyDuration = (night.endAt - new Date(lastSeg.startAt)) / 3600000;
        const hours = Math.max(1, Math.ceil(hourlyDuration));
        const slot = pickHourSlot(lastSeg._policy?.hourSlots, hours);
        const hAmount = slot ? slot.price : (lastSeg._policy?.dayPrice || 0);
        lines.push({
          kind: 'night',
          label: `[${lastSeg.roomNumber}] Giá giờ (${fmtDT(new Date(lastSeg.startAt))} → ${fmtDT(night.endAt)})${slot ? ` (Slot ${slot.hours}h)` : ' (fallback day)'}`,
          amount: hAmount,
          meta: {
            roomNumber: lastSeg.roomNumber, segmentId: lastSeg._id,
            hourly: true, slot: slot?.hours, nightIndex: i,
          },
        });
        totalRoom += hAmount;
        continue;
      }
    }

    // TH HOURLY_NEW_ROOM toàn đêm (vd: CI muộn cùng ngày, chuyển phòng + trả nhanh)
    const isHourly = seg.transferMode === TRANSFER_MODES.HOURLY_NEW_ROOM;
    if (isLast && isHourly && night.durationHours < 22) {
      const hours = Math.max(1, Math.ceil(night.durationHours));
      const slot = pickHourSlot(seg._policy?.hourSlots, hours);
      const amount = slot ? slot.price : (seg._policy?.dayPrice || 0);
      lines.push({
        kind: 'night',
        label: `[${seg.roomNumber}] Giá giờ (${fmtDT(night.startAt)} → ${fmtDT(night.endAt)})${slot ? ` (Slot ${slot.hours}h)` : ' (fallback day)'}`,
        amount,
        meta: {
          roomNumber: seg.roomNumber, segmentId: seg._id,
          hourly: true, slot: slot?.hours, nightIndex: i,
        },
      });
      totalRoom += amount;
      continue;
    }

    // Bình thường: 1 đêm × dayPrice
    const rate = nightlyRate(seg, prevSeg);
    lines.push({
      kind: 'night',
      label: `[${seg.roomNumber}] Giá ngày (${fmtDT(night.startAt)} → ${fmtDT(night.endAt)})`,
      amount: rate,
      meta: {
        roomNumber: seg.roomNumber, segmentId: seg._id,
        transferMode: seg.transferMode, nightIndex: i,
      },
    });
    totalRoom += rate;
  }

  // 3. Phí chuyển phòng
  const transferFees = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.transferMode === TRANSFER_MODES.INITIAL_CHECKIN) continue;
    if ((seg.transferFee || 0) <= 0) continue;
    const prev = segments[i - 1];
    const fee = {
      kind: 'fee',
      label: `Phí chuyển phòng ${prev?.roomNumber || '?'} → ${seg.roomNumber}`,
      amount: seg.transferFee,
      meta: {
        transferFee: true, segmentId: seg._id,
        fromRoom: prev?.roomNumber, toRoom: seg.roomNumber,
      },
    };
    transferFees.push(fee);
    lines.push(fee);
  }

  // 4. Phụ thu CI sớm / CO trễ
  const surcharges = [];
  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];

  const earlyCI = calcEarlyCheckin(firstSeg, tolerance);
  if (earlyCI) {
    earlyCI.kind = 'surcharge';
    surcharges.push(earlyCI);
    lines.push(earlyCI);
  }

  const lateCO = calcLateCheckout(lastSeg, effectiveEnd, tolerance);
  if (lateCO) {
    lateCO.kind = 'surcharge';
    surcharges.push(lateCO);
    lines.push(lateCO);
  }

  const totalTransferFee = transferFees.reduce((s, f) => s + f.amount, 0);
  const totalSurcharge = surcharges.reduce((s, sc) => s + sc.amount, 0);

  return {
    lines,
    nights,
    transferFees,
    surcharges,
    totals: {
      room: totalRoom,
      transferFee: totalTransferFee,
      surcharge: totalSurcharge,
      grand: totalRoom + totalTransferFee + totalSurcharge,
    },
  };
}

module.exports = {
  computeBill,
  buildNights,
  findSegmentAt,
  nightlyRate,
  calcEarlyCheckin,
  calcLateCheckout,
  pickHourSlot,
  TRANSFER_MODES,
};