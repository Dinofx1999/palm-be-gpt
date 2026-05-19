/**
 * ════════════════════════════════════════════════════════════════════════════
 * moveRoomBreakdown.js — v22 (19/05/2026)
 *
 * REWRITE HOÀN TOÀN — Bỏ 4 mode phức tạp A/B/C/D, dùng 1 thuật toán đơn giản.
 *
 * QUY TẮC DUY NHẤT:
 *   Đêm xảy ra việc đổi phòng → tính theo PHÒNG MỚI kể từ đầu đêm đó.
 *
 * EDGE CASE RẠNG SÁNG (transfer < earlyCheckinUntil của đêm 1):
 *   - Đè đêm 1 bằng phòng mới
 *   - Hiển thị dòng phòng cũ "gạch bỏ" (log only, amount không cộng)
 *   - Vì khách thực sự ngủ ở phòng mới cả đêm
 *
 * RANH GIỚI ĐÊM:
 *   - Đêm 1: actualCheckIn → CO_chuẩn hôm sau
 *   - Đêm N (N>1): CI_chuẩn → CO_chuẩn hôm sau (24h sau đêm trước)
 *
 * PHỤ THU:
 *   - Early CI: theo policy phòng CŨ (CI ở phòng cũ)
 *   - Late CO: theo policy phòng MỚI (trả ở phòng mới)
 *   - Phí chuyển phòng: cộng riêng
 * ════════════════════════════════════════════════════════════════════════════
 */

const DEFAULT_CONFIG = Object.freeze({
  CI_HOUR: 14,
  CO_HOUR: 12,
  DAY_EQUIVALENT_HOURS: 23,
  EARLY_CHECKIN_UNTIL: 5,
  TOLERANCE_MINUTES: 15,
});

// ──────────────── Helpers ────────────────
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDT = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const parseTimeStr = (s, defaultH, defaultM = 0) => {
  const m = String(s ?? '').match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return { h: defaultH, m: defaultM };
  return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
};

const setHM = (date, h, m) => {
  const x = new Date(date);
  x.setHours(h, m, 0, 0);
  return x;
};

const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000);

/**
 * Pick surcharge slot phù hợp với số giờ cần.
 *   - hoursNeeded < min slot → trả min slot (minimum charge)
 *   - hoursNeeded ≥ max slot → trả max slot
 *   - Bình thường: slot lớn nhất có hours ≤ hoursNeeded
 */
function pickSlot(slots, hoursNeeded) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const normalized = slots
    .map(s => {
      const raw = s.time ?? s.duration ?? '';
      const m = String(raw).match(/(\d+)/);
      return { hours: m ? parseInt(m[1], 10) : 0, price: Number(s.price) || 0 };
    })
    .filter(s => s.hours > 0)
    .sort((a, b) => a.hours - b.hours);

  if (normalized.length === 0) return null;
  if (hoursNeeded <= 0) return null;
  if (hoursNeeded < normalized[0].hours) return normalized[0];

  let best = normalized[0];
  for (const s of normalized) {
    if (s.hours <= hoursNeeded) best = s;
    else break;
  }
  return best;
}

