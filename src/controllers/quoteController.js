const Quote = require('../models/Quote');
const Room = require('../models/Room');
const RoomType = require('../models/RoomType');
const Branch = require('../models/Branch');
const Booking = require('../models/Booking');
const PricePolicy = require('../models/PricePolicy');
const Floor = require('../models/Floor');
const mongoose = require('mongoose');

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
      // ⭐ NEW: Aggregated images cho mode 'by_type' (gộp ảnh từ tất cả phòng cùng loại)
      let aggregatedImages = [];
      // ⭐ NEW: Display mode cho line này (default: 'selected')
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

        // ⭐ Mode 'with_alternatives' OR 'by_type' đều cần fetch phòng từ alternativeRoomIds
        //   Khác biệt: mode 'with_alternatives' liệt kê ds phòng (cho khách thấy số),
        //   mode 'by_type' chỉ gộp ảnh (KHÔNG liệt kê số phòng)
        if (Array.isArray(line.alternativeRoomIds) && line.alternativeRoomIds.length > 0) {
          const altRoomDocs = await Room.find({
            _id: { $in: line.alternativeRoomIds },
          }).lean();

          if (displayMode === 'by_type') {
            // ⭐ Mode by_type: gộp ảnh từ phòng đã chọn + tất cả phòng cùng loại còn trống
            //   (line.images đã có ảnh phòng đã chọn, em gộp thêm ảnh từ phòng khác)
            const allImagesSet = new Set();
            // Ảnh phòng đã chọn (line.roomId)
            for (const img of (images ?? [])) {
              if (img) allImagesSet.add(img);
            }
            // Ảnh từ các phòng cùng loại
            for (const r of altRoomDocs) {
              for (const img of (r.images ?? [])) {
                if (img) allImagesSet.add(img);
              }
            }
            aggregatedImages = Array.from(allImagesSet);
            // KHÔNG set alternativeRooms (giữ rỗng để FE không hiển thị số phòng)
            alternativeRooms = [];
          } else {
            // ⭐ Mode with_alternatives (như cũ): liệt kê chi tiết các phòng cùng loại
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

      // ⭐ NEW: Trong mode 'by_type', ẩn roomNumber khỏi line (không hiển thị "Phòng 201")
      //   Giữ lại typeId/typeName để render nhóm theo loại
      if (displayMode === 'by_type') {
        return {
          ...lineWithoutInternals,
          // ⭐ Override roomNumber & roomId → null/empty để FE biết không hiển thị số phòng
          roomNumber: '',
          roomId:     null,
          // Ảnh dùng aggregatedImages thay vì images đơn lẻ
          images:     aggregatedImages,
          amenities, description,
          policyInfo,
          alternativeRooms: [], // empty
          aggregatedImages,     // also stored separately for clarity
          displayMode,          // ⭐ persist mode để renderer (PDF/HTML) biết cách hiển thị
        };
      }

      // Mode 'selected' và 'with_alternatives' giữ nguyên hành vi cũ
      return {
        ...lineWithoutInternals,
        images, amenities, description,
        policyInfo,
        alternativeRooms,
        displayMode, // ⭐ vẫn persist để FE/renderer biết
      };
    }));

    const branch = await Branch.findById(branchId).lean();

    const branchPolicies = {
      cancellationPolicy: branch?.quotePolicy?.cancellationPolicy ?? '',
      requiredDocuments:  branch?.quotePolicy?.requiredDocuments  ?? '',
      hotelRules:         branch?.quotePolicy?.hotelRules         ?? '',
      includedServices:   branch?.quotePolicy?.includedServices   ?? [],
    };

    // ⭐ NEW: Trong mode 'by_type', merge các line cùng typeId thành 1 line duy nhất
    //   Lý do: nếu user chọn 3 phòng cùng loại 201/301/401 với mode by_type,
    //   không cần render 3 dòng giống hệt nhau → gộp thành 1 dòng "Standard City View Room × 3 phòng"
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
        // Giá hiển thị = giá per-room (giữ nguyên), thêm field quantity để FE hiển thị "× N phòng"
        quantity:   line._quantity,
        roomAmount: line._totalRoomAmount, // tổng theo loại = đơn giá × số phòng
        _quantity: undefined,
        _totalRoomAmount: undefined,
      }));
    }

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
      // ⭐ NEW: persist top-level mode flag để frontend public quote render đúng cách
      displayMode: isAllByType ? 'by_type'
                  : enrichedRooms.some(r => r.displayMode === 'with_alternatives') ? 'with_alternatives'
                  : 'selected',
      createdBy: req.user?.id ?? null,
    });

    res.status(201).json({
      success: true,
      data: {
        quote,
        publicUrl: `/quote/${quote.token}`,
      },
    });
  } catch (err) { next(err); }
};

