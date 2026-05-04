// ============================================================
// mockData.js — Dữ liệu mẫu cho LuxStay PMS
// ============================================================

const users = [
  {
    id: 'u-1',
    username: 'admin',
    password: '123456',
    fullName: 'Administrator',
    email: 'admin@luxstay.vn',
    phone: '0901000001',
    role: 'Admin',
    branchId: 'all',
    branchName: 'Tất cả',
    isActive: true,
    createdAt: '2024-01-01',
  },
  {
    id: 'u-2',
    username: 'manager',
    password: '123456',
    fullName: 'Trần Thị Lan',
    email: 'lan@luxstay.vn',
    phone: '0901000002',
    role: 'Manager',
    branchId: 'br-1',
    branchName: 'Đà Nẵng',
    isActive: true,
    createdAt: '2024-01-01',
  },
  {
    id: 'u-3',
    username: 'reception',
    password: '123456',
    fullName: 'Nguyễn Văn Phúc',
    email: 'phuc@luxstay.vn',
    phone: '0901000003',
    role: 'Receptionist',
    branchId: 'br-1',
    branchName: 'Đà Nẵng',
    isActive: true,
    createdAt: '2024-01-01',
  },
  {
    id: 'u-4',
    username: 'staff',
    password: '123456',
    fullName: 'Lê Thị Hoa',
    email: 'hoa@luxstay.vn',
    phone: '0901000004',
    role: 'Staff',
    branchId: 'br-2',
    branchName: 'Hà Nội',
    isActive: true,
    createdAt: '2024-01-01',
  },
];

const branches = [
  {
    id: 'br-1',
    name: 'LuxStay – Đà Nẵng',
    address: '123 Phạm Văn Đồng',
    city: 'Đà Nẵng',
    phone: '0236.123.4567',
    email: 'danang@luxstay.vn',
    managerId: 'u-2',
    totalRooms: 16,
    occupancyRate: 72,
    status: 'active',
  },
  {
    id: 'br-2',
    name: 'LuxStay – Hà Nội',
    address: '12 Tràng Tiền, Hoàn Kiếm',
    city: 'Hà Nội',
    phone: '024.123.4567',
    email: 'hanoi@luxstay.vn',
    managerId: 'u-3',
    totalRooms: 40,
    occupancyRate: 85,
    status: 'active',
  },
  {
    id: 'br-3',
    name: 'LuxStay – TP.HCM',
    address: '456 Nguyễn Huệ, Q1',
    city: 'TP.HCM',
    phone: '028.123.4567',
    email: 'hcm@luxstay.vn',
    managerId: 'u-4',
    totalRooms: 60,
    occupancyRate: 90,
    status: 'active',
  },
];

const roomTypes = [
  { id: 'rt-1', name: 'Standard',           capacity: 2, area: 25,  basePrice: 700000,  branchId: 'br-1' },
  { id: 'rt-2', name: 'Deluxe',             capacity: 3, area: 40,  basePrice: 1100000, branchId: 'br-1' },
  { id: 'rt-3', name: 'Suite',              capacity: 4, area: 70,  basePrice: 2500000, branchId: 'br-1' },
  { id: 'rt-4', name: 'Presidential Suite', capacity: 6, area: 130, basePrice: 5000000, branchId: 'br-1' },
];

const floors = [
  { id: 'fl-1', name: 'Tầng 1', number: 1, branchId: 'br-1', status: 'active' },
  { id: 'fl-2', name: 'Tầng 2', number: 2, branchId: 'br-1', status: 'active' },
  { id: 'fl-3', name: 'Tầng 3', number: 3, branchId: 'br-1', status: 'active' },
  { id: 'fl-4', name: 'Tầng 4', number: 4, branchId: 'br-1', status: 'active' },
];