function fmtDuration(minutes) {
  const totalH = Math.floor(minutes / 60);
  const remM = minutes % 60;
  if (totalH >= 24) {
    const d = Math.floor(totalH / 24);
    const h = totalH % 24;
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  return remM > 0 ? `${totalH}h ${remM}m` : `${totalH}h`;
}

/**
 * Build danh sách "đêm" trong khoảng [actualCheckIn, plannedCheckOut].
 * Đêm 1: actualCheckIn → CO_chuẩn hôm sau
 * Đêm N: cộng 24h tiếp
 *
 * ⚠ Đêm cuối kết thúc tại MIN(plannedCheckOut, CO_chuẩn của ngày đó).
 *   Phần overstay (plannedCO > CO_chuẩn) sẽ là LATE CO surcharge — KHÔNG tính như đêm.
 *
 * ⭐ Tham số `mustIncludeTime` (optional): đảm bảo nights phải bao trùm thời điểm đó.
 *   Dùng cho case mode='now' khi transferAt nằm trong phần overstay → cần tạo
 *   thêm 1 đêm sau CO_chuẩn để transferAt rơi vào đó.
 *
 * @returns [{startAt, endAt, durationHours}]
 */
function buildNights({ actualCheckIn, plannedCheckOut, branchConfig, mustIncludeTime = null }) {
  const coTime = parseTimeStr(branchConfig?.checkOutTime ?? '12:00', DEFAULT_CONFIG.CO_HOUR);

  const nights = [];
  let cursor = new Date(actualCheckIn);
  const end = new Date(plannedCheckOut);

  // ⭐ Đêm 1 LUÔN kết thúc tại CO_chuẩn NGÀY HÔM SAU CI
  //   (CI buổi sáng/trưa/tối/rạng sáng đều cùng quy tắc).
  let nightEnd = setHM(cursor, coTime.h, coTime.m);
  // Luôn +1 ngày — đêm 1 phải qua đêm
  nightEnd = new Date(nightEnd.getTime() + 86400000);

  // Tính CO_chuẩn của ngày plannedCheckOut → giới hạn đêm cuối
  const coStdOfPlannedCO = setHM(end, coTime.h, coTime.m);

  // ⭐ Nếu mustIncludeTime > coStdOfPlannedCO (vd: transferAt nằm trong overstay)
  //   → cần build thêm 1 đêm tiếp theo để bao trùm
  const effectiveEnd = (mustIncludeTime && mustIncludeTime > coStdOfPlannedCO)
    ? mustIncludeTime
    : end;

  while (cursor < effectiveEnd) {
    let segEnd = nightEnd;

    // Check: đêm này có chứa mustIncludeTime không?
    const containsMustInclude = mustIncludeTime &&
      mustIncludeTime >= cursor && mustIncludeTime < nightEnd;

    // Nếu đêm này vượt qua effectiveEnd → clamp
    // NHƯNG: nếu đêm chứa mustIncludeTime → KHÔNG clamp, để đêm chạy full đến nightEnd
    if (!containsMustInclude && segEnd >= effectiveEnd) {
      // CO_chuẩn của ngày effectiveEnd
      const coStdOfEnd = setHM(effectiveEnd, coTime.h, coTime.m);

      // Nếu cursor đã >= CO_chuẩn ngày effectiveEnd → đây là phần "overstay" thuần
      //   → KHÔNG tạo đêm mới, để late CO surcharge xử lý
      if (cursor >= coStdOfEnd) break;

      // Nếu effectiveEnd vượt CO_chuẩn cùng ngày → đêm cuối DỪNG tại CO_chuẩn (phần overstay tính riêng)
      // Nếu effectiveEnd CHƯA tới CO_chuẩn → dừng tại effectiveEnd
      if (effectiveEnd > coStdOfEnd && cursor < coStdOfEnd) {
        segEnd = coStdOfEnd;
      } else {
        segEnd = effectiveEnd;
      }
    }

    nights.push({
      startAt: new Date(cursor),
      endAt: new Date(segEnd),
      durationHours: (segEnd - cursor) / 3600000,
    });

    if (segEnd >= effectiveEnd) break;
    cursor = new Date(segEnd);
    nightEnd = new Date(nightEnd.getTime() + 86400000);
  }

  return nights;
}

/**
 * Xác định transferAt thuộc đêm nào (index trong nights[]).
 * Nếu transferAt < night.endAt → đêm đó.
 */
function findTransferNightIndex(nights, transferAt) {
  const t = transferAt.getTime();
  for (let i = 0; i < nights.length; i++) {
    if (t >= nights[i].startAt.getTime() && t < nights[i].endAt.getTime()) return i;
  }
  // Nếu transferAt = endAt của đêm cuối → đếm là đêm cuối
  if (nights.length > 0 && t >= nights[nights.length - 1].endAt.getTime()) {
    return nights.length - 1;
  }
  return 0;
}

/**
 * Check: transfer rạng sáng (< earlyCheckinUntil) của đêm 1 (trong 24h sau CI)?
 */
function isEarlyMorningTransferOfFirstNight({ actualCheckIn, transferAt, earlyCheckinUntil }) {
  // Phải trong vòng 24h sau CI
  const ciMs = actualCheckIn.getTime();
  const tMs = transferAt.getTime();
  if (tMs - ciMs > 24 * 3600000) return false;
  // Phải trước earlyCheckinUntil:00 sáng
  return transferAt.getHours() < earlyCheckinUntil;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
function computeMoveRoomBreakdown(input) {
  // ⭐ let cho newRoom + transferFee để có thể override khi vừa chuyển trong tolerance
  let {
    actualCheckIn,
    plannedCheckOut,
    transferAt,
    oldRoom,
    newRoom,
    transferFee = 0,
    isFreeRoom = false,
    branchConfig = null,
  } = input;

  if (!actualCheckIn || !plannedCheckOut || !transferAt) {
    throw new Error('Missing required date inputs');
  }
  if (!oldRoom?.policy || !newRoom?.policy) {
    throw new Error('Missing room policies');
  }

  const ci = new Date(actualCheckIn);
  const co = new Date(plannedCheckOut);
  let tAt = new Date(transferAt);   // ⭐ let để có thể override

  const dayEquivalentHours = branchConfig?.dayEquivalentHours ?? DEFAULT_CONFIG.DAY_EQUIVALENT_HOURS;
  const earlyCheckinUntil = branchConfig?.earlyCheckinUntil ?? DEFAULT_CONFIG.EARLY_CHECKIN_UNTIL;
  const tolerance = branchConfig?.toleranceMinutes ?? DEFAULT_CONFIG.TOLERANCE_MINUTES;

  // ⭐ EARLY RETURN 1: Tab "Đến hiện tại" — khách vừa CI ≤ tolerance phút → 0đ
  //   Áp dụng cho cả booking thường + booking đã chuyển phòng.
  //   Khớp logic priceCalculator.js (line 282-289).
  const stayMinutes = (co - ci) / 60000;
  if (stayMinutes >= 0 && stayMinutes <= tolerance) {
    return [{
      label: `Mới ${Math.max(0, Math.floor(stayMinutes))} phút (Linh hoạt ${tolerance} phút — Miễn phí)`,
      amount: 0,
      type: 'base',
      meta: { freeGracePeriod: true, tolerance, diffMinutes: stayMinutes },
    }];
  }

  // ⭐ MUTATE: Tab "Đến hiện tại" — khách vừa chuyển phòng ≤ tolerance phút trước
  //   → Coi như CHƯA chuyển, chỉ tính phòng CŨ từ CI → effectiveCheckOut.
  //   Vd: CI 15/05 14:00, transfer 19/05 16:00, now=19/05 16:05 → tính phòng cũ tới 16:05.
  //   Cách làm: ép newRoom = oldRoom + transferAt = co + transferFee = 0 → logic phía dưới
  //   sẽ tính như chưa chuyển.
  const sinceTransfer = (co - tAt) / 60000;
  if (sinceTransfer >= 0 && sinceTransfer <= tolerance && tAt > ci) {
    newRoom = oldRoom;
    tAt = co;  // = plannedCheckOut → findTransferNightIndex sẽ trả index cuối
    transferFee = 0;
  }

  const items = [];

  const pushFee = () => {
    if (transferFee > 0) {
      items.push({
        label: `Phụ thu chuyển phòng ${oldRoom.number} → ${newRoom.number}`,
        amount: transferFee,
        type: 'surcharge',
        meta: { transferFee: true, fromRoom: oldRoom.number, toRoom: newRoom.number },
      });
    }
  };

  // ─── Early CI surcharge (policy phòng CŨ) ───
  const pushEarlyCI = () => {
    const policy = oldRoom.policy;
    const ciStdTime = parseTimeStr(
      policy.dayCheckInTime ?? branchConfig?.checkInTime ?? '14:00',
      DEFAULT_CONFIG.CI_HOUR,
    );
    const ciStd = setHM(ci, ciStdTime.h, ciStdTime.m);
    // Chỉ tính khi CI sớm cùng ngày calendar
    if (ci >= ciStd) return;
    if (ci.getFullYear() !== ciStd.getFullYear() ||
        ci.getMonth() !== ciStd.getMonth() ||
        ci.getDate() !== ciStd.getDate()) return;

    const earlyMin = Math.round((ciStd - ci) / 60000);
    if (earlyMin <= 0) return;
    // ⭐ Tolerance: nhận phòng sớm trong tolerance không tính phụ thu
    if (earlyMin <= tolerance) return;
    const earlyHours = Math.ceil(earlyMin / 60);

    // Nếu ≥ dayEquivalentHours → cộng 1 đêm thay vì phụ thu
    if (earlyHours >= dayEquivalentHours) {
      items.push({
        label: `[${oldRoom.number}] Nhận phòng sớm: ${fmtDuration(earlyMin)} (≥1 đêm)`,
        amount: policy.dayPrice || 0,
        type: 'surcharge',
        meta: { roomNumber: oldRoom.number, earlyCheckin: true, mode: 'night' },
      });
      return;
    }

    const slot = pickSlot(policy.dayEarlyCheckIn, earlyHours);
    if (!slot || slot.price <= 0) return;
    items.push({
      label: `[${oldRoom.number}] Nhận phòng sớm: ${fmtDuration(earlyMin)} (Slot ${slot.hours}h)`,
      amount: slot.price,
      type: 'surcharge',
      meta: { roomNumber: oldRoom.number, earlyCheckin: true, mode: 'slot', slotHours: slot.hours },
    });
  };

  // ─── Late CO surcharge (policy phòng MỚI) ───
  //   pushLateCO nhận lastNightEnd làm tham chiếu — chỉ tính khi co vượt qua endAt đêm cuối
  //   (KHÔNG dựa vào CO_chuẩn cùng ngày, vì đêm cuối có thể đã được mở rộng để bao transferAt)
  const pushLateCO = (lastNightEnd) => {
    const policy = newRoom.policy;
    // Tham chiếu = endAt đêm cuối (nếu có), nếu không thì CO_chuẩn cùng ngày
    let reference;
    if (lastNightEnd) {
      reference = lastNightEnd;
    } else {
      const coStdTime = parseTimeStr(
        policy.dayCheckOutTime ?? branchConfig?.checkOutTime ?? '12:00',
        DEFAULT_CONFIG.CO_HOUR,
      );
      reference = setHM(co, coStdTime.h, coStdTime.m);
    }

    if (co <= reference) return;

    // Chỉ tính trong cùng ngày calendar (tránh tính 1 ngày × N giờ)
    if (co.getFullYear() !== reference.getFullYear() ||
        co.getMonth() !== reference.getMonth() ||
        co.getDate() !== reference.getDate()) return;

    const lateMin = Math.round((co - reference) / 60000);
    if (lateMin <= 0) return;
    // ⭐ Tolerance: trả phòng trễ trong tolerance không tính phụ thu
    if (lateMin <= tolerance) return;
    const lateHours = Math.ceil(lateMin / 60);

    if (lateHours >= dayEquivalentHours) {
      items.push({
        label: `[${newRoom.number}] Trả phòng trễ: ${fmtDuration(lateMin)} (≥1 đêm)`,
        amount: policy.dayPrice || 0,
        type: 'surcharge',
        meta: { roomNumber: newRoom.number, lateCheckout: true, mode: 'night' },
      });
      return;
    }

    const slot = pickSlot(policy.dayLateCheckOut, lateHours);
    if (!slot || slot.price <= 0) return;
    items.push({
      label: `[${newRoom.number}] Trả phòng trễ: ${fmtDuration(lateMin)} (Slot ${slot.hours}h)`,
      amount: slot.price,
      type: 'surcharge',
      meta: { roomNumber: newRoom.number, lateCheckout: true, mode: 'slot', slotHours: slot.hours },
    });
  };

  // ─── Trường hợp miễn phí phòng ───
  if (isFreeRoom) {
    if (transferFee > 0) pushFee();
    return items;
  }

  // ─── Build danh sách đêm + tìm đêm chuyển phòng ───
  // ⭐ FIX: truyền mustIncludeTime=transferAt vào buildNights để đảm bảo nights bao trùm
  //   Edge case: mode='now' với effectiveCheckOut sát hoặc lớn hơn transferAt nhưng
  //   transferAt nằm trong phần overstay (sau CO_chuẩn). Vd: vừa chuyển phòng lúc 15:43,
  //   16:15 fetch bill → effectiveCheckOut=16:15, transferAt=15:43, cả hai vượt CO_chuẩn 12:00.
  //   Đáng lẽ phải tính 3 đêm (đêm 3 = 19/05 12:00 → 20/05 12:00) để bao trùm transferAt.
  const nights = buildNights({
    actualCheckIn: ci,
    plannedCheckOut: co,
    branchConfig,
    mustIncludeTime: tAt,
  });

  if (nights.length === 0) {
    // Booking < 1 đêm — không có đêm nào
    // Vd: CI 08:00, CO 11:00 cùng ngày
    // Theo spec user: "tính luôn 1 đêm của ngày đó" → coi như 1 đêm phòng mới
    items.push({
      label: `[${newRoom.number}] Giá ngày (${fmtDT(ci)} → ${fmtDT(co)})`,
      amount: newRoom.policy.dayPrice || 0,
      type: 'base',
      meta: { roomNumber: newRoom.number, nights: 1, policy: 'new', segment: 'sameDay' },
    });
    pushEarlyCI();
    pushFee();
    pushLateCO(null);
    return items;
  }

  const transferNightIdx = findTransferNightIndex(nights, tAt);
  const isEarlyMorning = isEarlyMorningTransferOfFirstNight({
    actualCheckIn: ci, transferAt: tAt, earlyCheckinUntil,
  });

  // ⭐ Tolerance: nếu transferAt - actualCheckIn <= toleranceMinutes
  //   → khách đổi phòng ngay sau CI (vd CI 13:00, transfer 13:10)
  //   → coi như khách CI thẳng vào phòng mới → đè đêm 1 + log phòng cũ
  const minSinceCI = (tAt - ci) / 60000;
  const isWithinTolerance = minSinceCI >= 0 && minSinceCI <= tolerance && transferNightIdx === 0;

  // Gộp 2 trường hợp: rạng sáng HOẶC trong tolerance → đè đêm 1
  const shouldOverrideFirstNight = (isEarlyMorning || isWithinTolerance) && transferNightIdx === 0;

  // ─── Phòng cũ: các đêm TRƯỚC đêm chuyển ───
  //   (Nếu đêm chuyển = đêm 1 + earlyMorning → không có đêm phòng cũ thật)
  if (transferNightIdx > 0) {
    const oldNights = nights.slice(0, transferNightIdx);
    const total = oldNights.length;
    const firstNight = oldNights[0];
    const lastNight = oldNights[total - 1];
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(firstNight.startAt)} → ${fmtDT(lastNight.endAt)})`,
      amount: (oldRoom.policy.dayPrice || 0) * total,
      type: 'base',
      meta: {
        roomNumber: oldRoom.number,
        nights: total,
        policy: 'old',
        segment: 'oldNights',
        rangeStart: firstNight.startAt.toISOString(),
        rangeEnd: lastNight.endAt.toISOString(),
        dayPrice: oldRoom.policy.dayPrice || 0,
      },
    });
  }

  // ─── Early CI surcharge (sau phòng cũ) ───
  pushEarlyCI();

  // ─── Edge case rạng sáng / trong tolerance (đêm 1 đè bằng phòng mới + log phòng cũ gạch bỏ) ───
  if (shouldOverrideFirstNight) {
    const firstNight = nights[0];

    // Dòng log phòng cũ — gạch bỏ, không cộng vào tổng
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(firstNight.startAt)} → ${fmtDT(firstNight.endAt)})`,
      amount: oldRoom.policy.dayPrice || 0,
      type: 'base',
      meta: {
        roomNumber: oldRoom.number,
        nights: 1,
        policy: 'old',
        segment: 'oldNightOverridden',
        striked: true,              // ⭐ FE gạch bỏ dòng này
        excludeFromTotal: true,     // ⭐ Không cộng vào tổng
        dayPrice: oldRoom.policy.dayPrice || 0,
      },
    });

    // Phí chuyển phòng
    pushFee();

    // Phòng mới: đêm 1 đè bằng phòng mới
    items.push({
      label: `[${newRoom.number}] Giá ngày (${fmtDT(firstNight.startAt)} → ${fmtDT(firstNight.endAt)})`,
      amount: newRoom.policy.dayPrice || 0,
      type: 'base',
      meta: {
        roomNumber: newRoom.number,
        nights: 1,
        policy: 'new',
        segment: 'newNightOverride',
        dayPrice: newRoom.policy.dayPrice || 0,
      },
    });

    // Phòng mới: các đêm còn lại (đêm 2 trở đi)
    if (nights.length > 1) {
      const remainNights = nights.slice(1);
      const firstRemain = remainNights[0];
      const lastRemain = remainNights[remainNights.length - 1];
      items.push({
        label: `[${newRoom.number}] Giá ngày (${fmtDT(firstRemain.startAt)} → ${fmtDT(lastRemain.endAt)})`,
        amount: (newRoom.policy.dayPrice || 0) * remainNights.length,
        type: 'base',
        meta: {
          roomNumber: newRoom.number,
          nights: remainNights.length,
          policy: 'new',
          segment: 'newNights',
          dayPrice: newRoom.policy.dayPrice || 0,
        },
      });
    }
  } else {
    // ─── Không phải rạng sáng đêm 1: đêm chuyển + các đêm sau = phòng MỚI ───
    pushFee();

    const newNights = nights.slice(transferNightIdx);
    if (newNights.length > 0) {
      const first = newNights[0];
      const last = newNights[newNights.length - 1];
      items.push({
        label: `[${newRoom.number}] Giá ngày (${fmtDT(first.startAt)} → ${fmtDT(last.endAt)})`,
        amount: (newRoom.policy.dayPrice || 0) * newNights.length,
        type: 'base',
        meta: {
          roomNumber: newRoom.number,
          nights: newNights.length,
          policy: 'new',
          segment: 'newNights',
          dayPrice: newRoom.policy.dayPrice || 0,
        },
      });
    }
  }

  // ─── Late CO surcharge (cuối cùng) ───
  //   Truyền endAt của đêm cuối để pushLateCO biết "đêm cuối tới đâu"
  //   → tránh double count khi đêm cuối đã được mở rộng (case mode=now sau transferAt)
  const lastNightEnd = nights.length > 0 ? nights[nights.length - 1].endAt : null;
  pushLateCO(lastNightEnd);

  return items;
}

module.exports = {
  computeMoveRoomBreakdown,
  DEFAULT_CONFIG,
  _internals: {
    buildNights,
    findTransferNightIndex,
    isEarlyMorningTransferOfFirstNight,
    pickSlot,
    fmtDuration,
  },
};