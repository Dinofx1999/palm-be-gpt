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

// ⭐ FIX 24/05/2026 (LƯỚI AN TOÀN — Lớp 2): module dùng .getHours()/.getDate() theo
//   TZ process. Server chưa set TZ (UTC) → nhận 09:00 VN (=02:00 UTC) bị tính nhầm
//   là rạng sáng → mất phụ thu nhận sớm, lệch mốc 12h/23h. Ép TZ về giờ VN.
//   Chính yếu vẫn set TZ ở entrypoint (DÒNG ĐẦU server.js); dòng dưới là lưới phụ.
if (process.env.TZ !== 'Asia/Ho_Chi_Minh') {
  process.env.TZ = 'Asia/Ho_Chi_Minh'
}

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

  if (hours < valid[0].hours) {
    return { ...valid[0], isMinimum: true };
  }
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
 */
function buildNights({ actualCheckIn, plannedCheckOut, branchConfig, mustIncludeTime = null }) {
  const coTime = parseTimeStr(branchConfig?.checkOutTime ?? '12:00', DEFAULT_CONFIG.CO_HOUR);

  const nights = [];
  let cursor = new Date(actualCheckIn);
  const end = new Date(plannedCheckOut);

  let nightEnd = setHM(cursor, coTime.h, coTime.m);
  nightEnd = new Date(nightEnd.getTime() + 86400000);

  const coStdOfPlannedCO = setHM(end, coTime.h, coTime.m);

  const effectiveEnd = (mustIncludeTime && mustIncludeTime > coStdOfPlannedCO)
    ? mustIncludeTime
    : end;

  while (cursor < effectiveEnd) {
    let segEnd = nightEnd;

    const containsMustInclude = mustIncludeTime &&
      mustIncludeTime >= cursor && mustIncludeTime < nightEnd;

    if (!containsMustInclude && segEnd >= effectiveEnd) {
      const coStdOfEnd = setHM(effectiveEnd, coTime.h, coTime.m);

      if (cursor >= coStdOfEnd) break;

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

function findTransferNightIndex(nights, transferAt) {
  const t = transferAt.getTime();
  for (let i = 0; i < nights.length; i++) {
    if (t >= nights[i].startAt.getTime() && t < nights[i].endAt.getTime()) return i;
  }
  if (nights.length > 0 && t >= nights[nights.length - 1].endAt.getTime()) {
    return nights.length - 1;
  }
  return 0;
}

function isEarlyMorningTransferOfFirstNight({ actualCheckIn, transferAt, earlyCheckinUntil }) {
  const ciMs = actualCheckIn.getTime();
  const tMs = transferAt.getTime();
  if (tMs - ciMs > 24 * 3600000) return false;
  return transferAt.getHours() < earlyCheckinUntil;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
function computeMoveRoomBreakdown(input) {
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

  let ci = new Date(actualCheckIn);
  const co = new Date(plannedCheckOut);
  let tAt = new Date(transferAt);

  const dayEquivalentHours = branchConfig?.dayEquivalentHours ?? DEFAULT_CONFIG.DAY_EQUIVALENT_HOURS;
  const earlyCheckinUntil = branchConfig?.earlyCheckinUntil ?? DEFAULT_CONFIG.EARLY_CHECKIN_UNTIL;
  const tolerance = branchConfig?.toleranceMinutes ?? DEFAULT_CONFIG.TOLERANCE_MINUTES;

  // ⭐ FIX 22/05/2026: "Early-checkin night" — khách nhận phòng RẠNG SÁNG (giờ ≤ earlyCheckinUntil)
  //   được tính TRỌN đêm HÔM TRƯỚC. Lùi ci về CO_chuẩn ngày hôm trước (vd 21/05 12:00)
  //   để buildNights tạo đủ đêm phòng cũ. Cờ wasEarlyCheckinNight để KHÔNG thu phụ thu CI sớm.
  let wasEarlyCheckinNight = false;
  const realCheckIn = new Date(ci);   // ⭐ giữ giờ nhận THỰC TẾ cho label (vd 22/05 01:18)
  if (ci.getHours() <= earlyCheckinUntil) {
    wasEarlyCheckinNight = true;
    const coStd = parseTimeStr(
      oldRoom?.policy?.dayCheckOutTime ?? branchConfig?.checkOutTime ?? '12:00',
      DEFAULT_CONFIG.CO_HOUR,
    );
    ci = new Date(ci);
    ci.setDate(ci.getDate() - 1);
    ci.setHours(coStd.h, coStd.m, 0, 0);
  }

  // ⭐ EARLY RETURN 1: Tab "Đến hiện tại" — khách vừa CI ≤ tolerance phút → 0đ
  const stayMinutes = (co - ci) / 60000;
  if (stayMinutes >= 0 && stayMinutes <= tolerance) {
    return [{
      label: `Mới ${Math.max(0, Math.floor(stayMinutes))} phút (Linh hoạt ${tolerance} phút — Miễn phí)`,
      amount: 0,
      type: 'base',
      meta: { freeGracePeriod: true, tolerance, diffMinutes: stayMinutes },
    }];
  }

  const sinceTransfer = (co - tAt) / 60000;
  const coTimeForCheck = parseTimeStr(branchConfig?.checkOutTime ?? '12:00', DEFAULT_CONFIG.CO_HOUR);
  const firstNightEnd = new Date(setHM(ci, coTimeForCheck.h, coTimeForCheck.m).getTime() + 86400000);
  const transferStillInFirstNight = tAt < firstNightEnd;

  if (sinceTransfer >= 0 && sinceTransfer <= tolerance && tAt > ci && transferStillInFirstNight) {
    newRoom = oldRoom;
    tAt = co;
    transferFee = 0;
  }

  const items = [];
  // ⭐ FIX 24/05/2026: cờ đánh dấu chặng phòng mới đã tính GIÁ GIỜ (tới giờ trả `co`).
  //   Khi đã tính giá giờ thì KHÔNG cộng thêm "Trả phòng trễ" (tránh tính trùng):
  //   giá giờ đã bao trùm tới đúng giờ trả rồi.
  let newRoomPricedHourly = false;

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
    // ⭐ Đã chuẩn hóa early-checkin night thành đêm trọn → KHÔNG thu phụ thu sớm nữa.
    if (wasEarlyCheckinNight) return;
    const policy = oldRoom.policy;
    const ciStdTime = parseTimeStr(
      policy.dayCheckInTime ?? branchConfig?.checkInTime ?? '14:00',
      DEFAULT_CONFIG.CI_HOUR,
    );
    const ciStd = setHM(ci, ciStdTime.h, ciStdTime.m);
    if (ci >= ciStd) return;
    if (ci.getFullYear() !== ciStd.getFullYear() ||
        ci.getMonth() !== ciStd.getMonth() ||
        ci.getDate() !== ciStd.getDate()) return;

    const earlyMin = Math.round((ciStd - ci) / 60000);
    if (earlyMin <= 0) return;
    if (earlyMin <= tolerance) return;
    const earlyHours = Math.ceil(earlyMin / 60);

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
  const pushLateCO = (lastNightEnd) => {
    const policy = newRoom.policy;
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

    if (co.getFullYear() !== reference.getFullYear() ||
        co.getMonth() !== reference.getMonth() ||
        co.getDate() !== reference.getDate()) return;

    const lateMin = Math.round((co - reference) / 60000);
    if (lateMin <= 0) return;
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

  if (isFreeRoom) {
    if (transferFee > 0) pushFee();
    return items;
  }

  const nights = buildNights({
    actualCheckIn: ci,
    plannedCheckOut: co,
    branchConfig,
    mustIncludeTime: tAt,
  });

  if (nights.length === 0) {
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

  const minSinceCI = (tAt - ci) / 60000;
  const isWithinTolerance = minSinceCI >= 0 && minSinceCI <= tolerance && transferNightIdx === 0;

  const shouldOverrideFirstNight = (isEarlyMorning || isWithinTolerance) && transferNightIdx === 0;

  pushEarlyCI();

  if (shouldOverrideFirstNight) {
    const firstNight = nights[0];

    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(firstNight.startAt)} → ${fmtDT(firstNight.endAt)})`,
      amount: oldRoom.policy.dayPrice || 0,
      type: 'base',
      meta: {
        roomNumber: oldRoom.number,
        nights: 1,
        policy: 'old',
        segment: 'oldNightOverridden',
        striked: true,
        excludeFromTotal: true,
        dayPrice: oldRoom.policy.dayPrice || 0,
      },
    });

    pushFee();

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
    const coStdTime = parseTimeStr(branchConfig?.checkOutTime ?? '12:00', DEFAULT_CONFIG.CO_HOUR);
    const coStdOfTransferDay = setHM(tAt, coStdTime.h, coStdTime.m);
    const transferAfterCoStd = tAt > coStdOfTransferDay;
    const delayAfterCoMin = transferAfterCoStd ? (tAt - coStdOfTransferDay) / 60000 : 0;

    const oldNightCount = transferAfterCoStd ? transferNightIdx : (transferNightIdx + 1);
    const oldNights = nights.slice(0, oldNightCount);
    if (oldNights.length > 0) {
      const firstOld = oldNights[0];
      const lastOld = oldNights[oldNights.length - 1];
      const oldDisplayEnd = (!transferAfterCoStd && tAt < lastOld.endAt) ? tAt : lastOld.endAt;
      // ⭐ FIX hiển thị 22/05: nếu early-checkin night, đêm đầu hiển thị GIỜ NHẬN THỰC TẾ
      //   (vd 22/05 01:18) thay vì 12:00 hôm trước. Tiền KHÔNG đổi.
      const oldDisplayStart = wasEarlyCheckinNight ? realCheckIn : firstOld.startAt;
      items.push({
        label: `[${oldRoom.number}] Giá ngày (${fmtDT(oldDisplayStart)} → ${fmtDT(oldDisplayEnd)})`,
        amount: (oldRoom.policy.dayPrice || 0) * oldNights.length,
        type: 'base',
        meta: {
          roomNumber: oldRoom.number,
          nights: oldNights.length,
          policy: 'old',
          segment: 'oldNights',
          rangeStart: firstOld.startAt.toISOString(),
          rangeEnd: lastOld.endAt.toISOString(),
          displayEnd: oldDisplayEnd.toISOString(),
          dayPrice: oldRoom.policy.dayPrice || 0,
        },
      });
    }

    if (transferAfterCoStd && delayAfterCoMin > 0 && delayAfterCoMin <= tolerance) {
      const lateSlots = oldRoom.policy.dayLateCheckOut || [];
      const lateHours = roundHoursWithTolerance(delayAfterCoMin, 0);
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

    pushFee();

    // ⭐ FIX 22/05/2026: Mốc bắt đầu tính GIỜ phòng mới khi CO CÙNG NGÀY với lúc đổi:
    //   - Đổi SAU dayCheckOutTime (vd 12:00): tính giờ TỪ dayCheckOutTime (12:00),
    //     KHÔNG phải từ lúc đổi. Vd đổi 13:00, CO 18:00 → tính 12:00→18:00 = 6h.
    //     (Nếu CO sau dayEquivalentHours 20h → thành giá NGÀY, xử lý bởi coExceedsDayEquiv.)
    //   - Đổi TRƯỚC dayCheckOutTime: giữ nguyên, tính từ lúc đổi → CO.
    //   Chỉ áp dụng khi CO cùng ngày calendar với lúc đổi (sameDayAsTransfer).
    const _coStdTime = parseTimeStr(
      newRoom.policy?.dayCheckOutTime ?? branchConfig?.checkOutTime ?? '12:00',
      DEFAULT_CONFIG.CO_HOUR,
    );
    const _coStdToday = setHM(tAt, _coStdTime.h, _coStdTime.m);
    const _coSameDayAsTransfer = co.getFullYear() === tAt.getFullYear()
      && co.getMonth() === tAt.getMonth()
      && co.getDate() === tAt.getDate();
    let newStart = tAt;
    if (_coSameDayAsTransfer && tAt > _coStdToday) {
      newStart = _coStdToday;   // đổi sau dayCheckOutTime → tính giờ từ dayCheckOutTime
    }
    const newRoomDurationH = (co - newStart) / 3600000;
    const newRoomHourSlots = newRoom.policy.hourSlots || [];
    const newRoomMinutes = (co - newStart) / 60000;
    const roundedHours = roundHoursWithTolerance(newRoomMinutes, tolerance);

    const maxSlotHours = newRoomHourSlots.length > 0
      ? Math.max(...newRoomHourSlots.map(s => getSlotHoursVal(s) || 0))
      : 0;

    const coClockHour = co.getHours() + co.getMinutes() / 60;
    const sameDayAsTransfer = co.getFullYear() === tAt.getFullYear()
      && co.getMonth() === tAt.getMonth()
      && co.getDate() === tAt.getDate();
    const coExceedsDayEquiv = !sameDayAsTransfer
      || coClockHour >= dayEquivalentHours;

    // ⭐ FIX 22/05/2026: nếu CÙNG NGÀY + chưa vượt mốc ngày + có ở (dù chỉ vài phút,
    //   roundedHours có thể = 0 do tolerance) → vẫn tính theo GIỜ với slot tối thiểu (≥1h),
    //   KHÔNG nhảy lên nguyên ngày. Tránh case "đến hiện tại" vừa chuyển 5 phút bị tính cả ngày.
    const effectiveRoundedHours = (!coExceedsDayEquiv && newRoomMinutes > 0)
      ? Math.max(1, roundedHours)
      : roundedHours;

    const canHourly = newRoomHourSlots.length > 0
      && effectiveRoundedHours > 0
      && effectiveRoundedHours <= maxSlotHours
      && !coExceedsDayEquiv;

    if (canHourly) {
      const slot = pickSlotHourly(newRoomHourSlots, effectiveRoundedHours);
      if (slot) {
        newRoomPricedHourly = true   // ⭐ đánh dấu: chặng mới đã tính GIÁ GIỜ tới `co`
        items.push({
          label: `[${newRoom.number}] Giá giờ (${fmtDT(newStart)} → ${fmtDT(co)}) — ${effectiveRoundedHours}h`,
          amount: slot.price,
          type: 'base',
          meta: {
            roomNumber: newRoom.number,
            policy: 'new',
            segment: 'newHourly',
            mode: 'hour',
            slotHours: slot.hours,
            roundedHours: effectiveRoundedHours,
            durationHours: newRoomDurationH,
            hourPrice: slot.price,
            isMinimum: !!slot.isMinimum,
          },
        });
      }
    } else {
      let newNights;
      if (transferAfterCoStd) {
        newNights = nights.slice(transferNightIdx);
      } else {
        newNights = nights.slice(transferNightIdx + 1);
      }
      if (newNights.length > 0) {
        const first = newNights[0];
        const last = newNights[newNights.length - 1];
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

  const lastNightEnd = nights.length > 0 ? nights[nights.length - 1].endAt : null;
  // ⭐ FIX 24/05/2026: bỏ "Trả phòng trễ" nếu chặng mới đã tính GIÁ GIỜ (đã gồm tới giờ trả).
  if (!newRoomPricedHourly) {
    pushLateCO(lastNightEnd);
  }

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