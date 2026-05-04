require('dotenv').config();
const mongoose      = require('mongoose');
const bcrypt        = require('bcryptjs');

const Branch        = require('../models/Branch');
const RoomType      = require('../models/RoomType');
const Floor         = require('../models/Floor');
const Room          = require('../models/Room');
const Customer      = require('../models/Customer');
const Service       = require('../models/Service');
const User          = require('../models/User');
const PriceConfig   = require('../models/PriceConfig');
const PaymentMethod = require('../models/PaymentMethod');
const Amenity       = require('../models/Amenity');
const PricePolicy = require('../models/PricePolicy');

const seed = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('🌱  Connected to MongoDB, seeding...');

  // ── Clear all ──────────────────────────────────────
  await Promise.all([
    Branch.deleteMany(),
    RoomType.deleteMany(),
    Floor.deleteMany(),
    Room.deleteMany(),
    Customer.deleteMany(),
    Service.deleteMany(),
    User.deleteMany(),
    PriceConfig.deleteMany(),
    PaymentMethod.deleteMany(),
    Amenity.deleteMany(),
  ]);
  console.log('🗑  Cleared all collections');

  // ── Branches ───────────────────────────────────────
  const [danang, hanoi, hcm] = await Branch.insertMany([
    {
      name: 'LuxStay – Đà Nẵng',
      address: '123 Phạm Văn Đồng', city: 'Đà Nẵng',
      phone: '0236.123.4567', email: 'danang@luxstay.vn',
      totalRooms: 16, occupancyRate: 72,
      checkInTime: '14:00', checkOutTime: '12:00',
      status: 'active',
    },
    {
      name: 'LuxStay – Hà Nội',
      address: '12 Tràng Tiền, Hoàn Kiếm', city: 'Hà Nội',
      phone: '024.123.4567', email: 'hanoi@luxstay.vn',
      totalRooms: 40, occupancyRate: 85,
      checkInTime: '14:00', checkOutTime: '11:00',
      status: 'active',
    },
    {
      name: 'LuxStay – TP.HCM',
      address: '456 Nguyễn Huệ, Q1', city: 'TP.HCM',
      phone: '028.123.4567', email: 'hcm@luxstay.vn',
      totalRooms: 60, occupancyRate: 90,
      checkInTime: '15:00', checkOutTime: '12:00',
      status: 'active',
    },
  ]);
  console.log('✅  Branches:', [danang, hanoi, hcm].map(b => b.name).join(', '));

  // ── Amenities ──────────────────────────────────────
  const amenityData = await Amenity.insertMany([
    // Phòng ngủ
    { name: 'Giường King',          icon: '🛏', category: 'Phòng ngủ',  description: 'Giường King size tiêu chuẩn' },
    { name: 'Giường đôi',           icon: '🛏', category: 'Phòng ngủ',  description: 'Hai giường đơn' },
    { name: 'Tủ quần áo',           icon: '🗄', category: 'Phòng ngủ',  description: 'Tủ quần áo rộng rãi' },
    { name: 'Gương toàn thân',       icon: '🪞', category: 'Phòng ngủ',  description: 'Gương soi toàn thân' },
    // Phòng tắm
    { name: 'Bồn tắm',              icon: '🛁', category: 'Phòng tắm',  description: 'Bồn tắm đặt sàn hoặc bồn tắm hơi' },
    { name: 'Vòi sen',              icon: '🚿', category: 'Phòng tắm',  description: 'Vòi sen nhiệt độ điều chỉnh' },
    { name: 'Đồ dùng vệ sinh',      icon: '🧴', category: 'Phòng tắm',  description: 'Dầu gội, sữa tắm, kem đánh răng' },
    { name: 'Máy sấy tóc',          icon: '💨', category: 'Phòng tắm',  description: 'Máy sấy tóc chuyên dụng' },
    // Tiện ích
    { name: 'WiFi',                 icon: '📶', category: 'Tiện ích',   description: 'WiFi tốc độ cao miễn phí' },
    { name: 'TV màn hình phẳng',    icon: '📺', category: 'Tiện ích',   description: 'TV 4K 55 inch' },
    { name: 'Điều hòa',             icon: '❄️', category: 'Tiện ích',   description: 'Điều hòa 2 chiều' },
    { name: 'Két sắt',              icon: '🔒', category: 'Tiện ích',   description: 'Két an toàn điện tử' },
    { name: 'Minibar',              icon: '🍷', category: 'Tiện ích',   description: 'Tủ lạnh minibar đầy đủ đồ uống' },
    { name: 'Máy pha cà phê',       icon: '☕', category: 'Tiện ích',   description: 'Máy pha cà phê Nespresso' },
    { name: 'Bàn làm việc',         icon: '💻', category: 'Tiện ích',   description: 'Bàn làm việc rộng rãi' },
    { name: 'Bàn là quần áo',       icon: '👔', category: 'Tiện ích',   description: 'Bàn là và bàn ủi quần áo' },
    // Không gian
    { name: 'Ban công',             icon: '🌅', category: 'Không gian', description: 'Ban công riêng view đẹp' },
    { name: 'Phòng khách riêng',    icon: '🛋', category: 'Không gian', description: 'Phòng khách tách biệt' },
    { name: 'Bếp nhỏ',             icon: '🍳', category: 'Không gian', description: 'Bếp từ, lò vi sóng, tủ lạnh' },
    { name: 'View biển',            icon: '🌊', category: 'Không gian', description: 'Tầm nhìn hướng biển' },
    { name: 'View thành phố',       icon: '🌆', category: 'Không gian', description: 'Tầm nhìn hướng thành phố' },
    // Dịch vụ
    { name: 'Dọn phòng hàng ngày',  icon: '🧹', category: 'Dịch vụ',   description: 'Dọn phòng mỗi ngày' },
    { name: 'Giặt ủi miễn phí',     icon: '👕', category: 'Dịch vụ',   description: 'Dịch vụ giặt ủi miễn phí' },
    { name: 'Ăn sáng miễn phí',     icon: '🍳', category: 'Dịch vụ',   description: 'Buffet sáng tại nhà hàng' },
    { name: 'Đưa đón sân bay',      icon: '🚗', category: 'Dịch vụ',   description: 'Xe đưa đón sân bay miễn phí' },
  ]);

  // Map name → _id để dùng khi tạo RoomType
  const am = {};
  amenityData.forEach(a => { am[a.name] = a._id; });
  console.log('✅  Amenities:', amenityData.length, 'items');

  // ── Room Types ─────────────────────────────────────
  const [standard, deluxe, suite, presidential] = await RoomType.insertMany([
    {
      name: 'Standard', description: 'Phòng tiêu chuẩn thoải mái',
      capacity: 2, area: 25, branchId: danang._id,
      amenities: [
        am['WiFi'], am['TV màn hình phẳng'], am['Điều hòa'],
        am['Vòi sen'], am['Đồ dùng vệ sinh'], am['Giường King'],
      ],
    },
    {
      name: 'Deluxe', description: 'Phòng cao cấp với tiện nghi đầy đủ',
      capacity: 3, area: 40, branchId: danang._id,
      amenities: [
        am['WiFi'], am['TV màn hình phẳng'], am['Điều hòa'],
        am['Minibar'], am['Ban công'], am['Vòi sen'],
        am['Đồ dùng vệ sinh'], am['Giường King'], am['Két sắt'],
      ],
    },
    {
      name: 'Suite', description: 'Phòng hạng sang view biển',
      capacity: 4, area: 70, branchId: danang._id,
      amenities: [
        am['WiFi'], am['TV màn hình phẳng'], am['Điều hòa'],
        am['Minibar'], am['Bồn tắm'], am['Phòng khách riêng'],
        am['View biển'], am['Két sắt'], am['Máy pha cà phê'],
        am['Đồ dùng vệ sinh'], am['Dọn phòng hàng ngày'],
      ],
    },
    {
      name: 'Presidential Suite', description: 'Phòng tổng thống đẳng cấp nhất',
      capacity: 6, area: 130, branchId: danang._id,
      amenities: [
        am['WiFi'], am['TV màn hình phẳng'], am['Điều hòa'],
        am['Minibar'], am['Bồn tắm'], am['Phòng khách riêng'],
        am['Bếp nhỏ'], am['View biển'], am['Két sắt'],
        am['Máy pha cà phê'], am['Đồ dùng vệ sinh'],
        am['Giặt ủi miễn phí'], am['Ăn sáng miễn phí'],
        am['Đưa đón sân bay'], am['Dọn phòng hàng ngày'],
      ],
    },
  ]);
  console.log('✅  Room Types:', [standard, deluxe, suite, presidential].map(r => r.name).join(', '));

  // ── Floors ─────────────────────────────────────────
  const [fl1, fl2, fl3, fl4] = await Floor.insertMany([
    { name: 'Tầng 1', number: 1, branchId: danang._id, status: 'active' },
    { name: 'Tầng 2', number: 2, branchId: danang._id, status: 'active' },
    { name: 'Tầng 3', number: 3, branchId: danang._id, status: 'active' },
    { name: 'Tầng 4 – Thượng đỉnh', number: 4, branchId: danang._id, status: 'active' },
  ]);
  console.log('✅  Floors: 4 floors');

  // ── Rooms ──────────────────────────────────────────
  await Room.insertMany([
    // Tầng 1 — Standard
    { number: '101', typeId: standard._id,     typeName: 'Standard',           floorId: fl1._id, floorNumber: 1, branchId: danang._id, roomStatus: 'active' },
    { number: '102', typeId: standard._id,     typeName: 'Standard',           floorId: fl1._id, floorNumber: 1, branchId: danang._id, roomStatus: 'active' },
    { number: '103', typeId: standard._id,     typeName: 'Standard',           floorId: fl1._id, floorNumber: 1, branchId: danang._id, roomStatus: 'active' },
    { number: '104', typeId: standard._id,     typeName: 'Standard',           floorId: fl1._id, floorNumber: 1, branchId: danang._id, roomStatus: 'active' },
    { number: '105', typeId: standard._id,     typeName: 'Standard',           floorId: fl1._id, floorNumber: 1, branchId: danang._id, roomStatus: 'maintenance', notes: 'Đang sửa chữa điện' },
    // Tầng 1 — Deluxe
    { number: '106', typeId: deluxe._id,       typeName: 'Deluxe',             floorId: fl1._id, floorNumber: 1, branchId: danang._id, roomStatus: 'active' },
    // Tầng 2 — Deluxe
    { number: '201', typeId: deluxe._id,       typeName: 'Deluxe',             floorId: fl2._id, floorNumber: 2, branchId: danang._id, roomStatus: 'active' },
    { number: '202', typeId: deluxe._id,       typeName: 'Deluxe',             floorId: fl2._id, floorNumber: 2, branchId: danang._id, roomStatus: 'active' },
    { number: '203', typeId: deluxe._id,       typeName: 'Deluxe',             floorId: fl2._id, floorNumber: 2, branchId: danang._id, roomStatus: 'active' },
    { number: '204', typeId: deluxe._id,       typeName: 'Deluxe',             floorId: fl2._id, floorNumber: 2, branchId: danang._id, roomStatus: 'active' },
    { number: '205', typeId: deluxe._id,       typeName: 'Deluxe',             floorId: fl2._id, floorNumber: 2, branchId: danang._id, roomStatus: 'inactive', notes: 'Tạm ngưng kinh doanh' },
    // Tầng 3 — Suite
    { number: '301', typeId: suite._id,        typeName: 'Suite',              floorId: fl3._id, floorNumber: 3, branchId: danang._id, roomStatus: 'active' },
    { number: '302', typeId: suite._id,        typeName: 'Suite',              floorId: fl3._id, floorNumber: 3, branchId: danang._id, roomStatus: 'active' },
    { number: '303', typeId: suite._id,        typeName: 'Suite',              floorId: fl3._id, floorNumber: 3, branchId: danang._id, roomStatus: 'active' },
    // Tầng 4 — Presidential
    { number: '401', typeId: presidential._id, typeName: 'Presidential Suite', floorId: fl4._id, floorNumber: 4, branchId: danang._id, roomStatus: 'active' },
    { number: '402', typeId: presidential._id, typeName: 'Presidential Suite', floorId: fl4._id, floorNumber: 4, branchId: danang._id, roomStatus: 'active' },
  ]);
  console.log('✅  Rooms: 16 rooms');

  // ── Users ──────────────────────────────────────────
  const hashedPw = await bcrypt.hash('123456', 10);
  await User.insertMany([
    { username: 'admin',     password: hashedPw, fullName: 'Administrator',   email: 'admin@luxstay.vn',    phone: '0901000001', role: 'Admin',        branchId: null,        branchName: 'Tất cả',   isActive: true },
    { username: 'manager',   password: hashedPw, fullName: 'Trần Thị Lan',    email: 'lan@luxstay.vn',      phone: '0901000002', role: 'Manager',      branchId: danang._id,  branchName: 'Đà Nẵng',  isActive: true },
    { username: 'reception', password: hashedPw, fullName: 'Nguyễn Văn Phúc', email: 'phuc@luxstay.vn',     phone: '0901000003', role: 'Receptionist', branchId: danang._id,  branchName: 'Đà Nẵng',  isActive: true },
    { username: 'staff',     password: hashedPw, fullName: 'Lê Thị Hoa',      email: 'hoa@luxstay.vn',      phone: '0901000004', role: 'Staff',        branchId: hanoi._id,   branchName: 'Hà Nội',   isActive: true },
  ]);
  console.log('✅  Users: admin / manager / reception / staff (password: 123456)');

  // ── Customers ──────────────────────────────────────
  await Customer.insertMany([
    { name: 'Nguyễn Văn An',  phone: '0901234567', email: 'nva@gmail.com',   idNumber: '023456789012', idType: 'cccd',     nationality: 'Việt Nam', dob: new Date('1985-03-15'), gender: 'male',   address: 'Đà Nẵng', type: 'vip',       notes: 'Khách thân thiết', totalVisits: 8,  totalSpent: 15400000 },
    { name: 'Kim Yeon Ji',    phone: '+82101234',  email: 'kimyj@naver.com', idNumber: 'M12345678',   idType: 'passport', nationality: 'Hàn Quốc', dob: new Date('1992-07-22'), gender: 'female', address: 'Seoul',   type: 'regular',   notes: '',                 totalVisits: 1,  totalSpent: 2200000  },
    { name: 'Lê Hoàng Nam',   phone: '0923456789', email: 'lhn@email.com',   idNumber: '045678901234', idType: 'cccd',     nationality: 'Việt Nam', dob: new Date('1980-01-10'), gender: 'male',   address: 'Hà Nội',  type: 'corporate', notes: 'Doanh nghiệp',     totalVisits: 5,  totalSpent: 18500000 },
    { name: 'Phạm Thu Hà',    phone: '0934567890', email: 'pha@email.com',   idNumber: '056789012345', idType: 'cccd',     nationality: 'Việt Nam', dob: new Date('1990-11-05'), gender: 'female', address: 'TP.HCM',  type: 'vip',       notes: '',                 totalVisits: 12, totalSpent: 42000000 },
    { name: 'Vũ Minh Tuấn',   phone: '0945678901', email: 'vmt@email.com',   idNumber: '067890123456', idType: 'cccd',     nationality: 'Việt Nam', dob: new Date('1988-09-20'), gender: 'male',   address: 'Đà Nẵng', type: 'regular',   notes: '',                 totalVisits: 3,  totalSpent: 9800000  },
    { name: 'Trần Thị Bình',  phone: '0912345678', email: 'ttb@email.com',   idNumber: '034567890123', idType: 'cccd',     nationality: 'Việt Nam', dob: new Date('1995-06-18'), gender: 'female', address: 'Đà Nẵng', type: 'regular',   notes: '',                 totalVisits: 2,  totalSpent: 2800000  },
  ]);
  console.log('✅  Customers: 6 customers');

  // ── Services ───────────────────────────────────────
  await Service.insertMany([
    { name: 'Giặt ủi',           category: 'Giặt là',     price: 150000, unit: 'kg',    status: 'active', branchId: danang._id },
    { name: 'Spa & Massage',      category: 'Spa',         price: 450000, unit: '60 phút', status: 'active', branchId: danang._id },
    { name: 'Đưa đón sân bay',    category: 'Vận chuyển',  price: 350000, unit: 'lượt',  status: 'active', branchId: danang._id },
    { name: 'Nước Aquafina',      category: 'Minibar',     price: 15000,  unit: 'chai',  status: 'active', branchId: danang._id },
    { name: 'Minibar Snack',      category: 'Minibar',     price: 120000, unit: 'set',   status: 'active', branchId: danang._id },
    { name: 'Thuê xe máy',        category: 'Vận chuyển',  price: 200000, unit: 'ngày',  status: 'active', branchId: danang._id },
    { name: 'Ăn sáng',           category: 'F&B',         price: 180000, unit: 'người', status: 'active', branchId: danang._id },
    { name: 'Tour thành phố',     category: 'Tour',        price: 500000, unit: 'người', status: 'active', branchId: danang._id },
    { name: 'Thuê xe đạp',        category: 'Vận chuyển',  price: 80000,  unit: 'ngày',  status: 'active', branchId: danang._id },
    { name: 'Nước suối',          category: 'Minibar',     price: 10000,  unit: 'chai',  status: 'active', branchId: danang._id },
  ]);
  console.log('✅  Services: 10 services');

  // ── Price Configs ──────────────────────────────────
  await PriceConfig.insertMany([
    // Standard
    { roomTypeId: standard._id,     roomTypeName: 'Standard',           priceType: 'day',       price: 700000,  unit: 'đêm', branchId: danang._id, note: '' },
    { roomTypeId: standard._id,     roomTypeName: 'Standard',           priceType: 'overnight', price: 500000,  unit: 'đêm', branchId: danang._id, note: 'Check-in sau 22h' },
    { roomTypeId: standard._id,     roomTypeName: 'Standard',           priceType: 'hour',      price: 100000,  unit: 'giờ', branchId: danang._id, note: 'Tối thiểu 3 giờ' },
    { roomTypeId: standard._id,     roomTypeName: 'Standard',           priceType: 'holiday',   price: 900000,  unit: 'đêm', branchId: danang._id, note: 'Lễ, Tết' },
    // Deluxe
    { roomTypeId: deluxe._id,       roomTypeName: 'Deluxe',             priceType: 'day',       price: 1100000, unit: 'đêm', branchId: danang._id, note: '' },
    { roomTypeId: deluxe._id,       roomTypeName: 'Deluxe',             priceType: 'overnight', price: 800000,  unit: 'đêm', branchId: danang._id, note: 'Check-in sau 22h' },
    { roomTypeId: deluxe._id,       roomTypeName: 'Deluxe',             priceType: 'hour',      price: 150000,  unit: 'giờ', branchId: danang._id, note: 'Tối thiểu 3 giờ' },
    { roomTypeId: deluxe._id,       roomTypeName: 'Deluxe',             priceType: 'holiday',   price: 1400000, unit: 'đêm', branchId: danang._id, note: 'Lễ, Tết' },
    // Suite
    { roomTypeId: suite._id,        roomTypeName: 'Suite',              priceType: 'day',       price: 2500000, unit: 'đêm', branchId: danang._id, note: '' },
    { roomTypeId: suite._id,        roomTypeName: 'Suite',              priceType: 'overnight', price: 1800000, unit: 'đêm', branchId: danang._id, note: 'Check-in sau 22h' },
    { roomTypeId: suite._id,        roomTypeName: 'Suite',              priceType: 'holiday',   price: 3200000, unit: 'đêm', branchId: danang._id, note: 'Lễ, Tết' },
    // Presidential Suite
    { roomTypeId: presidential._id, roomTypeName: 'Presidential Suite', priceType: 'day',       price: 5000000, unit: 'đêm', branchId: danang._id, note: '' },
    { roomTypeId: presidential._id, roomTypeName: 'Presidential Suite', priceType: 'overnight', price: 3500000, unit: 'đêm', branchId: danang._id, note: 'Check-in sau 22h' },
    { roomTypeId: presidential._id, roomTypeName: 'Presidential Suite', priceType: 'holiday',   price: 6500000, unit: 'đêm', branchId: danang._id, note: 'Lễ, Tết' },
  ]);
  console.log('✅  Price Configs: 14 configs');

  // ── Payment Methods ────────────────────────────────
  await PaymentMethod.insertMany([
    { name: 'Tiền mặt (VNĐ)',          type: 'Cash',          note: 'Mặc định',            isActive: true  },
    { name: 'Chuyển khoản ngân hàng',  type: 'Bank Transfer', note: 'MB, VCB, TCB, Agri',  isActive: true  },
    { name: 'Thẻ tín dụng / ghi nợ',  type: 'Card',          note: 'Visa, MC, JCB, UP',   isActive: true  },
    { name: 'MoMo',                    type: 'E-wallet',      note: '',                     isActive: true  },
    { name: 'ZaloPay',                 type: 'E-wallet',      note: '',                     isActive: true  },
    { name: 'VNPay QR',                type: 'QR',            note: 'Quét mã QR',           isActive: true  },
    { name: 'USD (Ngoại tệ)',           type: 'Cash FX',       note: 'Tỷ giá hiện hành',    isActive: false },
  ]);
  console.log('✅  Payment Methods: 7 methods');
  // Trong seed function:
