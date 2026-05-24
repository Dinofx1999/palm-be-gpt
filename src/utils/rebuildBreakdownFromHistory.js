/**
 * ════════════════════════════════════════════════════════════════════════════
 * rebuildBreakdownFromHistory.js — v3 (24/05/2026)
 *
 * Dựng lại TOÀN BỘ priceBreakdown từ transferHistory, hỗ trợ N lần chuyển phòng.
 * transferHistory = single source of truth.
 *
 *   CI ──(t1)── transferAt1 ──(t2)── transferAt2 ── … ── (tN) ── CO
 *    [phòng 1]              [phòng 2]            …      [phòng N+1]
 *
 * Mỗi CHẶNG là một lần ở độc lập → tính bằng calculatePrice (pricer chuẩn),
 * nên giữ đủ logic đêm/giờ/phụ thu/early-CI/late-CO. Chặng đã ở xong = finalized.
 *
 * Vì sao dùng calculatePrice thay computeMoveRoomBreakdown:
 *   computeMoveRoomBreakdown đếm "oldNights" theo ranh giới transfer → khi chain
 *   nhiều lần dễ lệch 1 đêm ở mốc transfer rơi đúng giờ checkout. calculatePrice
 *   tính một lần-ở [start → end] sạch sẽ, không phụ thuộc ngữ cảnh transfer.
 *
 * Ranh giới chặng (không trùng, không hở):
 *   - Chặng i:    [start_i → transferAt_i)      start_0 = actualCheckIn
 *   - Chặng cuối: [transferAt_last → plannedCheckOut]
 * ════════════════════════════════════════════════════════════════════════════
 */

const { calculatePrice } = require('./priceCalculator')

/**
 * Tính breakdown đầy đủ từ danh sách chặng đã resolve sẵn.
 * @param {Object}  args
 * @param {Array}   args.segments  [{ roomNumber, policy, priceType, adults, children,
 *                                     maxAdults, maxChildren, maxOccupancy,
 *                                     startAt, endAt, finalized }]
 * @param {Object}  args.branch
 * @param {boolean} [args.isFreeRoom=false]
 * @param {boolean} [args.mergeRows=true]  Gộp các dòng base liên tiếp cùng phòng
 *                                          thành 1 dòng/chặng (hiển thị gọn như UI cũ).
 * @returns {{ breakdown: Array, roomAmount: number, errors: Array }}
 */
function rebuildBreakdownFromHistory({ segments, branch, isFreeRoom = false, mergeRows = true }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { breakdown: [], roomAmount: 0, errors: [] }
  }

  let breakdown = []
  const errors = []
  let roomAmount = 0

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx]
    const isFirstSeg = segIdx === 0
    const isLastSeg  = segIdx === segments.length - 1
    if (isFreeRoom) {
      breakdown.push({
        label: `[${seg.roomNumber}] Miễn phí`,
        amount: 0,
        type: 'base',
        meta: { roomNumber: seg.roomNumber, freeRoom: true, ...(seg.finalized ? { finalized: true } : {}) },
      })
      continue
    }

    const r = calculatePrice({
      checkIn:      new Date(seg.startAt),
      checkOut:     new Date(seg.endAt),
      priceType:    seg.priceType || 'day',
      policy:       seg.policy,
      branch,
      adults:       seg.adults ?? 2,
      children:     seg.children ?? 0,
      maxAdults:    seg.maxAdults,
      maxChildren:  seg.maxChildren,
      maxOccupancy: seg.maxOccupancy,
    })

    if (r.error) {
      errors.push({ roomNumber: seg.roomNumber, error: r.error })
      continue
    }

    const segRows = []
    for (const b of r.breakdown) {
      const lbl = String(b.label || '')
      // ⭐ FIX 24/05/2026: LIÊN PHÒNG — bỏ phụ thu ở mép đổi phòng (spec mục II):
      //   - Chặng KHÔNG phải đầu tiên: bỏ "Nhận phòng sớm" (vào phòng giữa do đổi, không phải nhận sớm thật).
      //   - Chặng KHÔNG phải cuối cùng: bỏ "Trả phòng muộn/trễ" (rời phòng để đổi, không phải trả muộn thật).
      //   Vd: 201→604 lúc 14:29 thì [201] KHÔNG tính "trả muộn 2h29"; 604 vào không tính "nhận sớm".
      const isEarlyCI = lbl.includes('Nhận phòng sớm') || lbl.includes('early_checkin')
      const isLateCO  = lbl.includes('Trả phòng muộn') || lbl.includes('Trả phòng trễ') || lbl.includes('late_checkout')
      if (!isFirstSeg && isEarlyCI) continue
      if (!isLastSeg  && isLateCO)  continue
      const hasPrefix = /^\[[^\]]+\]\s/.test(lbl)
      segRows.push({
        label:  hasPrefix ? lbl : `[${seg.roomNumber}] ${lbl}`,
        amount: b.amount,
        type:   b.type === 'surcharge' ? 'surcharge' : 'base',
        meta: {
          ...(b.meta || {}),
          roomNumber: seg.roomNumber,
          ...(seg.finalized ? { finalized: true } : {}),
        },
      })
    }

    breakdown.push(...(mergeRows ? mergeSegmentRows(segRows, seg) : segRows))
    roomAmount += r.roomAmount
  }

  return { breakdown, roomAmount, errors }
}

