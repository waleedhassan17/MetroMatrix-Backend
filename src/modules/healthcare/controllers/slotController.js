const slotService = require('../services/slotService');

// @desc    Get available slots for a doctor, grouped by time of day
// @route   GET /api/v1/healthcare/doctors/:doctorId/slots
// @access  Public
const getDoctorSlots = async (req, res, next) => {
  try {
    const { date, type, clinicId } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'date query parameter is required (YYYY-MM-DD)',
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        error: 'date must be in YYYY-MM-DD format',
      });
    }

    const grouped = await slotService.getGroupedSlots(req.params.doctorId, {
      date,
      type,
      clinicId,
    });

    const totalSlots =
      grouped.morning.slots.length +
      grouped.afternoon.slots.length +
      grouped.evening.slots.length;

    res.json({
      success: true,
      date,
      totalSlots,
      data: grouped,
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid doctor ID' });
    }
    next(error);
  }
};

// @desc    Get available slots flat list
// @route   GET /api/v1/healthcare/slots/:doctorId
// @access  Public
const getSlots = async (req, res, next) => {
  try {
    const { date, type } = req.query;
    const slots = await slotService.findAvailableSlots(req.params.doctorId, { date, type });
    res.json({ success: true, count: slots.length, data: slots });
  } catch (error) {
    next(error);
  }
};

// @desc    Create slots (Doctor)
// @route   POST /api/v1/healthcare/slots
// @access  Private/Doctor
const createSlots = async (req, res, next) => {
  try {
    const { slots } = req.body;

    if (!slots || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'slots array is required and must not be empty',
      });
    }

    const slotsData = slots.map((slot) => ({
      ...slot,
      doctorId: req.doctor._id,
    }));

    const created = await slotService.createSlots(slotsData);
    res.status(201).json({ success: true, count: created.length, data: created });
  } catch (error) {
    next(error);
  }
};

// @desc    Update slot status
// @route   PUT /api/v1/healthcare/slots/:id
// @access  Private/Doctor
const updateSlot = async (req, res, next) => {
  try {
    const slot = await slotService.updateSlot(req.params.id, req.doctor._id, req.body);
    if (!slot) {
      return res.status(404).json({ success: false, error: 'Slot not found' });
    }
    res.json({ success: true, data: slot });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete slot
// @route   DELETE /api/v1/healthcare/slots/:id
// @access  Private/Doctor
const deleteSlot = async (req, res, next) => {
  try {
    const slot = await slotService.deleteSlot(req.params.id, req.doctor._id);
    if (!slot) {
      return res.status(404).json({ success: false, error: 'Slot not found or already booked' });
    }
    res.json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

// @desc    Get my slots (Doctor)
// @route   GET /api/v1/healthcare/slots/my-slots
// @access  Private/Doctor
const getMySlots = async (req, res, next) => {
  try {
    const Slot = require('../models/Slot');
    const { date, status } = req.query;
    const query = { doctorId: req.doctor._id };

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query.date = { $gte: startOfDay, $lte: endOfDay };
    }
    if (status) query.status = status;

    const slots = await Slot.find(query)
      .populate('clinicId', 'name address')
      .sort({ date: 1, startTime: 1 });

    res.json({ success: true, count: slots.length, data: slots });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDoctorSlots, getSlots, createSlots, updateSlot, deleteSlot, getMySlots };