// ⭐ FIX v3: hỗ trợ nhiều variant tên field
const getAlternativeRooms = async (req, res, next) => {
  try {
    const { branchId, typeId, checkIn, checkOut, excludeRoomIds = '' } = req.query;
    if (!branchId || !typeId || !checkIn || !checkOut) {
      return res.status(400).json({ success: false, message: 'Thiếu params' });
    }

    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    const excludeIds = excludeRoomIds.split(',').filter(Boolean);

    console.log('\n═══════ [alt-rooms] DEBUG ═══════');
    console.log('Query:', { branchId, typeId, checkIn, checkOut });
    console.log('Exclude:', excludeIds);

    // ⭐ Hỗ trợ cả "typeId" và "roomTypeId" (tùy schema project)
    // Hỗ trợ cả branchId là String và ObjectId
    const branchObjId = mongoose.Types.ObjectId.isValid(branchId)
      ? new mongoose.Types.ObjectId(branchId) : branchId;
    const typeObjId = mongoose.Types.ObjectId.isValid(typeId)
      ? new mongoose.Types.ObjectId(typeId) : typeId;

    // Query 1: thử với typeId
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

    console.log('Query attempt 1 (with typeId/roomTypeId):', allRooms.length);

    // Query 2 fallback: thử với typeId là string thường (không cast)
    if (allRooms.length === 0) {
      allRooms = await Room.find({
        branchId,
        _id: { $nin: excludeIds },
      }).sort({ number: 1 }).lean();

      console.log('Query attempt 2 (no type filter):', allRooms.length);
      console.log('Sample room field names:', allRooms[0] ? Object.keys(allRooms[0]) : 'none');
      if (allRooms[0]) {
        console.log('Sample room values:', {
          _id: String(allRooms[0]._id),
          number: allRooms[0].number,
          typeId: allRooms[0].typeId ? String(allRooms[0].typeId) : 'N/A',
          roomTypeId: allRooms[0].roomTypeId ? String(allRooms[0].roomTypeId) : 'N/A',
          branchId: allRooms[0].branchId ? String(allRooms[0].branchId) : 'N/A',
        });
      }

      // Filter manual sau khi lấy ra
      allRooms = allRooms.filter(r => {
        const rTypeId = r.typeId ? String(r.typeId) : (r.roomTypeId ? String(r.roomTypeId) : '');
        return rTypeId === String(typeId);
      });
      console.log('After manual type filter:', allRooms.length);
    }

    if (allRooms.length === 0) {
      console.log('═══════ [alt-rooms] NO ROOMS FOUND ═══════\n');
      return res.json({ success: true, data: { rooms: [], total: 0 } });
    }

    console.log('Found rooms cùng type:', allRooms.map(r => r.number).join(', '));

    // ⭐ Tìm bookings đang OVERLAP — query rộng để bắt nhiều schema variants
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

    console.log('Conflict bookings:', conflicts.length);
    if (conflicts[0]) {
      console.log('Sample booking field names:', Object.keys(conflicts[0]));
      console.log('Sample booking:', {
        _id: String(conflicts[0]._id),
        status: conflicts[0].status,
        roomId: conflicts[0].roomId ? String(conflicts[0].roomId) : 'N/A',
        rooms: conflicts[0].rooms ? `array[${conflicts[0].rooms.length}]` : 'N/A',
        roomIds: conflicts[0].roomIds ? `array[${conflicts[0].roomIds.length}]` : 'N/A',
      });
    }

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

    console.log('Booked roomIds:', Array.from(bookedIds));

    const available = allRooms.filter(r => !bookedIds.has(String(r._id)));

    console.log('Available cùng type:', available.map(r => r.number).join(', '));
    console.log('═══════════════════════════════════════\n');

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

const getPublic = async (req, res, next) => {
  try {
    const { token } = req.params;
    const quote = await Quote.findOne({ token }).lean();
    if (!quote) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy báo giá' });
    }
    if (quote.expiresAt && new Date(quote.expiresAt) < new Date()) {
      return res.status(410).json({ success: false, message: 'Báo giá đã hết hạn' });
    }
    res.json({ success: true, data: { quote } });
  } catch (err) { next(err); }
};

const getAll = async (req, res, next) => {
  try {
    const { branchId, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (branchId) filter.branchId = branchId;
    if (status)   filter.status   = status;

    const total = await Quote.countDocuments(filter);
    const data  = await Quote.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    await Quote.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xoá' });
  } catch (err) { next(err); }
};

module.exports = { create, getPublic, getAll, remove, getAlternativeRooms };