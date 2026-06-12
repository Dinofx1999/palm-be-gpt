'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * invoiceBuilder.js — Gộp kết quả engine thành HOÁ ĐƠN cuối. THUẦN.
 *
 * Trật tự tính (deterministic):
 *   roomAmount   = Σ amount các dòng phòng/phụ thu (từ engine — đã là SSOT)
 *   servicesAmount = dịch vụ
 *   subtotal     = (isFreeRoom ? 0 : roomAmount) + servicesAmount
 *   discount     = round(subtotal × discountPercent/100) + discountAmount
 *   totalAmount  = max(0, subtotal − discount + transferFee)
 *   remaining    = max(0, totalAmount − paidAmount)
 *
 * BẤT BIẾN: roomAmount luôn = Σ breakdown.amount (không nhận giá trị lưu sẵn).
 * ════════════════════════════════════════════════════════════════════════════
 */

const T = require('./lib/timeUtils')

function buildInvoice({
  breakdown,            // [ line ] từ engine (đã gộp các stay nếu là đoàn)
  servicesAmount = 0,
  discountPercent = 0,
  discountAmount = 0,
  transferFee = 0,
  paidAmount = 0,
  isFreeRoom = false,
}) {
  const roomAmount = (Array.isArray(breakdown) ? breakdown : [])
    .reduce((s, l) => s + (Number(l.amount) || 0), 0)

  const roomPart = isFreeRoom ? 0 : roomAmount
  const subtotal = roomPart + (Number(servicesAmount) || 0)
  const pctDisc = T.roundMoney(subtotal * (Number(discountPercent) || 0) / 100)
  const discount = pctDisc + (Number(discountAmount) || 0)
  const totalAmount = Math.max(0, T.roundMoney(subtotal - discount + (Number(transferFee) || 0)))
  const remainingAmount = Math.max(0, totalAmount - (Number(paidAmount) || 0))

  return {
    roomAmount: T.roundMoney(roomAmount),
    servicesAmount: T.roundMoney(servicesAmount),
    discount: T.roundMoney(discount),
    transferFee: T.roundMoney(transferFee),
    totalAmount,
    paidAmount: T.roundMoney(paidAmount),
    remainingAmount,
    breakdown,
  }
}

/** Build danh sách item hoá đơn (cho in/xuất) từ breakdown — bỏ dòng grace 0đ. */
function buildInvoiceItems(breakdown) {
  return (Array.isArray(breakdown) ? breakdown : [])
    .filter(l => !(l.meta && l.meta.freeGracePeriod && (Number(l.amount) || 0) === 0))
    .map(l => ({
      description: l.label,
      quantity: 1,
      unitPrice: T.roundMoney(l.amount),
      amount: T.roundMoney(l.amount),
    }))
}

module.exports = { buildInvoice, buildInvoiceItems }