await PricePolicy.deleteMany();

await PricePolicy.insertMany([
  {
    name: 'Giá nghỉ giờ', roomTypeId: standard._id, roomTypeName: 'Standard', branchId: danang._id,
    isActive: true,
    hourEnabled: true,
    hourSlots: [
      { time: '01:00', price: 40000 }, { time: '02:00', price: 80000 },
      { time: '03:00', price: 120000 }, { time: '04:00', price: 160000 },
      { time: '05:00', price: 200000 }, { time: '06:00', price: 240000 },
    ],
    dayEnabled: true,
    dayPrice: 700000,
    dayCheckInTime: '14:00', dayCheckOutTime: '12:00',
    dayEarlyCheckIn:  [{ time: '01:00', price: 50000 }, { time: '02:00', price: 100000 }],
    dayLateCheckOut:  [{ time: '01:00', price: 50000 }, { time: '02:00', price: 100000 }],
    nightEnabled: true, nightPrice: 500000, nightCheckInTime: '22:00', nightCheckOutTime: '11:00',
    weekEnabled: false, weekPrice: 0,
    monthEnabled: false, monthPrice: 0,
  },
  {
    name: 'Giá đêm', roomTypeId: deluxe._id, roomTypeName: 'Deluxe', branchId: danang._id,
    isActive: true,
    hourEnabled: true,
    hourSlots: [
      { time: '01:00', price: 60000 }, { time: '02:00', price: 120000 },
      { time: '03:00', price: 180000 }, { time: '04:00', price: 240000 },
    ],
    dayEnabled: true, dayPrice: 1100000,
    dayCheckInTime: '14:00', dayCheckOutTime: '12:00',
    dayEarlyCheckIn: [{ time: '01:00', price: 80000 }],
    dayLateCheckOut: [{ time: '01:00', price: 80000 }],
    nightEnabled: true, nightPrice: 800000,
    nightCheckInTime: '22:00', nightCheckOutTime: '11:00',
    weekEnabled: true, weekPrice: 6000000,
    monthEnabled: true, monthPrice: 20000000,
  },
]);

  // ── Done ───────────────────────────────────────────
  console.log('\n🎉  Seed completed successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👤  Accounts (password: 123456)');
  console.log('    admin / manager / reception / staff');
  console.log('🏨  Branch: LuxStay – Đà Nẵng (16 rooms)');
  console.log('🛏  Room Types: Standard, Deluxe, Suite, Presidential Suite');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await mongoose.disconnect();
};

seed().catch(err => {
  console.error('❌  Seed failed:', err.message);
  process.exit(1);
});