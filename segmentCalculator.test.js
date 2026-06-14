'use strict'

const assert = require('assert')
const { previewTransfer, TRANSFER_MODES } = require('./src/utils/segmentCalculator')

const date = (day, hour) => new Date(2026, 4, day, hour, 0, 0, 0)
const policy = { _id: 'policy-1', name: 'Giá ngày', dayPrice: 500000, hourSlots: [] }
const room = { _id: 'room-2', number: '202', typeName: 'Standard', typeId: 'type-1' }
const booking = {
  checkOut: date(20, 12),
  servicesAmount: 0,
  discountPercent: 0,
  discountAmount: 0,
  transferFee: 0,
  segments: [{
    _id: 'segment-1',
    sequenceNumber: 1,
    roomId: 'room-1',
    roomNumber: '201',
    startAt: date(15, 14),
    endAt: null,
    transferMode: TRANSFER_MODES.INITIAL_CHECKIN,
    transferFee: 0,
    status: 'active',
  }],
}

assert.throws(() => previewTransfer({
  booking,
  transferAt: date(16, 10),
  transferMode: 'INVALID_MODE',
  newRoom: room,
  oldPolicy: policy,
  newPolicy: policy,
}), /Invalid transferMode/)

assert.throws(() => previewTransfer({
  booking: { ...booking, segments: [] },
  transferAt: date(16, 10),
  transferMode: TRANSFER_MODES.USE_NEW_RATE,
  newRoom: room,
  oldPolicy: policy,
  newPolicy: policy,
}), /không có active segment/)

assert.throws(() => previewTransfer({
  booking,
  transferAt: date(15, 13),
  transferMode: TRANSFER_MODES.USE_NEW_RATE,
  newRoom: room,
  oldPolicy: policy,
  newPolicy: policy,
}), /sau giờ bắt đầu/)

const result = previewTransfer({
  booking,
  transferAt: date(16, 10),
  transferMode: TRANSFER_MODES.USE_NEW_RATE,
  transferFee: 50000,
  newRoom: room,
  oldPolicy: policy,
  newPolicy: policy,
  paidAmount: 0,
})

assert.equal(result.simulatedNewSegment.roomNumber, '202')
assert.equal(result.simulatedNewSegment.transferFee, 50000)
assert.equal(result.closedOldSegment.status, 'closed')
assert.equal(result.totals.paidAmount, 0)
assert.ok(result.totals.newTotal >= result.totals.oldTotal)

console.log('segmentCalculator current API: 4/4 PASS')
