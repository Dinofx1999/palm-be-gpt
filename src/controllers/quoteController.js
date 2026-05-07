const Quote = require('../models/Quote');
const Room = require('../models/Room');
const RoomType = require('../models/RoomType');
const Branch = require('../models/Branch');
const Booking = require('../models/Booking');
const PricePolicy = require('../models/PricePolicy');
const Floor = require('../models/Floor');
const mongoose = require('mongoose');

// ⭐ Constants
const VALID_STATUSES = [
  'draft', 'sent', 'viewed', 'confirmed', 'accepted',
  'rejected', 'expired', 'converted', 'cancelled',
];

// ⭐ State machine NỚI LỎNG
const STATUS_TRANSITIONS = {
  draft:     null,
  sent:      ['draft', 'viewed', 'confirmed'],
  viewed:    ['sent', 'draft'],
  confirmed: ['draft', 'sent', 'viewed'],
  accepted:  ['draft', 'sent', 'viewed', 'confirmed'],
  rejected:  ['draft', 'sent', 'viewed', 'confirmed'],
  expired:   null,
  cancelled: null,
  converted: ['confirmed', 'accepted'],
};

// ── CREATE quote ─────────────────
const create = async (req, res, next) => {
  try {
    const {
      branchId, customerName, customerPhone, groupName,
      checkIn, checkOut, rooms, totalAmount, nights, notes,
    } = req.body;

    if (!branchId || !checkIn || !checkOut || !Array.isArray(rooms) || rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    }

    const enrichedRooms = await Promise.all(rooms.map(async (line) => {
      let images = [];
      let amenities = [];
      let description = '';
      let policyInfo = {
        checkInTime: '', checkOutTime: '',
        adultSurcharge: 0, childSurcharge: 0,
        extraAdults: 0, extraChildren: 0,
      };
      let alternativeRooms = [];
      let aggregatedImages = [];
      const displayMode = line.displayMode ?? 'selected';

      try {
        const roomDoc = await Room.findById(line.roomId).lean();
        if (roomDoc) images = roomDoc.images ?? [];

        const typeDoc = await RoomType.findById(line.typeId).populate('amenities').lean();
        if (typeDoc) {
          amenities = (typeDoc.amenities ?? []).map(a => `${a.icon ?? ''} ${a.name}`.trim());
          description = typeDoc.description ?? '';
        }

        if (line.policyId) {
          const policy = await PricePolicy.findById(line.policyId).lean();
          if (policy) {
            const capacity = typeDoc?.capacity ?? line.capacity ?? 2;
            const adults = line.adults ?? 0;
            const children = line.children ?? 0;
            policyInfo = {
              checkInTime:    policy.dayCheckInTime  ?? '',
              checkOutTime:   policy.dayCheckOutTime ?? '',
              adultSurcharge: policy.dayAdultSurcharge ?? 0,
              childSurcharge: policy.dayChildSurcharge ?? 0,
              extraAdults:    Math.max(0, adults - capacity),
              extraChildren:  children,
            };
          }
        }

        if (Array.isArray(line.alternativeRoomIds) && line.alternativeRoomIds.length > 0) {
          const altRoomDocs = await Room.find({
            _id: { $in: line.alternativeRoomIds },
          }).lean();

          if (displayMode === 'by_type') {
            const allImagesSet = new Set();
            for (const img of (images ?? [])) {
              if (img) allImagesSet.add(img);
            }
            for (const r of altRoomDocs) {
              for (const img of (r.images ?? [])) {
                if (img) allImagesSet.add(img);
              }
            }
            aggregatedImages = Array.from(allImagesSet);
            alternativeRooms = [];
          } else {
            const floorIds = [...new Set(altRoomDocs.map(r => String(r.floorId)).filter(Boolean))];
            const floorDocs = await Floor.find({ _id: { $in: floorIds } }).lean();
            const floorMap = new Map(floorDocs.map(f => [String(f._id), f.name]));

            alternativeRooms = altRoomDocs.map(r => ({
              roomId:     r._id,
              roomNumber: r.number,
              floorName:  floorMap.get(String(r.floorId)) ?? '',
              images:     r.images ?? [],
            }));
          }
        }
      } catch (e) {
        console.warn('[create quote] enrich error:', e.message);
      }

      const { alternativeRoomIds, displayMode: _, ...lineWithoutInternals } = line;

      if (displayMode === 'by_type') {
        return {
          ...lineWithoutInternals,
          roomNumber: '',
          roomId:     null,
          images:     aggregatedImages,
          amenities, description,
          policyInfo,
          alternativeRooms: [],
          aggregatedImages,
          displayMode,
        };
      }

      return {
        ...lineWithoutInternals,
        images, amenities, description,
        policyInfo,
        alternativeRooms,
        displayMode,
      };
    }));

    const branch = await Branch.findById(branchId).lean();

    const branchPolicies = {
      cancellationPolicy: branch?.quotePolicy?.cancellationPolicy ?? '',
      requiredDocuments:  branch?.quotePolicy?.requiredDocuments  ?? '',
      hotelRules:         branch?.quotePolicy?.hotelRules         ?? '',
      includedServices:   branch?.quotePolicy?.includedServices   ?? [],
      contact: {
        phone:   branch?.phone   ?? '',
        email:   branch?.email   ?? '',
        address: branch?.address ?? '',
        city:    branch?.city    ?? '',
        zalo:    branch?.phone ? String(branch.phone).replace(/\D/g, '') : '',
      },
    };

    let finalRooms = enrichedRooms;
    const isAllByType = enrichedRooms.every(r => r.displayMode === 'by_type');
    if (isAllByType) {
      const groupedByType = new Map();
      for (const line of enrichedRooms) {
        const key = String(line.typeId);
        if (!groupedByType.has(key)) {
          groupedByType.set(key, { ...line, _quantity: 1, _totalRoomAmount: line.roomAmount ?? 0 });
        } else {
          const existing = groupedByType.get(key);
          existing._quantity += 1;
          existing._totalRoomAmount += (line.roomAmount ?? 0);
        }
      }
      finalRooms = Array.from(groupedByType.values()).map(line => ({
        ...line,
        quantity:   line._quantity,
        roomAmount: line._totalRoomAmount,
        _quantity: undefined,
        _totalRoomAmount: undefined,
      }));
    }

    const userId = req.user?.id ?? req.user?._id ?? null;

    const quote = await Quote.create({
      branchId,
      branchName: branch?.name ?? '',
      customerName: customerName ?? '',
      customerPhone: customerPhone ?? '',
      groupName: groupName ?? '',
      checkIn, checkOut,
      nights: nights ?? 1,
      rooms: finalRooms,
      totalAmount: totalAmount ?? 0,
      notes: notes ?? '',
      branchPolicies,
      displayMode: isAllByType ? 'by_type'
                  : enrichedRooms.some(r => r.displayMode === 'with_alternatives') ? 'with_alternatives'
                  : 'selected',
      status:    'draft',
      createdBy: userId,
      statusHistory: [{
        status:    'draft',
        changedBy: userId,
        changedAt: new Date(),
        note:      'Tạo báo giá',
      }],
    });

    const populated = await Quote.findById(quote._id)
      .populate('createdBy',   'name email avatar')
      .populate('confirmedBy', 'name email avatar')
      .lean();

    res.status(201).json({
      success: true,
      data: {
        quote: populated,
        publicUrl: `/quote/${quote.token}`,
      },
    });
  } catch (err) { next(err); }
};

