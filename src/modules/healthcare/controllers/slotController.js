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

/**
 * The doctor slot endpoints answer validation problems with the message the
 * service composed ("Slot 3: an in-clinic slot needs one of your clinics"), so
 * the app can show the doctor exactly what to fix instead of a generic failure.
 */
const sendSlotError = (res, next, error) => {
  if (error instanceof slotService.SlotInputError) {
    return res.status(error.statusCode).json({ success: false, error: error.message, message: error.message });
  }
  if (error && error.name === 'CastError') {
    return res.status(400).json({ success: false, error: 'Invalid slot ID', message: 'Invalid slot ID' });
  }
  // The partial unique index: the same single-patient slot already exists.
  if (error && error.code === 11000) {
    return res.status(409).json({
      success: false,
      error: 'You already have a slot at that time',
      message: 'You already have a slot at that time',
    });
  }
  return next(error);
};

// @desc    Create slots (Doctor). type may be 'video', 'in-clinic' or 'both'.
// @route   POST /api/v1/healthcare/slots
// @access  Private/Doctor
const createSlots = async (req, res, next) => {
  try {
    const ids = await slotService.createDoctorSlots(req.doctor._id, req.body && req.body.slots);
    res.status(201).json({ success: true, count: ids.length, data: { ids } });
  } catch (error) {
    sendSlotError(res, next, error);
  }
};

// @desc    Edit or open/close an unbooked slot (Doctor)
// @route   PUT /api/v1/healthcare/slots/:id
// @access  Private/Doctor
const updateSlot = async (req, res, next) => {
  try {
    const slot = await slotService.updateDoctorSlot(req.params.id, req.doctor._id, req.body || {});
    res.json({ success: true, data: slot });
  } catch (error) {
    sendSlotError(res, next, error);
  }
};

// @desc    Delete an unbooked slot (Doctor)
// @route   DELETE /api/v1/healthcare/slots/:id
// @access  Private/Doctor
const deleteSlot = async (req, res, next) => {
  try {
    const outcome = await slotService.deleteDoctorSlot(req.params.id, req.doctor._id);
    res.json({
      success: true,
      data: { outcome },
      message:
        outcome === 'closed'
          ? 'Closed — this time comes from your weekly schedule, so it is closed rather than deleted'
          : 'Slot deleted',
    });
  } catch (error) {
    sendSlotError(res, next, error);
  }
};

// @desc    A doctor's slots for one day, each with its booking state
// @route   GET /api/v1/healthcare/slots/my-slots?date=YYYY-MM-DD
// @access  Private/Doctor
const getMySlots = async (req, res, next) => {
  try {
    const slots = await slotService.getDoctorSlotsWithState(req.doctor._id, { date: req.query.date });
    const summary = slots.reduce((acc, s) => {
      acc[s.state] = (acc[s.state] || 0) + 1;
      return acc;
    }, {});
    res.json({ success: true, count: slots.length, summary, data: slots });
  } catch (error) {
    sendSlotError(res, next, error);
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
