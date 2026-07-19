const paymentService = require('../services/paymentService');

// @desc  POST /api/v1/healthcare/appointments/:id/pay { method: 'wallet'|'cash_at_clinic' }
// @access appointment participant (patient pays; guard loads req.appointment)
const payAppointment = async (req, res, next) => {
  try {
    const appointment = req.appointment;
    // Only the patient pays their own appointment
    if (appointment.patientId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'Only the patient can pay for this appointment' });
    }
    const updated = await paymentService.payAppointment(appointment, req.user, req.body.method);
    return res.json({ success: true, data: updated });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ success: false, error: e.message });
    return next(e);
  }
};

// @desc  GET /api/v1/healthcare/appointments/:id/payment — state + receipt data
const getPaymentState = async (req, res, next) => {
  try {
    const appointment = await req.appointment.populate([
      { path: 'doctorId', select: 'consultationFee specialtyId providerId', populate: { path: 'providerId', select: 'fullName' } },
      { path: 'clinicId', select: 'name address city' },
    ]);
    const p = appointment.payment || {};
    return res.json({
      success: true,
      data: {
        appointmentId: String(appointment._id),
        status: p.status || 'unpaid',
        method: p.method || null,
        amount: p.amount ?? appointment.totalAmount ?? 0,
        fee: appointment.fee,
        discount: appointment.discount,
        paidAt: p.paidAt,
        refundedAt: p.refundedAt,
        refundAmount: p.refundAmount || 0,
        doctorName: appointment.doctorId?.providerId?.fullName || '',
        clinicName: appointment.clinicId?.name || '',
        appointmentStatus: appointment.status,
      },
    });
  } catch (e) {
    return next(e);
  }
};

module.exports = { payAppointment, getPaymentState };
