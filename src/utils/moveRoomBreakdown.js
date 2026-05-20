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
      const raw = s.time ?? s.duration ?? s.durationHours ?? '';
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

/**
 * ⭐ NEW 20/05: Tính giá GIỜ phòng mới — COPY logic từ priceCalculator.js để nhất quán.
 *
 *   Cấu trúc hourSlots thực tế = bảng giá LŨY TIẾN theo mốc giờ:
 *     { time: '02:00', price: 250000 }  → ở 2h = 250k
 *     { time: '03:00', price: 270000 }  → ở 3h = 270k
 *     ...
 *   (time có thể là "HH:mm" hoặc số "2" hoặc field durationHours)
 *
 *   Quy trình:
 *     1. roundHoursWithTolerance: làm tròn số giờ với tolerance
 *        Vd tolerance=10: 2h58m → remainder 58 > 10 → 3h. 2h08m → remainder 8 ≤ 10 → 2h.
 *     2. pickSlotHourly: lấy mốc giờ LỚN NHẤT ≤ số giờ đã làm tròn.
 *        < mốc nhỏ nhất → áp mốc nhỏ nhất (minimum charge).
 *        > mốc lớn nhất → cap ở mốc lớn nhất.
 */
const getSlotHoursVal = (s) => {
  const v = s?.time ?? s?.hours ?? s?.duration ?? s?.durationHours ?? s?.h ?? null;
  if (v === null || v === undefined) return null;
  const str = String(v).trim();
  if (str.includes(':')) {
    const [h] = str.split(':').map(Number);
    return Number.isFinite(h) ? h : null;
  }
  const n = parseInt(str, 10);
  return Number.isFinite(n) ? n : null;
};

const roundHoursWithTolerance = (totalMinutes, toleranceMin = 0) => {
  const fullHours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes - fullHours * 60;
  if (remainder <= toleranceMin) return fullHours;
  return fullHours + 1;
};

/**
 * pickSlotHourly: chọn mốc giá giờ theo số giờ (đã làm tròn).
 *   - hours < mốc nhỏ nhất → mốc nhỏ nhất (minimum charge)
 *   - bình thường → mốc LỚN NHẤT ≤ hours
 *   - hours vượt mốc lớn nhất → cap mốc lớn nhất
 */
