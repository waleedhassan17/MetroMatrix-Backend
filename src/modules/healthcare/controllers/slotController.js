const slotService = require('../services/slotService');
const { todayKey, addDays, localToUtc, DEFAULT_TIMEZONE } = require('../../../utils/time');

/** How far ahead a patient may browse. Matches the generation horizon. */
const BROWSE_DAYS = Number(process.env.SLOT_HORIZON_DAYS || 60);

// ============================================================================
// WHY THERE ARE TWO DISCOVERY ENDPOINTS BESIDES THE PER-DATE ONE.
//
// A patient booking on Monday for a Saturday visit previously had to tap
// through a fourteen-day strip of identical chips, most of them empty, with no
// way to tell which held anything. That is not a viable booking experience —
// Marham, the incumbent here, instead labels each doctor "Available today" or
// "Available from Sep 04" and lets you jump straight there.
//
//   availability-summary : which upcoming DATES have slots, and how many, per
//                          clinic. Lets the date strip disable empty days.
//   next-available       : the single earliest bookable moment, for the label
//                          on a doctor card in a search result.
// ============================================================================

// @desc    Which upcoming dates have bookable slots
// @route   GET /api/v1/healthcare/doctors/:doctorId/availability-summary
// @access  Public
const getAvailabilitySummary = async (req, res, next) => {
  try {
    const { from, to, type, clinicId } = req.query;
    const tz = DEFAULT_TIMEZONE;

    const fromKey = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : todayKey(tz);
    const maxKey = addDays(fromKey, BROWSE_DAYS, tz);
    let toKey = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : maxKey;
    // Clamp rather than reject: an over-long range is a client bug, not a
    // reason to give the patient an error instead of availability.
    if (toKey > maxKey) toKey = maxKey;

    const days = await slotService.getAvailabilitySummary(req.params.doctorId, {
      fromUtc: localToUtc(fromKey, '00:00', tz),
      toUtc: localToUtc(addDays(toKey, 1, tz), '00:00', tz),
      type,
      clinicId,
    });

    res.json({
      success: true,
      data: {
        from: fromKey,
        to: toKey,
        // Only dates WITH availability. The client renders every day in the
        // range and disables those absent from this list.
        days,
        totalDays: days.length,
      },
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid doctor ID' });
    }
    next(error);
  }
};

// @desc    The earliest moment this doctor can next be seen
// @route   GET /api/v1/healthcare/doctors/:doctorId/next-available
// @access  Public
const getNextAvailable = async (req, res, next) => {
  try {
    const tz = DEFAULT_TIMEZONE;
    const toKey = addDays(todayKey(tz), BROWSE_DAYS, tz);

    const next = await slotService.getNextAvailable(req.params.doctorId, {
      toUtc: localToUtc(addDays(toKey, 1, tz), '00:00', tz),
      type: req.query.type,
    });

    // null is a real answer — "this doctor has nothing in the next 60 days" —
    // and showing that beats presenting a bookable doctor who dead-ends on an
    // empty calendar.
    res.json({ success: true, data: next });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid doctor ID' });
    }
    next(error);
  }
};

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

    // Now an array of { clinic, slots } — grouped by WHERE, not by time of
    // day. The old morning/afternoon/evening shape hid which location each
    // time belonged to, and dropped anything outside 06:00–22:00 entirely.
    const groups = await slotService.getGroupedSlots(req.params.doctorId, {
      date,
      type,
      clinicId,
    });

    const totalSlots = groups.reduce((n, g) => n + g.slots.length, 0);

    res.json({
      success: true,
      date,
      totalSlots,
      data: groups,
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

module.exports = {
  getDoctorSlots,
  getAvailabilitySummary,
  getNextAvailable,
  getSlots,
  createSlots,
  updateSlot,
  deleteSlot,
  getMySlots,
};
