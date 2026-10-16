const homeService = require('../services/homeService');

// @desc    The patient's Health home: top doctors in the city, who is free
//          today, specialties, concerns, staff banners and (signed in) the
//          patient's next visit — one payload, so the home loads in one call
// @route   GET /api/v1/healthcare/home?city=
// @access  Public (a patient's token adds `upcoming`)
const getHome = async (req, res, next) => {
  try {
    // Only a patient has visits; a doctor or admin token browses like a guest.
    const patient = req.user && !req.isProvider && !req.isAdmin ? req.user : null;
    const data = await homeService.getHome({
      city: req.query.city,
      patientId: patient ? patient._id : null,
      patientCity: patient?.address?.city || null,
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

module.exports = { getHome };