function pickSlotHourly(slots, hours) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const valid = slots
    .map(s => {
      const h = getSlotHoursVal(s);
      const p = Number(s?.price ?? s?.amount ?? s?.value ?? 0) || 0;
      if (h === null || h <= 0) return null;
      return { hours: h, price: p };
    })
    .filter(Boolean)
    .sort((a, b) => a.hours - b.hours);

  if (valid.length === 0) return null;

  // hours < mốc nhỏ nhất → minimum charge
  if (hours < valid[0].hours) {
    return { ...valid[0], isMinimum: true };
  }
  // mốc lớn nhất ≤ hours (nếu vượt mốc lớn nhất → cap mốc lớn nhất)
  const eligible = valid.filter(s => s.hours <= hours);
  return eligible.length > 0 ? eligible[eligible.length - 1] : valid[valid.length - 1];
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
  //   Vd: CI 15/05 14:00, transfer 15/05 14:05, now=15/05 14:10 → tính phòng cũ.
  //   ⭐ FIX 20/05/2026: CHỈ áp dụng khi CHƯA QUA ĐÊM nào ở phòng cũ.
  //     Nếu khách đã ở nhiều đêm rồi mới chuyển (vd ở 201 từ 18/05, chuyển 204 ngày 20/05),
  //     thì việc "vừa chuyển xem ngay" KHÔNG được coi như chưa chuyển — phí + phòng mới
  //     vẫn phải hiện. Logic này chỉ dành cho case vừa CI vừa chuyển (booking ngắn).
  const sinceTransfer = (co - tAt) / 60000;
  //   "Chưa qua đêm" = transferAt còn trong đêm 1 (trước CO_chuẩn của ngày sau CI).
  const coTimeForCheck = parseTimeStr(branchConfig?.checkOutTime ?? '12:00', DEFAULT_CONFIG.CO_HOUR);
  const firstNightEnd = new Date(setHM(ci, coTimeForCheck.h, coTimeForCheck.m).getTime() + 86400000);
  const transferStillInFirstNight = tAt < firstNightEnd;

  if (sinceTransfer >= 0 && sinceTransfer <= tolerance && tAt > ci && transferStillInFirstNight) {
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

  // ─── Early CI surcharge ───
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
    // ─── Không phải rạng sáng đêm 1 ───
    //   ⭐ Phân biệt theo giờ transfer so với CO chuẩn (12:00) của ngày chuyển:
    //
    //   [A] Transfer TRƯỚC CO chuẩn (vd 09:50 < 12:00) — BK_YCDMHF:
    //       Đêm chứa transfer = phòng CŨ (khách ngủ đêm qua ở cũ, sáng nay mới chuyển).
    //       → Phòng cũ = đêm 0..transferNightIdx. Phòng mới từ CO chuẩn (12:00).
    //
    //   [B] Transfer SAU CO chuẩn (vd 13:37 > 12:00) — BK_D9CMKA:
    //       Đêm cũ đã đóng lúc 12:00. Khách ở quá giờ rồi mới chuyển.
    //       → Phòng cũ = đêm 0..transferNightIdx-1 (KHÔNG gồm đêm chứa transfer).
    //       → Khe 12:00 → transferAt:
    //           • ≤ tolerance (15p): phụ thu TRỄ phòng cũ (dayLateCheckOut)
    //           • > tolerance: bỏ qua (không tính)
    //       → Phòng mới từ transferAt (giờ/ngày tùy độ dài).

    // CO chuẩn của ngày transfer
    const coStdTime = parseTimeStr(branchConfig?.checkOutTime ?? '12:00', DEFAULT_CONFIG.CO_HOUR);
    const coStdOfTransferDay = setHM(tAt, coStdTime.h, coStdTime.m);
    const transferAfterCoStd = tAt > coStdOfTransferDay;
    const delayAfterCoMin = transferAfterCoStd ? (tAt - coStdOfTransferDay) / 60000 : 0;

    // ⭐ Phòng CŨ
    //   [A] transfer trước CO chuẩn: gồm đêm chứa transfer (0..transferNightIdx)
    //   [B] transfer sau CO chuẩn: KHÔNG gồm đêm chứa transfer (0..transferNightIdx-1)
    //       vì đêm đó đã kết thúc lúc 12:00, phần sau là phòng mới.
    const oldNightCount = transferAfterCoStd ? transferNightIdx : (transferNightIdx + 1);
    const oldNights = nights.slice(0, oldNightCount);
    if (oldNights.length > 0) {
      const firstOld = oldNights[0];
      const lastOld = oldNights[oldNights.length - 1];
      // ⭐ Label endpoint:
      //   [A] transfer TRƯỚC CO chuẩn (< 12:00): hiển thị kết thúc tại transferAt
      //       (vì đoạn mới đã bắt đầu từ transferAt — tránh label trùng 09:50→12:00).
      //       Tiền VẪN tính trọn đêm (amount không đổi).
      //   [B] transfer SAU CO chuẩn (> 12:00): giữ endAt (12:00) vì đoạn cũ dừng ở 12:00.
      const oldDisplayEnd = (!transferAfterCoStd && tAt < lastOld.endAt) ? tAt : lastOld.endAt;
      items.push({
        label: `[${oldRoom.number}] Giá ngày (${fmtDT(firstOld.startAt)} → ${fmtDT(oldDisplayEnd)})`,
        amount: (oldRoom.policy.dayPrice || 0) * oldNights.length,
        type: 'base',
        meta: {
          roomNumber: oldRoom.number,
          nights: oldNights.length,
          policy: 'old',
          segment: 'oldNights',
          rangeStart: firstOld.startAt.toISOString(),
          rangeEnd: lastOld.endAt.toISOString(),   // meta giữ endAt thật (cho tính toán)
          displayEnd: oldDisplayEnd.toISOString(),  // ⭐ endpoint hiển thị
          dayPrice: oldRoom.policy.dayPrice || 0,
        },
      });
    }

    // ⭐ [B] Phụ thu TRỄ phòng cũ nếu transfer sau CO chuẩn ≤ tolerance phút
    if (transferAfterCoStd && delayAfterCoMin > 0 && delayAfterCoMin <= tolerance) {
      const lateSlots = oldRoom.policy.dayLateCheckOut || [];
      const lateHours = roundHoursWithTolerance(delayAfterCoMin, 0);  // số giờ trễ (làm tròn)
      const lateSlot = pickSlotHourly(lateSlots, Math.max(1, lateHours));
      if (lateSlot) {
        items.push({
          label: `[${oldRoom.number}] Trả phòng trễ: ${fmtDuration(Math.round(delayAfterCoMin))} (Slot ${lateSlot.hours}h)`,
          amount: lateSlot.price,
          type: 'surcharge',
          meta: {
            roomNumber: oldRoom.number,
            lateCheckout: true,
            policy: 'old',
            segment: 'oldLateCheckout',
            slotHours: lateSlot.hours,
          },
        });
      }
    }

    // Phí chuyển phòng
    pushFee();

    // ⭐ Đoạn phòng MỚI LUÔN bắt đầu từ transferAt (chấp nhận overlap với đêm cũ).
    //   [A] transfer trước CO: overlap transferAt → 12:00 với đêm cũ (đã chốt).
    //   [B] transfer sau CO: không overlap (đêm cũ đã đóng lúc 12:00).
    const newStart = tAt;
    const newRoomDurationH = (co - newStart) / 3600000;
    const newRoomHourSlots = newRoom.policy.hourSlots || [];
    const newRoomMinutes = (co - newStart) / 60000;
    const roundedHours = roundHoursWithTolerance(newRoomMinutes, tolerance);

    const maxSlotHours = newRoomHourSlots.length > 0
      ? Math.max(...newRoomHourSlots.map(s => getSlotHoursVal(s) || 0))
      : 0;

    // ⭐ Ngưỡng giờ→ngày theo GIỜ ĐỒNG HỒ (dayEquivalentHours, mặc định 23):
    //   Nếu checkout/now vượt mốc 23:00 cùng ngày → đoạn mới tính giá NGÀY (cộng 1 đêm).
    //   Vd: transfer 13:37, now 23:01 → 23:01 ≥ 23:00 → tính NGÀY (700k), không giờ.
    //       transfer 13:37, now 22:59 → < 23:00 → tính GIỜ.
    //   Lưu ý: chỉ áp dụng khi co và transferAt CÙNG NGÀY (chưa qua đêm calendar).
    const coClockHour = co.getHours() + co.getMinutes() / 60;
    const sameDayAsTransfer = co.getFullYear() === tAt.getFullYear()
      && co.getMonth() === tAt.getMonth()
      && co.getDate() === tAt.getDate();
    const coExceedsDayEquiv = sameDayAsTransfer && coClockHour >= dayEquivalentHours;

    const canHourly = newRoomHourSlots.length > 0
      && roundedHours > 0
      && roundedHours <= maxSlotHours
      && !coExceedsDayEquiv;   // ⭐ vượt 23:00 đồng hồ → KHÔNG giờ, fallback ngày

    if (canHourly) {
      const slot = pickSlotHourly(newRoomHourSlots, roundedHours);
      if (slot) {
        items.push({
          label: `[${newRoom.number}] Giá giờ (${fmtDT(newStart)} → ${fmtDT(co)}) — ${roundedHours}h`,
          amount: slot.price,
          type: 'base',
          meta: {
            roomNumber: newRoom.number,
            policy: 'new',
            segment: 'newHourly',
            mode: 'hour',
            slotHours: slot.hours,
            roundedHours,
            durationHours: newRoomDurationH,
            hourPrice: slot.price,
            isMinimum: !!slot.isMinimum,
          },
        });
      }
    } else {
      // ⭐ Phòng MỚI tính giá NGÀY.
      //   [A] transfer trước CO: lấy các đêm SAU đêm chuyển (nights.slice).
      //   [B] transfer sau CO: tính số đêm từ newStart (transferAt) → co.
      let newNights;
      if (transferAfterCoStd) {
        // Từ transferAt → co: tính số đêm calendar
        newNights = nights.slice(transferNightIdx);  // đêm chứa transfer trở đi = phòng mới
      } else {
        newNights = nights.slice(transferNightIdx + 1);
      }
      if (newNights.length > 0) {
        const first = newNights[0];
        const last = newNights[newNights.length - 1];
        // [B]: dòng bắt đầu từ transferAt (không phải đầu đêm)
        const displayStart = transferAfterCoStd ? newStart : first.startAt;
        items.push({
          label: `[${newRoom.number}] Giá ngày (${fmtDT(displayStart)} → ${fmtDT(last.endAt)})`,
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
      } else if (newRoomDurationH > 0) {
        // Cùng ngày, vượt slot giờ → 1 đêm phòng mới
        items.push({
          label: `[${newRoom.number}] Giá ngày (${fmtDT(newStart)} → ${fmtDT(co)})`,
          amount: newRoom.policy.dayPrice || 0,
          type: 'base',
          meta: {
            roomNumber: newRoom.number,
            nights: 1,
            policy: 'new',
            segment: 'newDaySameDay',
            dayPrice: newRoom.policy.dayPrice || 0,
          },
        });
      }
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
    pickSlotHourly,
    roundHoursWithTolerance,
    getSlotHoursVal,
    fmtDuration,
  },
};