// ── GET ALL ──────────────────
const getAll = async (req, res, next) => {
  try {
    const { branchId, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (branchId) filter.branchId = branchId;
    if (status)   filter.status   = status;

    const total = await Quote.countDocuments(filter);
    const data  = await Quote.find(filter)
      .populate('createdBy',   'name email avatar')
      .populate('confirmedBy', 'name email avatar')
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } });
  } catch (err) { next(err); }
};

// ── GET PUBLIC ──────────────
const getPublic = async (req, res, next) => {
  try {
    const { token } = req.params;
    const quote = await Quote.findOne({ token })
      .populate('createdBy',   'name email avatar')
      .populate('confirmedBy', 'name email avatar')
      .lean();

    if (!quote) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy báo giá' });
    }
    if (quote.expiresAt && new Date(quote.expiresAt) < new Date()) {
      return res.status(410).json({ success: false, message: 'Báo giá đã hết hạn' });
    }

    if (quote.status === 'sent') {
      Quote.findByIdAndUpdate(quote._id, {
        status: 'viewed',
        $push: {
          statusHistory: {
            status:    'viewed',
            changedBy: null,
            changedAt: new Date(),
            note:      'Khách đã xem báo giá',
          },
        },
      }).catch(err => console.warn('[getPublic] auto-update viewed failed:', err.message));
      quote.status = 'viewed';
    }

    res.json({ success: true, data: { quote } });
  } catch (err) { next(err); }
};

