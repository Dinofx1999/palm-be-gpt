// backend/src/controllers/stockController.js
// ════════════════════════════════════════════════════════════════════
// Quản lý kho dịch vụ: nhập kho, điều chỉnh (kiểm kê), lịch sử, cảnh báo sắp hết.
// + Export 2 helper deductStock / restoreStock để serviceController gọi khi
//   bán / huỷ dịch vụ (tự trừ / hoàn kho + ghi StockMovement).
// ════════════════════════════════════════════════════════════════════
const Service       = require('../models/Service');
const StockMovement = require('../models/StockMovement');
const StockReceipt  = require('../models/StockReceipt');
const Transaction   = require('../models/Transaction');
const { logAction } = require('../utils/auditLogger');

// ── Helper: cảnh báo sắp hết hàng qua Telegram (non-blocking) ──────────
function notifyLowStock(service) {
  try {
    const tg = require('./telegramController');
    tg.notifyAudit({
      action:     'low_stock',
      entityType: 'Service',
      entityId:   service._id,
      branchId:   service.branchId,
      metadata: {
        serviceName:  service.name,
        stock:        service.stock,
        lowThreshold: service.lowStockThreshold,
        alert:        '⚠️ SẮP HẾT HÀNG — cần nhập thêm',
      },
    });
  } catch (e) {
    console.error('[stock] notifyLowStock failed (non-fatal):', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// HELPER dùng chung — gọi từ serviceController
// ════════════════════════════════════════════════════════════════════

// Trừ kho khi bán (type 'out'). Trả { ok, service, lowStock }.
//   Không chặn bán khi thiếu (cho phép âm) — chỉ ghi nhận + cảnh báo.
async function deductStock({ serviceId, quantity, bookingId = null, userId = null }) {
  const service = await Service.findById(serviceId);
  if (!service || !service.trackInventory) return { ok: false, skipped: true };

  const qty = Math.max(0, Number(quantity) || 0);
  if (qty === 0) return { ok: false, skipped: true };

  service.stock = (service.stock ?? 0) - qty;
  await service.save();

  await StockMovement.create({
    serviceId:    service._id,
    branchId:     service.branchId,
    type:         'out',
    quantity:     qty,
    bookingId,
    balanceAfter: service.stock,
    createdBy:    userId,
  });

  const lowStock = service.stock <= (service.lowStockThreshold ?? 0);
  if (lowStock) notifyLowStock(service);

  return { ok: true, service, lowStock };
}

// Hoàn kho khi huỷ/xoá (type 'adjust' delta dương). Dùng khi removeFromBooking.
async function restoreStock({ serviceId, quantity, bookingId = null, userId = null }) {
  const service = await Service.findById(serviceId);
  if (!service || !service.trackInventory) return { ok: false, skipped: true };

  const qty = Math.max(0, Number(quantity) || 0);
  if (qty === 0) return { ok: false, skipped: true };

  service.stock = (service.stock ?? 0) + qty;
  await service.save();

  await StockMovement.create({
    serviceId:    service._id,
    branchId:     service.branchId,
    type:         'adjust',
    quantity:     qty,            // delta dương = hoàn lại
    note:         'Hoàn kho do huỷ/xoá dịch vụ khỏi booking',
    bookingId,
    balanceAfter: service.stock,
    createdBy:    userId,
  });

  return { ok: true, service };
}

// Điều chỉnh kho theo DELTA (dùng khi đổi số lượng dịch vụ trong booking).
//   delta < 0: bán thêm (trừ kho) ; delta > 0: giảm số lượng (hoàn kho).
async function adjustStockByDelta({ serviceId, delta, bookingId = null, userId = null }) {
  const service = await Service.findById(serviceId);
  if (!service || !service.trackInventory) return { ok: false, skipped: true };

  const d = Number(delta) || 0;
  if (d === 0) return { ok: false, skipped: true };

  service.stock = (service.stock ?? 0) + d;   // d âm = trừ, d dương = hoàn
  await service.save();

  await StockMovement.create({
    serviceId:    service._id,
    branchId:     service.branchId,
    type:         d < 0 ? 'out' : 'adjust',
    quantity:     Math.abs(d),
    note:         'Đổi số lượng dịch vụ trong booking',
    bookingId,
    balanceAfter: service.stock,
    createdBy:    userId,
  });

  const lowStock = service.stock <= (service.lowStockThreshold ?? 0);
  if (d < 0 && lowStock) notifyLowStock(service);

  return { ok: true, service, lowStock };
}

// ════════════════════════════════════════════════════════════════════
// EXPRESS HANDLERS
// ════════════════════════════════════════════════════════════════════

// POST /api/stock/in — nhập kho
//   Body: { serviceId, quantity, unitCost?, supplier?, note? }
const stockIn = async (req, res, next) => {
  try {
    const { serviceId, quantity, unitCost = 0, supplier = '', note = '' } = req.body;
    if (!serviceId) return res.status(400).json({ success: false, message: 'Thiếu serviceId' });
    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ success: false, message: 'Số lượng nhập phải > 0' });

    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' });

    // Tự bật trackInventory nếu nhập kho lần đầu (để dịch vụ này bắt đầu quản kho)
    if (!service.trackInventory) service.trackInventory = true;
    service.stock = (service.stock ?? 0) + qty;
    await service.save();

    const mv = await StockMovement.create({
      serviceId:    service._id,
      branchId:     service.branchId,
      type:         'in',
      quantity:     qty,
      unitCost:     Number(unitCost) || 0,
      supplier:     String(supplier || '').trim(),
      note:         String(note || '').trim(),
      balanceAfter: service.stock,
      createdBy:    req.user?.id || null,
    });

    await logAction({
      entityType: 'Service', entityId: service._id,
      action: 'stock_in',
      description: `Nhập kho "${service.name}" +${qty} → tồn ${service.stock}`,
      user: req.user, branchId: service.branchId,
      metadata: { serviceName: service.name, quantity: qty, unitCost, supplier, balanceAfter: service.stock },
    });

    res.status(201).json({ success: true, message: 'Đã nhập kho', data: { service, movement: mv } });
  } catch (err) { next(err); }
};

// POST /api/stock/adjust — kiểm kê / điều chỉnh tồn về số tuyệt đối
//   Body: { serviceId, newStock, note? }   → ghi movement 'adjust' với delta = newStock - cũ
const stockAdjust = async (req, res, next) => {
  try {
    const { serviceId, newStock, note = '' } = req.body;
    if (!serviceId) return res.status(400).json({ success: false, message: 'Thiếu serviceId' });
    const target = Number(newStock);
    if (isNaN(target)) return res.status(400).json({ success: false, message: 'Số tồn mới không hợp lệ' });

    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' });

    const before = service.stock ?? 0;
    const delta  = target - before;
    if (!service.trackInventory) service.trackInventory = true;
    service.stock = target;
    await service.save();

    const mv = await StockMovement.create({
      serviceId:    service._id,
      branchId:     service.branchId,
      type:         'adjust',
      quantity:     Math.abs(delta),
      note:         String(note || '').trim() || `Kiểm kê: ${before} → ${target}`,
      balanceAfter: service.stock,
      createdBy:    req.user?.id || null,
    });

    await logAction({
      entityType: 'Service', entityId: service._id,
      action: 'stock_adjust',
      description: `Kiểm kê "${service.name}": ${before} → ${target} (${delta >= 0 ? '+' : ''}${delta})`,
      user: req.user, branchId: service.branchId,
      metadata: { serviceName: service.name, before, after: target, delta },
    });

    const lowStock = service.stock <= (service.lowStockThreshold ?? 0);
    if (lowStock) notifyLowStock(service);

    res.json({ success: true, message: 'Đã điều chỉnh tồn kho', data: { service, movement: mv } });
  } catch (err) { next(err); }
};

// GET /api/stock/movements?serviceId=&branchId=&type=&page=&limit=
const getMovements = async (req, res, next) => {
  try {
    const { serviceId, branchId, type } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

    const filter = {};
    if (serviceId) filter.serviceId = serviceId;
    if (branchId)  filter.branchId = branchId;
    if (type)      filter.type = type;

    const [items, total] = await Promise.all([
      StockMovement.find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('serviceId', 'name unit')
        .populate('createdBy', 'fullName username')
        .populate('bookingId', 'bookingCode')
        .lean(),
      StockMovement.countDocuments(filter),
    ]);

    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) { next(err); }
};

// GET /api/stock/low?branchId= — danh sách dịch vụ sắp hết / hết hàng
const getLowStock = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const filter = { trackInventory: true };
    if (branchId) filter.branchId = branchId;

    const services = await Service.find(filter).select('name unit stock lowStockThreshold branchId').lean();
    const low = services
      .filter(s => (s.stock ?? 0) <= (s.lowStockThreshold ?? 0))
      .sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));

    res.json({ success: true, data: { items: low, total: low.length } });
  } catch (err) { next(err); }
};