const rooms = [
  { id: 'rm-101', number: '101', typeId: 'rt-1', typeName: 'Standard',           floorId: 'fl-1', floorNumber: 1, branchId: 'br-1', status: 'available',    pricePerNight: 700000,  currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-102', number: '102', typeId: 'rt-1', typeName: 'Standard',           floorId: 'fl-1', floorNumber: 1, branchId: 'br-1', status: 'occupied',     pricePerNight: 700000,  currentBookingId: 'bk-1', currentGuestName: 'Nguyễn Văn An',  checkIn: '2025-01-20', checkOut: '2025-01-22', notes: null },
  { id: 'rm-103', number: '103', typeId: 'rt-1', typeName: 'Standard',           floorId: 'fl-1', floorNumber: 1, branchId: 'br-1', status: 'checkout',     pricePerNight: 700000,  currentBookingId: 'bk-6', currentGuestName: 'Trần Thị Bình',  checkIn: '2025-01-19', checkOut: '2025-01-21', notes: null },
  { id: 'rm-104', number: '104', typeId: 'rt-1', typeName: 'Standard',           floorId: 'fl-1', floorNumber: 1, branchId: 'br-1', status: 'available',    pricePerNight: 700000,  currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-105', number: '105', typeId: 'rt-1', typeName: 'Standard',           floorId: 'fl-1', floorNumber: 1, branchId: 'br-1', status: 'cleaning',     pricePerNight: 700000,  currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: 'Đang dọn vệ sinh' },
  { id: 'rm-106', number: '106', typeId: 'rt-2', typeName: 'Deluxe',             floorId: 'fl-1', floorNumber: 1, branchId: 'br-1', status: 'available',    pricePerNight: 1100000, currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-201', number: '201', typeId: 'rt-2', typeName: 'Deluxe',             floorId: 'fl-2', floorNumber: 2, branchId: 'br-1', status: 'occupied',     pricePerNight: 1100000, currentBookingId: 'bk-2', currentGuestName: 'Kim Yeon Ji',    checkIn: '2025-01-21', checkOut: '2025-01-23', notes: null },
  { id: 'rm-202', number: '202', typeId: 'rt-2', typeName: 'Deluxe',             floorId: 'fl-2', floorNumber: 2, branchId: 'br-1', status: 'available',    pricePerNight: 1100000, currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-203', number: '203', typeId: 'rt-2', typeName: 'Deluxe',             floorId: 'fl-2', floorNumber: 2, branchId: 'br-1', status: 'occupied',     pricePerNight: 1100000, currentBookingId: 'bk-3', currentGuestName: 'Lê Hoàng Nam',   checkIn: '2025-01-20', checkOut: '2025-01-25', notes: null },
  { id: 'rm-204', number: '204', typeId: 'rt-2', typeName: 'Deluxe',             floorId: 'fl-2', floorNumber: 2, branchId: 'br-1', status: 'reserved',     pricePerNight: 1100000, currentBookingId: 'bk-4', currentGuestName: 'Phạm Thu Hà',    checkIn: '2025-01-22', checkOut: '2025-01-24', notes: null },
  { id: 'rm-205', number: '205', typeId: 'rt-2', typeName: 'Deluxe',             floorId: 'fl-2', floorNumber: 2, branchId: 'br-1', status: 'maintenance',  pricePerNight: 1100000, currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: 'Sửa điều hòa' },
  { id: 'rm-301', number: '301', typeId: 'rt-3', typeName: 'Suite',              floorId: 'fl-3', floorNumber: 3, branchId: 'br-1', status: 'available',    pricePerNight: 2500000, currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-302', number: '302', typeId: 'rt-3', typeName: 'Suite',              floorId: 'fl-3', floorNumber: 3, branchId: 'br-1', status: 'occupied',     pricePerNight: 2500000, currentBookingId: 'bk-5', currentGuestName: 'Vũ Minh Tuấn',   checkIn: '2025-01-20', checkOut: '2025-01-23', notes: null },
  { id: 'rm-303', number: '303', typeId: 'rt-3', typeName: 'Suite',              floorId: 'fl-3', floorNumber: 3, branchId: 'br-1', status: 'available',    pricePerNight: 2500000, currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-401', number: '401', typeId: 'rt-4', typeName: 'Presidential Suite', floorId: 'fl-4', floorNumber: 4, branchId: 'br-1', status: 'available',    pricePerNight: 5000000, currentBookingId: null, currentGuestName: null, checkIn: null, checkOut: null, notes: null },
  { id: 'rm-402', number: '402', typeId: 'rt-4', typeName: 'Presidential Suite', floorId: 'fl-4', floorNumber: 4, branchId: 'br-1', status: 'reserved',     pricePerNight: 5000000, currentBookingId: 'bk-7', currentGuestName: 'VIP Guest',       checkIn: '2025-01-25', checkOut: '2025-01-28', notes: null },
];

const customers = [
  { id: 'cu-1', name: 'Nguyễn Văn An',  phone: '0901234567', email: 'nva@gmail.com',   idNumber: '023456789012', idType: 'cccd',     nationality: 'Việt Nam', dob: '1985-03-15', gender: 'male',   address: 'Đà Nẵng', type: 'vip',       totalVisits: 8,  totalSpent: 15400000 },
  { id: 'cu-2', name: 'Kim Yeon Ji',    phone: '+82-10-1234', email: 'kimyj@naver.com', idNumber: 'M12345678',   idType: 'passport', nationality: 'Hàn Quốc', dob: '1992-07-22', gender: 'female', address: 'Seoul',   type: 'regular',   totalVisits: 1,  totalSpent: 2200000  },
  { id: 'cu-3', name: 'Lê Hoàng Nam',  phone: '0923456789', email: 'lhn@email.com',    idNumber: '045678901234', idType: 'cccd',     nationality: 'Việt Nam', dob: '1980-01-10', gender: 'male',   address: 'Hà Nội',  type: 'corporate', totalVisits: 5,  totalSpent: 18500000 },
  { id: 'cu-4', name: 'Phạm Thu Hà',   phone: '0934567890', email: 'pha@email.com',    idNumber: '056789012345', idType: 'cccd',     nationality: 'Việt Nam', dob: '1990-11-05', gender: 'female', address: 'TP.HCM',  type: 'vip',       totalVisits: 12, totalSpent: 42000000 },
  { id: 'cu-5', name: 'Vũ Minh Tuấn',  phone: '0945678901', email: 'vmt@email.com',    idNumber: '067890123456', idType: 'cccd',     nationality: 'Việt Nam', dob: '1988-09-20', gender: 'male',   address: 'Đà Nẵng', type: 'regular',   totalVisits: 3,  totalSpent: 9800000  },
  { id: 'cu-6', name: 'Trần Thị Bình', phone: '0912345678', email: 'ttb@email.com',    idNumber: '034567890123', idType: 'cccd',     nationality: 'Việt Nam', dob: '1995-06-18', gender: 'female', address: 'Đà Nẵng', type: 'regular',   totalVisits: 2,  totalSpent: 2800000  },
];

const bookings = [
  { id: 'bk-1', customerId: 'cu-1', customerName: 'Nguyễn Văn An',  customerPhone: '0901234567', roomId: 'rm-102', roomNumber: '102', roomType: 'Standard', branchId: 'br-1', checkIn: '2025-01-20T14:00', checkOut: '2025-01-22T12:00', nights: 2, adults: 2, children: 0, priceType: 'day', roomAmount: 1400000, servicesAmount: 350000, discount: 0, totalAmount: 1750000, depositAmount: 700000,  status: 'checked_in',  paymentStatus: 'partial', source: 'Direct',      isGroup: false, notes: 'Yêu cầu tầng cao', checkedInAt: '2025-01-20T14:10', checkedOutAt: null, createdBy: 'u-3', createdAt: '2025-01-18T09:00' },
  { id: 'bk-2', customerId: 'cu-2', customerName: 'Kim Yeon Ji',     customerPhone: '+82-10-1234', roomId: 'rm-201', roomNumber: '201', roomType: 'Deluxe',   branchId: 'br-1', checkIn: '2025-01-21T15:00', checkOut: '2025-01-23T12:00', nights: 2, adults: 1, children: 0, priceType: 'day', roomAmount: 2200000, servicesAmount: 0,      discount: 0, totalAmount: 2200000, depositAmount: 0,        status: 'checked_in',  paymentStatus: 'unpaid',  source: 'Booking.com', isGroup: false, notes: '',                 checkedInAt: '2025-01-21T15:30', checkedOutAt: null, createdBy: 'u-3', createdAt: '2025-01-19T10:00' },
  { id: 'bk-3', customerId: 'cu-3', customerName: 'Lê Hoàng Nam',   customerPhone: '0923456789', roomId: 'rm-203', roomNumber: '203', roomType: 'Deluxe',   branchId: 'br-1', checkIn: '2025-01-20T14:00', checkOut: '2025-01-25T12:00', nights: 5, adults: 2, children: 1, priceType: 'day', roomAmount: 5500000, servicesAmount: 800000, discount: 0, totalAmount: 6300000, depositAmount: 3000000, status: 'checked_in',  paymentStatus: 'partial', source: 'Direct',      isGroup: false, notes: 'Có trẻ em',        checkedInAt: '2025-01-20T14:20', checkedOutAt: null, createdBy: 'u-3', createdAt: '2025-01-18T11:00' },
  { id: 'bk-4', customerId: 'cu-4', customerName: 'Phạm Thu Hà',    customerPhone: '0934567890', roomId: 'rm-204', roomNumber: '204', roomType: 'Deluxe',   branchId: 'br-1', checkIn: '2025-01-22T14:00', checkOut: '2025-01-24T12:00', nights: 2, adults: 2, children: 0, priceType: 'day', roomAmount: 2200000, servicesAmount: 0,      discount: 0, totalAmount: 2200000, depositAmount: 0,        status: 'confirmed',   paymentStatus: 'unpaid',  source: 'Agoda',       isGroup: false, notes: '',                 checkedInAt: null, checkedOutAt: null, createdBy: 'u-3', createdAt: '2025-01-15T08:00' },
  { id: 'bk-5', customerId: 'cu-5', customerName: 'Vũ Minh Tuấn',   customerPhone: '0945678901', roomId: 'rm-302', roomNumber: '302', roomType: 'Suite',    branchId: 'br-1', checkIn: '2025-01-20T14:00', checkOut: '2025-01-23T12:00', nights: 3, adults: 2, children: 2, priceType: 'day', roomAmount: 7500000, servicesAmount: 450000, discount: 0, totalAmount: 7950000, depositAmount: 4000000, status: 'checked_in',  paymentStatus: 'partial', source: 'Direct',      isGroup: false, notes: '',                 checkedInAt: '2025-01-20T14:30', checkedOutAt: null, createdBy: 'u-3', createdAt: '2025-01-17T16:00' },
  { id: 'bk-6', customerId: 'cu-6', customerName: 'Trần Thị Bình',  customerPhone: '0912345678', roomId: 'rm-103', roomNumber: '103', roomType: 'Standard', branchId: 'br-1', checkIn: '2025-01-19T13:00', checkOut: '2025-01-21T12:00', nights: 2, adults: 1, children: 0, priceType: 'day', roomAmount: 1400000, servicesAmount: 150000, discount: 0, totalAmount: 1550000, depositAmount: 1550000, status: 'checked_out', paymentStatus: 'paid',    source: 'Walk-in',     isGroup: false, notes: '',                 checkedInAt: '2025-01-19T13:05', checkedOutAt: '2025-01-21T11:30', createdBy: 'u-3', createdAt: '2025-01-19T13:00' },
  { id: 'bk-7', customerId: 'cu-1', customerName: 'Đoàn Cty ABC',   customerPhone: '0911111111', roomId: 'rm-401', roomNumber: 'Multi', roomType: 'Đoàn',  branchId: 'br-1', checkIn: '2025-01-25T14:00', checkOut: '2025-01-27T12:00', nights: 2, adults: 20, children: 0, priceType: 'day', roomAmount: 14000000, servicesAmount: 0, discount: 500000, totalAmount: 13500000, depositAmount: 5000000, status: 'confirmed', paymentStatus: 'partial', source: 'Direct', isGroup: true, notes: 'Đặt bàn ăn tối', checkedInAt: null, checkedOutAt: null, createdBy: 'u-2', createdAt: '2025-01-10T09:00' },
];

const services = [
  { id: 'sv-1', name: 'Giặt ủi',           category: 'Giặt ủi',    price: 150000, unit: 'lần',  branchId: 'br-1', status: 'active'   },
  { id: 'sv-2', name: 'Thuê xe máy',        category: 'Vận chuyển', price: 200000, unit: 'ngày', branchId: 'br-1', status: 'active'   },
  { id: 'sv-3', name: 'Thuê xe đạp',        category: 'Vận chuyển', price: 100000, unit: 'ngày', branchId: 'br-1', status: 'active'   },
  { id: 'sv-4', name: 'Nước Aquafina',      category: 'Đồ uống',    price: 15000,  unit: 'chai', branchId: 'br-1', status: 'active'   },
  { id: 'sv-5', name: 'Bia Tiger',          category: 'Đồ uống',    price: 35000,  unit: 'lon',  branchId: 'br-1', status: 'active'   },
  { id: 'sv-6', name: 'Minibar Snack Set',  category: 'Đồ ăn',      price: 120000, unit: 'set',  branchId: 'br-1', status: 'active'   },
  { id: 'sv-7', name: 'Spa & Massage 60ph', category: 'Spa',         price: 450000, unit: 'lần',  branchId: 'br-1', status: 'active'   },
  { id: 'sv-8', name: 'Đưa đón sân bay',   category: 'Vận chuyển', price: 300000, unit: 'lượt', branchId: 'br-1', status: 'inactive' },
];

const bookingServices = [
  { id: 'bs-1', bookingId: 'bk-1', serviceId: 'sv-1', serviceName: 'Giặt ủi',       quantity: 2, unitPrice: 150000, totalPrice: 300000, addedAt: '2025-01-21T08:00', addedBy: 'u-3' },
  { id: 'bs-2', bookingId: 'bk-1', serviceId: 'sv-4', serviceName: 'Nước Aquafina', quantity: 5, unitPrice: 15000,  totalPrice: 75000,  addedAt: '2025-01-20T20:00', addedBy: 'u-4' },
  { id: 'bs-3', bookingId: 'bk-3', serviceId: 'sv-6', serviceName: 'Minibar Snack', quantity: 3, unitPrice: 120000, totalPrice: 360000, addedAt: '2025-01-21T10:00', addedBy: 'u-3' },
  { id: 'bs-4', bookingId: 'bk-5', serviceId: 'sv-7', serviceName: 'Spa 60ph',      quantity: 1, unitPrice: 450000, totalPrice: 450000, addedAt: '2025-01-21T14:00', addedBy: 'u-3' },
];

const priceConfigs = [
  { id: 'pc-1',  roomTypeId: 'rt-1', roomTypeName: 'Standard',           priceType: 'day',       price: 700000,  unit: 'đêm',             note: 'Nhận 14h, trả 12h', branchId: 'br-1' },
  { id: 'pc-2',  roomTypeId: 'rt-1', roomTypeName: 'Standard',           priceType: 'overnight',  price: 560000,  unit: 'đêm',             note: 'Nhận 22h, trả 12h', branchId: 'br-1' },
  { id: 'pc-3',  roomTypeId: 'rt-1', roomTypeName: 'Standard',           priceType: 'hour',       price: 100000,  unit: 'giờ đầu+50k/giờ', note: 'Tối đa 12h',        branchId: 'br-1' },
  { id: 'pc-4',  roomTypeId: 'rt-1', roomTypeName: 'Standard',           priceType: 'holiday',    price: 910000,  unit: 'đêm',             note: '+30%',              branchId: 'br-1' },
  { id: 'pc-5',  roomTypeId: 'rt-2', roomTypeName: 'Deluxe',             priceType: 'day',        price: 1100000, unit: 'đêm',             note: '',                  branchId: 'br-1' },
  { id: 'pc-6',  roomTypeId: 'rt-2', roomTypeName: 'Deluxe',             priceType: 'overnight',  price: 880000,  unit: 'đêm',             note: '',                  branchId: 'br-1' },
  { id: 'pc-7',  roomTypeId: 'rt-2', roomTypeName: 'Deluxe',             priceType: 'hour',       price: 160000,  unit: 'giờ đầu',         note: '',                  branchId: 'br-1' },
  { id: 'pc-8',  roomTypeId: 'rt-2', roomTypeName: 'Deluxe',             priceType: 'holiday',    price: 1430000, unit: 'đêm',             note: '+30%',              branchId: 'br-1' },
  { id: 'pc-9',  roomTypeId: 'rt-3', roomTypeName: 'Suite',              priceType: 'day',        price: 2500000, unit: 'đêm',             note: '',                  branchId: 'br-1' },
  { id: 'pc-10', roomTypeId: 'rt-4', roomTypeName: 'Presidential Suite', priceType: 'day',        price: 5000000, unit: 'đêm',             note: '',                  branchId: 'br-1' },
];

const paymentMethods = [
  { id: 'pm-1', name: 'Tiền mặt (VNĐ)',         type: 'Cash',          note: 'Mặc định',           isActive: true  },
  { id: 'pm-2', name: 'Chuyển khoản ngân hàng', type: 'Bank Transfer', note: 'MB, VCB, TCB, Agri', isActive: true  },
  { id: 'pm-3', name: 'Thẻ tín dụng / ghi nợ',  type: 'Card',          note: 'Visa, MC, JCB',      isActive: true  },
  { id: 'pm-4', name: 'MoMo',                    type: 'E-wallet',      note: '',                   isActive: true  },
  { id: 'pm-5', name: 'ZaloPay',                 type: 'E-wallet',      note: '',                   isActive: true  },
  { id: 'pm-6', name: 'VNPay QR',               type: 'QR',            note: 'Quét mã QR',         isActive: true  },
  { id: 'pm-7', name: 'USD (Ngoại tệ)',          type: 'Cash FX',       note: 'Tỷ giá hiện hành',  isActive: false },
];

const invoices = [
  {
    id: 'inv-1', bookingId: 'bk-1', customerId: 'cu-1', customerName: 'Nguyễn Văn An', roomNumber: '102',
    roomAmount: 1400000, servicesAmount: 350000, discount: 0, totalAmount: 1750000,
    paidAmount: 700000, remainingAmount: 1050000, paymentMethod: 'Chuyển khoản', paymentStatus: 'partial',
    issuedAt: '2025-01-20T14:10', issuedBy: 'u-3',
    items: [
      { description: 'Phòng 102 – Standard × 2 đêm', quantity: 2, unitPrice: 700000, amount: 1400000 },
      { description: 'Giặt ủi × 2',                  quantity: 2, unitPrice: 150000, amount: 300000  },
      { description: 'Nước uống × 5',                quantity: 5, unitPrice: 10000,  amount: 50000   },
    ],
  },
  {
    id: 'inv-2', bookingId: 'bk-2', customerId: 'cu-2', customerName: 'Kim Yeon Ji', roomNumber: '201',
    roomAmount: 2200000, servicesAmount: 0, discount: 0, totalAmount: 2200000,
    paidAmount: 0, remainingAmount: 2200000, paymentMethod: null, paymentStatus: 'unpaid',
    issuedAt: '2025-01-21T15:30', issuedBy: 'u-3',
    items: [
      { description: 'Phòng 201 – Deluxe × 2 đêm', quantity: 2, unitPrice: 1100000, amount: 2200000 },
    ],
  },
  {
    id: 'inv-3', bookingId: 'bk-6', customerId: 'cu-6', customerName: 'Trần Thị Bình', roomNumber: '103',
    roomAmount: 1400000, servicesAmount: 150000, discount: 0, totalAmount: 1550000,
    paidAmount: 1550000, remainingAmount: 0, paymentMethod: 'MoMo', paymentStatus: 'paid',
    issuedAt: '2025-01-21T11:30', issuedBy: 'u-3',
    items: [
      { description: 'Phòng 103 – Standard × 2 đêm', quantity: 2, unitPrice: 700000, amount: 1400000 },
      { description: 'Giặt ủi × 1',                  quantity: 1, unitPrice: 150000, amount: 150000  },
    ],
  },
];

function getDashboardStats() {
  const statusSummary = rooms.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  return {
    totalRooms:        rooms.length,
    availableRooms:    statusSummary['available']    || 0,
    occupiedRooms:     statusSummary['occupied']     || 0,
    checkoutRooms:     statusSummary['checkout']     || 0,
    cleaningRooms:     statusSummary['cleaning']     || 0,
    maintenanceRooms:  statusSummary['maintenance']  || 0,
    reservedRooms:     statusSummary['reserved']     || 0,
    todayRevenue:      48500000,
    monthRevenue:      284500000,
    todayCheckIns:     3,
    todayCheckOuts:    2,
    occupancyRate:     72,
    pendingBookings:   bookings.filter(b => b.status === 'confirmed').length,
    roomStatusSummary: statusSummary,
    revenueChart: [
      { date: '20/01', amount: 32000000 },
      { date: '21/01', amount: 45000000 },
      { date: '22/01', amount: 38000000 },
      { date: '23/01', amount: 28000000 },
      { date: '24/01', amount: 50000000 },
      { date: '25/01', amount: 43000000 },
      { date: '26/01', amount: 48500000 },
    ],
    branchOccupancy: [
      { branchName: 'Đà Nẵng', rate: 72, occupied: 43, total: 60 },
      { branchName: 'Hà Nội',  rate: 85, occupied: 34, total: 40 },
      { branchName: 'TP.HCM',  rate: 90, occupied: 54, total: 60 },
    ],
  };
}

module.exports = {
  users, branches, roomTypes, floors, rooms,
  customers, bookings, services, bookingServices,
  priceConfigs, paymentMethods, invoices,
  getDashboardStats,
};