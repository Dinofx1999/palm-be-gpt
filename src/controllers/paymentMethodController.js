const PaymentMethod = require('../models/PaymentMethod');

// ⭐ Bảng tra BIN theo tên ngân hàng (key viết thường, bỏ dấu cách)
const BANK_BIN_MAP = {
  vietcombank: '970436', vcb: '970436',
  mbbank: '970422', mb: '970422',
  techcombank: '970407', tcb: '970407',
  acb: '970416', bidv: '970418',
  vpbank: '970432', vpb: '970432',
  tpbank: '970423', vietinbank: '970415',
  sacombank: '970403', agribank: '970405',
  ocb: '970448', msb: '970426',
};

// ⭐ Helper: tự điền bankBin nếu thiếu, dựa vào bankName
function fillBankBin(body) {
  if (body?.type === 'transfer' && body.bankInfo && !body.bankInfo.bankBin) {
    const key = String(body.bankInfo.bankName || '').toLowerCase().replace(/\s+/g, '');
    const bin = BANK_BIN_MAP[key];
    if (bin) body.bankInfo.bankBin = bin;
  }
  return body;
}

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
    const data = await PaymentMethod.find(filter).sort({ name: 1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, type } = req.body;
    if (!name || !type)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, type' });
    const method = await PaymentMethod.create(fillBankBin(req.body));   // ⭐ tự điền BIN
    res.status(201).json({ success: true, message: 'Tạo hình thức thanh toán thành công', data: { paymentMethod: method } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const method = await PaymentMethod.findByIdAndUpdate(
      req.params.id,
      fillBankBin(req.body),   // ⭐ tự điền BIN
      { new: true, runValidators: true }
    );
    if (!method) return res.status(404).json({ success: false, message: 'Không tìm thấy hình thức thanh toán' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { paymentMethod: method } });
  } catch (err) { next(err); }
};

const toggle = async (req, res, next) => {
  try {
    const method = await PaymentMethod.findById(req.params.id);
    if (!method) return res.status(404).json({ success: false, message: 'Không tìm thấy hình thức thanh toán' });
    method.isActive = !method.isActive;
    await method.save();
    res.json({ success: true, message: 'Cập nhật thành công', data: { paymentMethod: method } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const method = await PaymentMethod.findByIdAndDelete(req.params.id);
    if (!method) return res.status(404).json({ success: false, message: 'Không tìm thấy hình thức thanh toán' });
    res.json({ success: true, message: 'Đã xoá' });
  } catch (err) { next(err); }
};

module.exports = { getAll, create, update, toggle, remove };