// ⭐ NEW: PUBLIC ACCEPT — khách tự click chấp nhận từ trang public
//   Endpoint: POST /quotes/public-accept/:token
//   Không cần auth — chỉ cần token đúng + status hiện tại là 'confirmed'
const publicAccept = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { acknowledged } = req.body;

    // ⭐ Khách phải tick checkbox đồng ý
    if (acknowledged !== true) {
      return res.status(400).json({
        success: false,
        message: 'Quý khách cần xác nhận đã đọc báo giá trước khi đồng ý',
      });
    }

    const quote = await Quote.findOne({ token });
    if (!quote) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy báo giá' });
    }

    // ⭐ Check hết hạn
    if (quote.expiresAt && new Date(quote.expiresAt) < new Date()) {
      return res.status(410).json({ success: false, message: 'Báo giá đã hết hạn' });
    }

    // ⭐ Chỉ cho phép accept khi đang ở 'confirmed'
    //   (báo giá phải được nv xác nhận giá trước, khách mới có thể chốt)
    if (quote.status !== 'confirmed') {
      return res.status(400).json({
        success: false,
        message: quote.status === 'accepted'
          ? 'Báo giá này đã được chấp nhận trước đó'
          : 'Báo giá chưa được khách sạn xác nhận. Vui lòng liên hệ trực tiếp khách sạn.',
      });
    }

    const updated = await Quote.findByIdAndUpdate(
      quote._id,
      {
        status: 'accepted',
        $push: {
          statusHistory: {
            status:    'accepted',
            changedBy: null,  // null = khách (qua public link)
            changedAt: new Date(),
            note:      'Khách đồng ý đặt phòng qua trang công khai',
          },
        },
      },
      { new: true },
    )
      .populate('createdBy',   'name email avatar')
      .populate('confirmedBy', 'name email avatar')
      .lean();

    res.json({
      success: true,
      message: 'Cảm ơn Quý khách đã xác nhận đặt phòng',
      data: { quote: updated },
    });
  } catch (err) {
    console.error('[publicAccept] error:', err);
    next(err);
  }
};

// ⭐ CHANGE STATUS (admin endpoint, có auth)
const changeStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status: newStatus, note } = req.body;

    if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        message: `Trạng thái không hợp lệ. Phải là một trong: ${VALID_STATUSES.join(', ')}`,
      });
    }

    const quote = await Quote.findById(id);
    if (!quote) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy báo giá' });
    }

    const oldStatus = quote.status;

    if (oldStatus === newStatus) {
      return res.status(400).json({
        success: false,
        message: 'Trạng thái mới giống trạng thái hiện tại',
      });
    }

    const allowedFrom = STATUS_TRANSITIONS[newStatus];
    if (allowedFrom && !allowedFrom.includes(oldStatus)) {
      return res.status(400).json({
        success: false,
        message: `Không thể chuyển từ "${oldStatus}" sang "${newStatus}". Trạng thái nguồn hợp lệ: ${allowedFrom.join(', ')}`,
      });
    }

    const userId = req.user?.id ?? req.user?._id ?? null;

    const update = {
      status: newStatus,
      $push: {
        statusHistory: {
          status:    newStatus,
          changedBy: userId,
          changedAt: new Date(),
          note:      note ?? '',
        },
      },
    };

    if (newStatus === 'confirmed') {
      update.confirmedBy = userId;
      update.confirmedAt = new Date();
    }

    if (oldStatus === 'confirmed' && newStatus !== 'confirmed') {
      update.confirmedBy = null;
      update.confirmedAt = null;
    }

    const updated = await Quote.findByIdAndUpdate(id, update, { new: true })
      .populate('createdBy',   'name email avatar')
      .populate('confirmedBy', 'name email avatar')
      .lean();

    res.json({
      success: true,
      message: `Đã đổi trạng thái sang "${newStatus}"`,
      data: { quote: updated },
    });
  } catch (err) {
    console.error('[changeStatus] error:', err);
    next(err);
  }
};

