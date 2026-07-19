const asyncHandler = require('express-async-handler');
const Address = require('../models/Address');
const { ok, fail } = require('../utils/respond');

// @desc  GET /api/shopping/addresses
const getAddresses = asyncHandler(async (req, res) => {
  const addresses = await Address.find({ userId: req.user._id }).sort({
    isDefault: -1,
    createdAt: -1,
  });
  return ok(res, addresses);
});

// @desc  POST /api/shopping/addresses
const createAddress = asyncHandler(async (req, res) => {
  const { fullName, phone, addressLine1, city } = req.body;
  if (!fullName || !phone || !addressLine1 || !city) {
    return fail(res, 400, 'fullName, phone, addressLine1 and city are required');
  }
  const count = await Address.countDocuments({ userId: req.user._id });
  const makeDefault = req.body.isDefault === true || count === 0;
  if (makeDefault) {
    await Address.updateMany({ userId: req.user._id }, { isDefault: false });
  }
  const address = await Address.create({
    userId: req.user._id,
    label: req.body.label,
    fullName,
    phone,
    addressLine1,
    addressLine2: req.body.addressLine2,
    city,
    state: req.body.state,
    postalCode: req.body.postalCode,
    country: req.body.country || 'Pakistan',
    isDefault: makeDefault,
  });
  return ok(res, address, 201);
});

// @desc  PATCH /api/shopping/addresses/:addressId
const updateAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.addressId, userId: req.user._id });
  if (!address) return fail(res, 404, 'Address not found');

  const editable = [
    'label',
    'fullName',
    'phone',
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'postalCode',
    'country',
  ];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) address[field] = req.body[field];
  });
  if (req.body.isDefault === true) {
    await Address.updateMany({ userId: req.user._id }, { isDefault: false });
    address.isDefault = true;
  }
  await address.save();
  return ok(res, address);
});

// @desc  DELETE /api/shopping/addresses/:addressId
const deleteAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.addressId, userId: req.user._id });
  if (!address) return fail(res, 404, 'Address not found');
  const wasDefault = address.isDefault;
  await address.deleteOne();
  if (wasDefault) {
    const next = await Address.findOne({ userId: req.user._id }).sort({ createdAt: -1 });
    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }
  return res.json({ success: true });
});

module.exports = { getAddresses, createAddress, updateAddress, deleteAddress };
