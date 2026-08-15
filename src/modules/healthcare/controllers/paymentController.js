const PDFDocument = require('pdfkit');
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


// ═══════════════════════════════════════════════════════
//  GET /appointments/:appointmentId/invoice  — PDF invoice
// ═══════════════════════════════════════════════════════

const PKR = (n) => `PKR ${Number(n || 0).toLocaleString('en-PK')}`;

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString('en-PK', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '—';

const fmtTime12 = (t) => {
  if (!t) return '';
  const [hStr, m] = String(t).split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
};

// @desc  Download the appointment invoice as a PDF
// @route GET /api/v1/healthcare/appointments/:appointmentId/invoice
// @access appointment participant (guard loads req.appointment); patient only
const downloadAppointmentInvoice = async (req, res, next) => {
  try {
    // PHI: an invoice carries patient identity and payment detail, so restrict
    // it to the patient themselves — matching the prescription PDF's rule.
    if (req.appointment.patientId.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, error: 'Access denied' });
    }

    const appointment = await req.appointment.populate([
      {
        path: 'doctorId',
        select: 'qualifications specialtyId providerId',
        populate: [
          { path: 'providerId', select: 'fullName' },
          { path: 'specialtyId', select: 'name' },
        ],
      },
      { path: 'clinicId', select: 'name address city phone' },
      { path: 'slotId', select: 'date startTime endTime' },
      { path: 'patientId', select: 'fullName email phoneNumber' },
    ]);

    const invoiceNo = `INV-${String(appointment._id).slice(-8).toUpperCase()}`;
    const doctorName = appointment.doctorId?.providerId?.fullName || 'Doctor';
    const specialty = appointment.doctorId?.specialtyId?.name || '';
    const clinic = appointment.clinicId;
    const slot = appointment.slotId;
    const pay = appointment.payment || {};

    const patientName =
      appointment.patientInfo?.name || appointment.patientId?.fullName || '—';
    const patientPhone =
      appointment.patientInfo?.phone || appointment.patientId?.phoneNumber || '—';

    const fee = appointment.fee ?? 0;
    const discount = appointment.discount ?? 0;
    const total = appointment.totalAmount ?? Math.max(0, fee - discount);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=invoice_${invoiceNo}.pdf`
    );

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    const BLUE = '#1857C0';
    const GREY = '#64748B';
    const DARK = '#0F172A';
    const left = 50;
    const right = 545;

    // ── Header band ──
    doc.rect(0, 0, 595, 110).fill(BLUE);
    doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold')
      .text('MetroMatrix', left, 34);
    doc.fontSize(10).font('Helvetica')
      .text('Healthcare — Consultation Invoice', left, 62);
    doc.fontSize(9)
      .text(invoiceNo, left, 80);

    const statusLabel = (pay.status || 'unpaid').toUpperCase();
    doc.fontSize(9).font('Helvetica-Bold')
      .text(statusLabel, right - 150, 34, { width: 150, align: 'right' });
    doc.font('Helvetica').fontSize(9)
      .text(`Issued ${fmtDate(pay.paidAt || appointment.createdAt)}`, right - 150, 50, {
        width: 150,
        align: 'right',
      });

    doc.fillColor(DARK);
    let y = 140;

    // ── Billed to / Appointment ──
    const col = (title, rows, x) => {
      doc.fontSize(9).fillColor(GREY).font('Helvetica-Bold').text(title, x, y);
      let yy = y + 16;
      rows.forEach(([k, v]) => {
        if (!v) return;
        doc.fontSize(9).fillColor(GREY).font('Helvetica').text(k, x, yy);
        doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold')
          .text(String(v), x, yy + 12, { width: 210 });
        yy += 34;
      });
      return yy;
    };

    const yLeft = col(
      'BILLED TO',
      [
        ['Patient', patientName],
        ['Phone', patientPhone],
        ['Email', appointment.patientId?.email],
      ],
      left
    );

    const yRight = col(
      'APPOINTMENT',
      [
        ['Doctor', `Dr. ${doctorName}${specialty ? ` — ${specialty}` : ''}`],
        [
          'Date & time',
          slot
            ? `${fmtDate(slot.date)}, ${fmtTime12(slot.startTime)} – ${fmtTime12(slot.endTime)}`
            : '—',
        ],
        [
          appointment.type === 'video' ? 'Consultation' : 'Clinic',
          appointment.type === 'video'
            ? 'Video consultation'
            : [clinic?.name, clinic?.city].filter(Boolean).join(', ') || '—',
        ],
      ],
      320
    );

    y = Math.max(yLeft, yRight) + 14;

    // ── Charges table ──
    doc.rect(left, y, right - left, 26).fill('#F1F5F9');
    doc.fillColor(GREY).fontSize(9).font('Helvetica-Bold')
      .text('DESCRIPTION', left + 12, y + 9)
      .text('AMOUNT', right - 120, y + 9, { width: 108, align: 'right' });
    y += 26;

    const row = (label, value, bold) => {
      doc.fillColor(bold ? DARK : GREY)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 11 : 10)
        .text(label, left + 12, y + 10)
        .text(value, right - 120, y + 10, { width: 108, align: 'right' });
      y += 30;
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#E2E8F0').stroke();
    };

    row(
      `${appointment.type === 'video' ? 'Video' : 'In-clinic'} consultation — Dr. ${doctorName}`,
      PKR(fee)
    );
    if (discount > 0) row('Discount', `- ${PKR(discount)}`);

    y += 8;
    doc.rect(left, y, right - left, 38).fill('#EAF3FF');
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(12)
      .text('Total paid', left + 12, y + 13)
      .text(PKR(total), right - 130, y + 13, { width: 118, align: 'right' });
    y += 56;

    // ── Payment method ──
    const methodLabel =
      pay.method === 'wallet'
        ? 'MetroMatrix Wallet'
        : pay.method === 'cash_at_clinic'
        ? 'Cash at clinic'
        : 'Not paid';
    doc.fillColor(GREY).font('Helvetica').fontSize(9)
      .text('Payment method', left, y);
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
      .text(methodLabel, left, y + 13);

    if (pay.paidAt) {
      doc.fillColor(GREY).font('Helvetica').fontSize(9)
        .text('Paid on', 320, y);
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
        .text(fmtDate(pay.paidAt), 320, y + 13);
    }

    // ── Footer ──
    doc.fillColor(GREY).font('Helvetica').fontSize(8)
      .text(
        'This is a computer-generated invoice and does not require a signature.',
        left,
        760,
        { width: right - left, align: 'center' }
      );

    doc.end();
  } catch (e) {
    if (e.statusCode) {
      return res.status(e.statusCode).json({ success: false, error: e.message });
    }
    return next(e);
  }
};

module.exports = { payAppointment, getPaymentState, downloadAppointmentInvoice };