// ── REMOVE ──────────────────────
const remove = async (req, res, next) => {
  try {
    await Quote.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xoá' });
  } catch (err) { next(err); }
};

// ── GET ALTERNATIVE ROOMS ─────────
const getAlternativeRooms = async (req, res, next) => {
  try {
    const { branchId, typeId, checkIn, checkOut, excludeRoomIds = '' } = req.query;
    if (!branchId || !typeId || !checkIn || !checkOut) {
      return res.status(400).json({ success: false, message: 'Thiếu params' });
    }

    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    const excludeIds = excludeRoomIds.split(',').filter(Boolean);

    const branchObjId = mongoose.Types.ObjectId.isValid(branchId)
      ? new mongoose.Types.ObjectId(branchId) : branchId;
    const typeObjId = mongoose.Types.ObjectId.isValid(typeId)
      ? new mongoose.Types.ObjectId(typeId) : typeId;

    let allRooms = await Room.find({
      $or: [
        { branchId: branchId },
        { branchId: branchObjId },
      ],
      $and: [
        { _id: { $nin: excludeIds } },
        {
          $or: [
            { typeId: typeId },
            { typeId: typeObjId },
            { roomTypeId: typeId },
            { roomTypeId: typeObjId },
          ],
        },
      ],
    }).sort({ number: 1 }).lean();

    if (allRooms.length === 0) {
      allRooms = await Room.find({
        branchId,
        _id: { $nin: excludeIds },
      }).sort({ number: 1 }).lean();
      allRooms = allRooms.filter(r => {
        const rTypeId = r.typeId ? String(r.typeId) : (r.roomTypeId ? String(r.roomTypeId) : '');
        return rTypeId === String(typeId);
      });
    }

    if (allRooms.length === 0) {
      return res.json({ success: true, data: { rooms: [], total: 0 } });
    }

    const conflicts = await Booking.find({
      $or: [
        { branchId: branchId },
        { branchId: branchObjId },
      ],
      $and: [
        {
          $or: [
            { status: { $in: ['confirmed', 'reserved', 'checked_in', 'pending'] } },
            { status: { $exists: false } },
          ],
        },
        { checkIn:  { $lt: co } },
        { checkOut: { $gt: ci } },
      ],
    }).lean();

    const bookedIds = new Set();
    conflicts.forEach(b => {
      if (b.roomId) bookedIds.add(String(b.roomId));
      if (Array.isArray(b.roomIds)) {
        b.roomIds.forEach(id => bookedIds.add(String(id)));
      }
      if (Array.isArray(b.rooms)) {
        b.rooms.forEach(r => {
          if (r.status === 'checked_out' || r.status === 'cancelled') return;
          if (r.roomId) bookedIds.add(String(r.roomId));
          if (r._id && !r.roomId) bookedIds.add(String(r._id));
        });
      }
    });

    const available = allRooms.filter(r => !bookedIds.has(String(r._id)));

    const floorIds = [...new Set(available.map(r => String(r.floorId)).filter(Boolean))];
    const floorDocs = await Floor.find({ _id: { $in: floorIds } }).lean();
    const floorMap = new Map(floorDocs.map(f => [String(f._id), f.name]));

    const result = available.map(r => ({
      id:         String(r._id),
      number:     r.number,
      floorName:  floorMap.get(String(r.floorId)) ?? '',
      images:     r.images ?? [],
    }));

    res.json({ success: true, data: { rooms: result, total: result.length } });
  } catch (err) {
    console.error('[getAlternativeRooms] error:', err);
    next(err);
  }
};

module.exports = {
  create,
  getPublic,
  getAll,
  remove,
  getAlternativeRooms,
  changeStatus,
  publicAccept,   // ⭐ NEW
};