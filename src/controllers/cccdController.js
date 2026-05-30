// backend/src/controllers/cccdController.js
// ════════════════════════════════════════════════════════════════════
// ⭐ NEW 30/05/2026: Giải mã QR mặt sau CCCD phía SERVER.
//   Bộ đọc chính: ZXing (@zxing/library) — khỏe hơn jsqr nhiều với QR dày.
//   Dự phòng:     jsqr.
//   Tiền xử lý:   sharp (xoay EXIF, xám, normalize, sharpen, + nhị phân hóa).
//   Thử nhiều kích thước + nhiều biến thể ảnh để bắt QR mờ/nghiêng/thiếu sáng.
//
//   ⚠️ CÀI: npm i @zxing/library jsqr sharp
//
//   QR CCCD: các trường ngăn cách "|":
//     [0] Số CCCD  [1] CMND cũ  [2] Họ tên  [3] Ngày sinh(ddMMyyyy)
//     [4] Giới tính [5] Địa chỉ  [6] Ngày cấp(ddMMyyyy)
// ════════════════════════════════════════════════════════════════════
const sharp = require('sharp');
const jsQR = require('jsqr');
const {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} = require('@zxing/library');

// ── Parser ───────────────────────────────────────────────────────────
function parseCccd(raw) {
  if (!raw) return null;
  const parts = String(raw).split('|');
  if (parts.length < 3) return null;
  const fmtDate = (s) => {
    const v = (s ?? '').trim();
    return /^\d{8}$/.test(v) ? `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4)}` : v;
  };
  const idNumber = (parts[0] ?? '').trim();
  const fullName = (parts[2] ?? '').trim();
  if (!/^\d{9,12}$/.test(idNumber) || !fullName) return null;
  return {
    idNumber,
    oldIdNumber: (parts[1] ?? '').trim(),
    fullName,
    dob:        fmtDate(parts[3]),
    gender:     (parts[4] ?? '').trim(),
    address:    (parts[5] ?? '').trim(),
    issueDate:  fmtDate(parts[6]),
    raw: String(raw),
  };
}

// ── ZXing: decode từ RGBA raw ─────────────────────────────────────────
function makeZxingReader() {
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  return reader;
}

// ZXing decode từ mảng grayscale 1 kênh.
function zxingDecodeGray(gray, width, height) {
  const argb = new Int32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i];
    argb[i] = (0xff << 24) | (g << 16) | (g << 8) | g;
  }
  try {
    const source = new RGBLuminanceSource(argb, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const reader = makeZxingReader();
    const result = reader.decode(bitmap);
    return result?.getText?.() ?? null;
  } catch {
    return null;
  }
}

// jsqr decode từ mảng grayscale 1 kênh.
function jsqrDecodeGray(gray, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const g = gray[i];
    rgba[j] = g; rgba[j + 1] = g; rgba[j + 2] = g; rgba[j + 3] = 255;
  }
  const r = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
  return r?.data ?? null;
}

// ── Tạo các biến thể ảnh GRAYSCALE 1 kênh để thử ─────────────────────
async function grayVariantsOf(buf, width) {
  const base = sharp(buf).rotate().resize({ width, withoutEnlargement: false }).grayscale();
  const out = [];
  // 1) normalize + sharpen
  out.push(await base.clone().normalize().sharpen().raw().toBuffer({ resolveWithObject: true }));
  // 2) tăng tương phản mạnh
  out.push(await base.clone().linear(1.4, -30).sharpen().raw().toBuffer({ resolveWithObject: true }));
  // 3) nhị phân hóa đen/trắng
  out.push(await base.clone().normalize().threshold(128).raw().toBuffer({ resolveWithObject: true }));
  return out;
}

async function decodeBuffer(buf) {
  const widths = [1000, 1400, 2000, 800, 2600];
  for (const w of widths) {
    let variants;
    try { variants = await grayVariantsOf(buf, w); }
    catch (e) { console.warn('[cccd] grayVariantsOf lỗi @', w, e.message); continue; }

    for (const v of variants) {
      const { data, info } = v;   // data = grayscale 1 kênh, length = w*h
      const zx = zxingDecodeGray(data, info.width, info.height);
      if (zx) return zx;
      const jq = jsqrDecodeGray(data, info.width, info.height);
      if (jq) return jq;
    }
  }
  return null;
}

// ── Endpoint ──────────────────────────────────────────────────────────
// POST /api/cccd/decode  — body: { image: "data:image/...;base64,..." } | base64 thuần
const decode = async (req, res) => {
  try {
    let image = req.body?.image;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ success: false, message: 'Thiếu ảnh (image base64)' });
    }
    const comma = image.indexOf(',');
    if (image.startsWith('data:') && comma !== -1) image = image.slice(comma + 1);

    let buf;
    try { buf = Buffer.from(image, 'base64'); }
    catch { return res.status(400).json({ success: false, message: 'Ảnh base64 không hợp lệ' }); }
    if (!buf || buf.length < 100) {
      return res.status(400).json({ success: false, message: 'Ảnh rỗng hoặc quá nhỏ' });
    }

    let raw = null;
    try { raw = await decodeBuffer(buf); }
    catch (e) { console.error('[cccd.decode] decodeBuffer error:', e.message); }

    if (!raw) {
      return res.status(422).json({
        success: false, code: 'QR_NOT_FOUND',
        message: 'Không tìm thấy mã QR trong ảnh. Chụp rõ MẶT SAU thẻ, đủ sáng, QR chiếm phần lớn khung.',
      });
    }

    const parsed = parseCccd(raw);
    if (!parsed) {
      // ⭐ Đọc được QR nhưng định dạng lạ → trả raw để chẩn đoán/chỉnh parser.
      return res.status(422).json({
        success: false, code: 'BAD_QR_FORMAT',
        message: 'Đọc được mã nhưng không đúng định dạng CCCD.',
        data: { raw },
      });
    }

    return res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[cccd.decode] error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Lỗi giải mã' });
  }
};

module.exports = { decode, parseCccd };