/**
 * Gộp các dòng base "Giá ngày" liên tiếp của 1 chặng thành 1 dòng tổng,
 * giữ nguyên các dòng surcharge. Mục đích: hiển thị 1 dòng/chặng như UI cũ
 *   "[201] Giá ngày (22/05 14:45 → 24/05 08:19)  1.000.000"
 * Tổng tiền KHÔNG đổi.
 */
function mergeSegmentRows(rows, seg) {
  const baseRows = rows.filter(r => r.type === 'base')
  const otherRows = rows.filter(r => r.type !== 'base')
  if (baseRows.length <= 1) return rows

  const totalBase = baseRows.reduce((s, r) => s + (r.amount || 0), 0)
  const nights = baseRows.length
  const fmtDM = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`
  const fmtT  = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  const s = new Date(seg.startAt), e = new Date(seg.endAt)

  const merged = {
    label: `[${seg.roomNumber}] Giá ngày (${fmtDM(s)} ${fmtT(s)} → ${fmtDM(e)} ${fmtT(e)})`,
    amount: totalBase,
    type: 'base',
    meta: {
      roomNumber: seg.roomNumber,
      nights,
      segment: 'mergedNights',
      rangeStart: s.toISOString(),
      rangeEnd: e.toISOString(),
      ...(seg.finalized ? { finalized: true } : {}),
    },
  }
  return [merged, ...otherRows]
}

/**
 * Dựng `segments` từ transferHistory.
 * @param {Object}   args
 * @param {Date}     args.actualCheckIn
 * @param {Date}     args.plannedCheckOut
 * @param {Array}    args.transferHistory  (sẽ tự sort tăng dần theo transferAt)
 * @param {Function} args.policyResolver   (transferEntry, which:'from'|'to') => policyObjForCalc
 * @param {Function} [args.capacityResolver] (roomNumber) => {maxAdults,maxChildren,maxOccupancy}
 * @param {Object}   [args.occupancy]      { adults, children }
 * @param {string}   [args.priceType='day']
 * @returns {Array} segments
 */
function buildSegmentsFromHistory({
  actualCheckIn,
  plannedCheckOut,
  transferHistory,
  policyResolver,
  capacityResolver,
  occupancy = {},
  priceType = 'day',
}) {
  const hist = (Array.isArray(transferHistory) ? transferHistory : [])
    .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
    .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))

  if (hist.length === 0) return []

  const segments = []
  let start = new Date(actualCheckIn)

  for (let i = 0; i < hist.length; i++) {
    const t = hist[i]
    const roomNumber = t.fromRoomNumber
    const cap = capacityResolver ? capacityResolver(roomNumber) : {}
    segments.push({
      roomNumber,
      policy:       policyResolver(t, 'from'),
      priceType,
      adults:       occupancy.adults,
      children:     occupancy.children,
      maxAdults:    cap.maxAdults,
      maxChildren:  cap.maxChildren,
      maxOccupancy: cap.maxOccupancy,
      startAt:      start,
      endAt:        new Date(t.transferAt),
      finalized:    true,
    })
    start = new Date(t.transferAt)
  }

  const lastTransfer = hist[hist.length - 1]
  const lastRoomNumber = lastTransfer.toRoomNumber
  const cap = capacityResolver ? capacityResolver(lastRoomNumber) : {}
  segments.push({
    roomNumber:   lastRoomNumber,
    policy:       policyResolver(lastTransfer, 'to'),
    priceType,
    adults:       occupancy.adults,
    children:     occupancy.children,
    maxAdults:    cap.maxAdults,
    maxChildren:  cap.maxChildren,
    maxOccupancy: cap.maxOccupancy,
    startAt:      start,
    endAt:        new Date(plannedCheckOut),
    finalized:    false,
  })

  return segments
}

module.exports = {
  rebuildBreakdownFromHistory,
  buildSegmentsFromHistory,
  mergeSegmentRows,
}