// ════════════════════════════════════════════════════════════════════
// PHIẾU NHẬP KHO (nhập nhiều mặt hàng 1 lần)
// ════════════════════════════════════════════════════════════════════

// Sinh mã phiếu PN-YYYYMMDD-xxxx
function genReceiptCode() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PN-${ymd}-${rand}`;
}

// POST /api/stock/receipts — tạo phiếu nhập nhiều mặt hàng (NHÁP — chưa cộng tồn)
//   Body: { branchId?, supplier?, note?, paymentMethod?, items: [{ serviceId, quantity, unitCost? }] }
const createReceipt = async (req, res, next) => {
  try {
    const { branchId = null, supplier = '', note = '', paymentMethod = 'cash', items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Phiếu nhập cần ít nhất 1 mặt hàng' });
    }

    // Validate + load services (chỉ để snapshot, CHƯA cộng tồn)
    const lineItems = [];
    let totalQuantity = 0, totalAmount = 0;
    for (const it of items) {
      const qty = Number(it?.quantity);
      if (!it?.serviceId || !qty || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Mỗi dòng cần serviceId và số lượng > 0' });
      }
      const service = await Service.findById(it.serviceId);
      if (!service) {
        return res.status(404).json({ success: false, message: `Không tìm thấy dịch vụ ${it.serviceId}` });
      }
      const unitCost = Number(it.unitCost) || 0;
      const lineTotal = qty * unitCost;
      lineItems.push({ service, qty, unitCost, lineTotal });
      totalQuantity += qty;
      totalAmount += lineTotal;
    }

    // Tạo phiếu NHÁP (header) — chưa đụng tồn kho, chưa tạo phiếu chi
    const receipt = await StockReceipt.create({
      receiptCode: genReceiptCode(),
      branchId, supplier: String(supplier).trim(), note: String(note).trim(),
      paymentMethod: ['cash', 'transfer', 'card', 'other'].includes(paymentMethod) ? paymentMethod : 'cash',
      items: lineItems.map(li => ({
        serviceId:   li.service._id,
        serviceName: li.service.name,
        unit:        li.service.unit ?? '',
        quantity:    li.qty,
        unitCost:    li.unitCost,
        lineTotal:   li.lineTotal,
      })),
      totalQuantity, totalAmount,
      status: 'draft',
      createdBy: req.user?.id || null,
    });

    await logAction({
      entityType: 'StockReceipt', entityId: receipt._id,
      action: 'stock_receipt_create',
      description: `Tạo phiếu nhập (nháp) ${receipt.receiptCode}: ${lineItems.length} mặt hàng, tổng ${totalQuantity} đơn vị${totalAmount ? `, ${totalAmount.toLocaleString('vi-VN')}đ` : ''}`,
      user: req.user, branchId,
      metadata: { receiptCode: receipt.receiptCode, supplier, itemCount: lineItems.length, totalQuantity, totalAmount, status: 'draft' },
    });

    res.status(201).json({ success: true, message: 'Đã tạo phiếu nhập (chờ duyệt)', data: { receipt } });
  } catch (err) { next(err); }
};

// POST /api/stock/receipts/:id/approve — DUYỆT phiếu: cộng tồn + tạo phiếu chi
//   Body: { paymentMethod? } (ghi đè phương thức chi nếu muốn)
const approveReceipt = async (req, res, next) => {
  try {
    const receipt = await StockReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu nhập' });
    if (receipt.status === 'approved') {
      return res.status(400).json({ success: false, message: 'Phiếu này đã được duyệt' });
    }
    if (receipt.status === 'rejected') {
      return res.status(400).json({ success: false, message: 'Phiếu đã bị từ chối, không thể duyệt' });
    }

    // 1) Cộng tồn từng dòng + ghi movement 'in' gắn receiptId
    for (const it of receipt.items) {
      const service = await Service.findById(it.serviceId);
      if (!service) continue;   // dịch vụ đã bị xoá → bỏ qua dòng đó
      if (!service.trackInventory) service.trackInventory = true;   // tự bật kho khi duyệt nhập
      service.stock = (service.stock ?? 0) + it.quantity;
      await service.save();

      await StockMovement.create({
        serviceId:    service._id,
        branchId:     service.branchId ?? receipt.branchId,
        type:         'in',
        quantity:     it.quantity,
        unitCost:     it.unitCost,
        supplier:     receipt.supplier,
        note:         `Duyệt phiếu ${receipt.receiptCode}`,
        receiptId:    receipt._id,
        balanceAfter: service.stock,
        createdBy:    req.user?.id || null,
      });
    }

    // 2) Tạo phiếu chi (nếu có tiền + có branchId)
    let expenseTx = null;
    const pm = ['cash', 'transfer', 'card', 'other'].includes(req.body?.paymentMethod)
      ? req.body.paymentMethod
      : (receipt.paymentMethod || 'cash');

    // branchId cho phiếu chi: ưu tiên của phiếu, fallback branch của 1 dịch vụ trong phiếu
    let expBranchId = receipt.branchId;
    if (!expBranchId && receipt.items.length) {
      const anySrv = await Service.findById(receipt.items[0].serviceId).select('branchId').lean();
      expBranchId = anySrv?.branchId || null;
    }

    if (receipt.totalAmount > 0 && expBranchId && req.user?.id) {
      // Tự gắn ca trực đang mở của chi nhánh (giống route transactions)
      let shiftId = null;
      try {
        const Shift = require('../models/Shift');
        const openShift = await Shift.findOne({ branchId: expBranchId, status: 'open' }).select('_id').lean();
        if (openShift) shiftId = openShift._id;
      } catch { /* không có module Shift hoặc lỗi → bỏ qua */ }

      expenseTx = await Transaction.create({
        type:        'expense',
        category:    'Nhập kho',
        amount:      receipt.totalAmount,
        description: `Nhập kho phiếu ${receipt.receiptCode}${receipt.supplier ? ` — NCC: ${receipt.supplier}` : ''} (${receipt.items.length} mặt hàng)`,
        branchId:    expBranchId,
        occurredOn:  new Date(),
        paymentMethod: pm,
        recordedBy:  req.user.id,
        shiftId,
        relatedType: 'manual',
        relatedId:   receipt._id,
        note:        `Tự tạo khi duyệt phiếu nhập kho ${receipt.receiptCode}`,
      });
    }

    // 3) Cập nhật trạng thái phiếu
    receipt.status = 'approved';
    receipt.approvedBy = req.user?.id || null;
    receipt.approvedAt = new Date();
    receipt.paymentMethod = pm;
    if (expenseTx) receipt.expenseTransactionId = expenseTx._id;
    await receipt.save();

    await logAction({
      entityType: 'StockReceipt', entityId: receipt._id,
      action: 'stock_receipt_approve',
      description: `Duyệt phiếu nhập ${receipt.receiptCode}: cộng tồn ${receipt.totalQuantity} đơn vị${expenseTx ? `, tạo phiếu chi ${receipt.totalAmount.toLocaleString('vi-VN')}đ` : ''}`,
      user: req.user, branchId: expBranchId,
      metadata: { receiptCode: receipt.receiptCode, totalAmount: receipt.totalAmount, expenseTransactionId: expenseTx?._id || null },
    });

    const populated = await StockReceipt.findById(receipt._id)
      .populate('approvedBy', 'fullName username').lean();

    res.json({
      success: true,
      message: expenseTx
        ? `Đã duyệt & tạo phiếu chi ${receipt.totalAmount.toLocaleString('vi-VN')}đ`
        : (receipt.totalAmount > 0 ? 'Đã duyệt (không tạo được phiếu chi — thiếu chi nhánh)' : 'Đã duyệt (phiếu không có tiền nhập)'),
      data: { receipt: populated, expenseTransaction: expenseTx },
    });
  } catch (err) { next(err); }
};

// POST /api/stock/receipts/:id/reject — TỪ CHỐI phiếu nháp (không đụng tồn)
//   Body: { reason? }
const rejectReceipt = async (req, res, next) => {
  try {
    const receipt = await StockReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu nhập' });
    if (receipt.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Chỉ có thể từ chối phiếu đang chờ duyệt' });
    }

    receipt.status = 'rejected';
    receipt.rejectedBy = req.user?.id || null;
    receipt.rejectedAt = new Date();
    receipt.rejectReason = String(req.body?.reason || '').trim();
    await receipt.save();

    await logAction({
      entityType: 'StockReceipt', entityId: receipt._id,
      action: 'stock_receipt_reject',
      description: `Từ chối phiếu nhập ${receipt.receiptCode}${receipt.rejectReason ? `: ${receipt.rejectReason}` : ''}`,
      user: req.user, branchId: receipt.branchId,
      metadata: { receiptCode: receipt.receiptCode, reason: receipt.rejectReason },
    });

    res.json({ success: true, message: 'Đã từ chối phiếu nhập', data: { receipt } });
  } catch (err) { next(err); }
};

// POST /api/stock/receipts/:id/cancel — HUỶ DUYỆT phiếu đã duyệt
//   → hoàn (trừ lại) tồn đã cộng + huỷ phiếu chi (soft cancel) + set status 'cancelled'
//   Body: { reason? }
const cancelReceipt = async (req, res, next) => {
  try {
    const receipt = await StockReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu nhập' });
    if (receipt.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Chỉ huỷ duyệt được phiếu đã duyệt' });
    }
    const reason = String(req.body?.reason || '').trim();

    // 1) Hoàn tồn: trừ lại đúng số đã cộng + ghi movement 'adjust' (âm)
    for (const it of receipt.items) {
      const service = await Service.findById(it.serviceId);
      if (!service) continue;
      service.stock = (service.stock ?? 0) - it.quantity;
      await service.save();

      await StockMovement.create({
        serviceId:    service._id,
        branchId:     service.branchId ?? receipt.branchId,
        type:         'adjust',
        quantity:     it.quantity,   // số bị trừ lại
        note:         `Huỷ duyệt phiếu ${receipt.receiptCode}${reason ? ` — ${reason}` : ''}`,
        receiptId:    receipt._id,
        balanceAfter: service.stock,
        createdBy:    req.user?.id || null,
      });
    }

    // 2) Huỷ phiếu chi (soft cancel — giữ bản ghi, list ẩn mặc định)
    if (receipt.expenseTransactionId) {
      try {
        await Transaction.findByIdAndUpdate(receipt.expenseTransactionId, {
          $set: {
            isCancelled: true,
            cancelledAt: new Date(),
            cancelledReason: `Huỷ duyệt phiếu nhập ${receipt.receiptCode}${reason ? ` — ${reason}` : ''}`,
          },
        });
      } catch (e) {
        console.error('[stock] Huỷ phiếu chi thất bại (non-fatal):', e.message);
      }
    }

    // 3) Cập nhật trạng thái phiếu
    receipt.status = 'cancelled';
    receipt.cancelledBy = req.user?.id || null;
    receipt.cancelledAt = new Date();
    receipt.cancelReason = reason;
    await receipt.save();

    await logAction({
      entityType: 'StockReceipt', entityId: receipt._id,
      action: 'stock_receipt_cancel',
      description: `Huỷ duyệt phiếu nhập ${receipt.receiptCode}: hoàn tồn ${receipt.totalQuantity} đơn vị${receipt.expenseTransactionId ? ', huỷ phiếu chi' : ''}${reason ? ` — ${reason}` : ''}`,
      user: req.user, branchId: receipt.branchId,
      metadata: { receiptCode: receipt.receiptCode, reason, expenseTransactionId: receipt.expenseTransactionId || null },
    });

    res.json({ success: true, message: 'Đã huỷ duyệt: hoàn tồn kho và huỷ phiếu chi', data: { receipt } });
  } catch (err) { next(err); }
};

// GET /api/stock/receipts?branchId=&page=&limit=
const listReceipts = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = {};
    if (branchId) filter.branchId = branchId;

    const [items, total] = await Promise.all([
      StockReceipt.find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('createdBy', 'fullName username')
        .lean(),
      StockReceipt.countDocuments(filter),
    ]);

    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) { next(err); }
};

// GET /api/stock/receipts/:id
const getReceipt = async (req, res, next) => {
  try {
    const receipt = await StockReceipt.findById(req.params.id)
      .populate('createdBy', 'fullName username').lean();
    if (!receipt) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu nhập' });
    res.json({ success: true, data: receipt });
  } catch (err) { next(err); }
};

module.exports = {
  // helpers (cho serviceController)
  deductStock, restoreStock, adjustStockByDelta,
  // express handlers
  stockIn, stockAdjust, getMovements, getLowStock,
  // phiếu nhập
  createReceipt, listReceipts, getReceipt, approveReceipt, rejectReceipt, cancelReceipt,
};