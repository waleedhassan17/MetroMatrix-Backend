const PDFDocument = require('pdfkit');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');

// ═══════════════════════════════════════════════════════
//  API 3: GET /appointments/:appointmentId/prescription
// ═══════════════════════════════════════════════════════

// @desc    Get prescription for an appointment
// @route   GET /api/v1/healthcare/appointments/:appointmentId/prescription
// @access  Private
const getAppointmentPrescription = async (req, res, next) => {
  try {
    // Verify appointment ownership
    const appointment = await Appointment.findById(req.params.appointmentId);
    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    if (appointment.patientId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. This appointment does not belong to you.',
      });
    }

    // Find prescription
    const prescription = await Prescription.findOne({
      appointmentId: req.params.appointmentId,
    })
      .populate({
        path: 'doctorId',
        select: 'qualifications experience specialtyId',
        populate: [
          { path: 'providerId', select: 'fullName profilePhoto' },
          { path: 'specialtyId', select: 'name' },
        ],
      })
      .populate('patientId', 'fullName email phoneNumber')
      .lean();

    if (!prescription) {
      return res.status(404).json({
        success: false,
        error: 'No prescription found for this appointment',
      });
    }

    res.json({
      success: true,
      data: {
        ...prescription,
        id: prescription._id,
      },
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid appointment ID' });
    }
    next(error);
  }
};

// ═══════════════════════════════════════════════════════
//  API 4: GET /prescriptions/:prescriptionId/pdf
// ═══════════════════════════════════════════════════════

// @desc    Download prescription as PDF
// @route   GET /api/v1/healthcare/prescriptions/:prescriptionId/pdf
// @access  Private
const downloadPrescriptionPDF = async (req, res, next) => {
  try {
    const prescription = await Prescription.findById(req.params.prescriptionId)
      .populate({
        path: 'doctorId',
        select: 'qualifications experience specialtyId consultationFee',
        populate: [
          { path: 'providerId', select: 'fullName profilePhoto' },
          { path: 'specialtyId', select: 'name' },
        ],
      })
      .populate('patientId', 'fullName email phoneNumber')
      .populate({
        path: 'appointmentId',
        select: 'patientInfo type clinicId createdAt',
        populate: { path: 'clinicId', select: 'name address city phone' },
      })
      .lean();

    if (!prescription) {
      return res.status(404).json({ success: false, error: 'Prescription not found' });
    }

    // PHI: only the patient or the prescribing doctor may download this PDF
    const isPatient = prescription.patientId._id.toString() === req.user._id.toString();
    let isPrescriber = false;
    if (!isPatient) {
      const Doctor = require('../models/Doctor');
      const doctor = await Doctor.findOne({ providerId: req.user._id }).select('_id');
      isPrescriber =
        !!doctor &&
        prescription.doctorId &&
        (prescription.doctorId._id || prescription.doctorId).toString() === doctor._id.toString();
    }
    if (!isPatient && !isPrescriber) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // ─── Build PDF ───────────────────────────────────
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=prescription_${prescription._id}.pdf`
    );

    doc.pipe(res);

    const doctorName = prescription.doctorId?.providerId?.fullName
      || 'Doctor';
    const specialtyName = prescription.doctorId?.specialtyId?.name || '';
    const qualifications = (prescription.doctorId?.qualifications || []).join(', ');
    const clinicName = prescription.appointmentId?.clinicId?.name || '';
    const clinicAddress = prescription.appointmentId?.clinicId?.address || '';
    const clinicCity = prescription.appointmentId?.clinicId?.city || '';
    const clinicPhone = prescription.appointmentId?.clinicId?.phone || '';

    const patientName = prescription.appointmentId?.patientInfo?.name
      || prescription.patientId?.fullName || 'Patient';
    const patientAge = prescription.appointmentId?.patientInfo?.age || 'N/A';
    const patientGender = prescription.appointmentId?.patientInfo?.gender || 'N/A';
    const prescriptionDate = new Date(prescription.createdAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    // ─── Header ──────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').text('MetroMatrix Healthcare', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).font('Helvetica-Bold').text(`Dr. ${doctorName}`, { align: 'center' });
    if (specialtyName) {
      doc.fontSize(10).font('Helvetica').text(specialtyName, { align: 'center' });
    }
    if (qualifications) {
      doc.fontSize(9).font('Helvetica-Oblique').text(qualifications, { align: 'center' });
    }
    if (clinicName) {
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica')
        .text([clinicName, clinicAddress, clinicCity].filter(Boolean).join(', '), { align: 'center' });
      if (clinicPhone) {
        doc.text(`Phone: ${clinicPhone}`, { align: 'center' });
      }
    }

    // ─── Horizontal rule ─────────────────────────────
    doc.moveDown(0.5);
    const ruleY = doc.y;
    doc.moveTo(50, ruleY).lineTo(545, ruleY).strokeColor('#333333').lineWidth(1).stroke();
    doc.moveDown(0.5);

    // ─── Patient info ────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold').text('Patient Information');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');

    const leftCol = 50;
    const rightCol = 300;
    const infoY = doc.y;

    doc.text(`Name: ${patientName}`, leftCol, infoY);
    doc.text(`Date: ${prescriptionDate}`, rightCol, infoY);
    doc.text(`Age: ${patientAge}`, leftCol, infoY + 15);
    doc.text(`Gender: ${String(patientGender).charAt(0).toUpperCase() + String(patientGender).slice(1)}`, rightCol, infoY + 15);

    doc.y = infoY + 35;

    // ─── Horizontal rule ─────────────────────────────
    const ruleY2 = doc.y;
    doc.moveTo(50, ruleY2).lineTo(545, ruleY2).strokeColor('#cccccc').lineWidth(0.5).stroke();
    doc.moveDown(0.8);

    // ─── Diagnosis & Symptoms ────────────────────────
    if (prescription.diagnosis) {
      doc.fontSize(11).font('Helvetica-Bold').text('Diagnosis');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').text(prescription.diagnosis);
      doc.moveDown(0.5);
    }

    if (prescription.symptoms && prescription.symptoms.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text('Symptoms');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').text(prescription.symptoms.join(', '));
      doc.moveDown(0.5);
    }

    // ─── Medications table ───────────────────────────
    if (prescription.medications && prescription.medications.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text('Medications');
      doc.moveDown(0.4);

      // Table header
      const tableTop = doc.y;
      const colWidths = [110, 70, 80, 70, 165];
      const headers = ['Medicine', 'Dosage', 'Frequency', 'Duration', 'Instructions'];
      const colX = [50];
      for (let i = 1; i < colWidths.length; i++) {
        colX.push(colX[i - 1] + colWidths[i - 1]);
      }

      // Draw header background
      doc.rect(50, tableTop - 3, 495, 18).fill('#f0f0f0');
      doc.fillColor('#000000');

      doc.fontSize(8).font('Helvetica-Bold');
      headers.forEach((h, i) => {
        doc.text(h, colX[i] + 3, tableTop, { width: colWidths[i] - 6 });
      });

      doc.y = tableTop + 18;

      // Table rows
      doc.fontSize(8).font('Helvetica');
      prescription.medications.forEach((med, idx) => {
        const rowY = doc.y;

        // Alternate row background
        if (idx % 2 === 1) {
          doc.rect(50, rowY - 2, 495, 16).fill('#fafafa');
          doc.fillColor('#000000');
        }

        const rowData = [
          med.name || '',
          med.dosage || '',
          med.frequency || '',
          med.duration || '',
          med.instructions || '',
        ];

        rowData.forEach((val, i) => {
          doc.text(val, colX[i] + 3, rowY, {
            width: colWidths[i] - 6,
            height: 14,
            ellipsis: true,
          });
        });

        doc.y = rowY + 16;
      });

      doc.moveDown(0.5);
    }

    // ─── Tests ───────────────────────────────────────
    if (prescription.tests && prescription.tests.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text('Tests Ordered');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica');
      prescription.tests.forEach((test, i) => {
        let line = `${i + 1}. ${test.name}`;
        if (test.instructions) line += ` — ${test.instructions}`;
        doc.text(line);
      });
      doc.moveDown(0.5);
    }

    // ─── Advice ──────────────────────────────────────
    if (prescription.advice) {
      doc.fontSize(11).font('Helvetica-Bold').text('Advice');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').text(prescription.advice);
      doc.moveDown(0.5);
    }

    // ─── Follow-up ───────────────────────────────────
    if (prescription.followUpDate) {
      const followUpStr = new Date(prescription.followUpDate).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      doc.fontSize(11).font('Helvetica-Bold').text('Follow-up Date');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').text(followUpStr);
      doc.moveDown(0.5);
    }

    // ─── Footer ──────────────────────────────────────
    doc.moveDown(1.5);
    const footerRuleY = doc.y;
    doc.moveTo(50, footerRuleY).lineTo(545, footerRuleY).strokeColor('#cccccc').lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    // Signature area
    doc.fontSize(10).font('Helvetica');
    const sigY = doc.y;
    doc.text(`Generated: ${new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })}`, 50, sigY);

    doc.text('_________________________', 380, sigY + 20);
    doc.fontSize(9).text(`Dr. ${doctorName}`, 380, sigY + 35);
    doc.text('Signature', 380, sigY + 47);

    // Finalize
    doc.end();
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: 'Invalid prescription ID' });
    }
    next(error);
  }
};

// ─── Existing: get my prescriptions ─────────────────
const getMyPrescriptions = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const [prescriptions, total] = await Promise.all([
      Prescription.find({ patientId: req.user._id })
        .populate({
          path: 'doctorId',
          populate: [
            { path: 'providerId', select: 'fullName profilePhoto' },
            { path: 'specialtyId', select: 'name' },
          ],
        })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Prescription.countDocuments({ patientId: req.user._id }),
    ]);

    res.json({
      success: true,
      count: prescriptions.length,
      data: prescriptions.map((p) => ({ ...p, id: p._id })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Existing: create prescription (doctor) ─────────
const createPrescription = async (req, res, next) => {
  try {
    const { appointmentId, diagnosis, symptoms, medications, tests, advice, followUpDate } = req.body;

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }
    if (appointment.doctorId.toString() !== req.doctor._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const prescription = await Prescription.create({
      appointmentId,
      doctorId: req.doctor._id,
      patientId: appointment.patientId,
      diagnosis,
      symptoms,
      medications,
      tests,
      advice,
      followUpDate,
    });

    // Send notification to patient
    try {
      const notificationService = require('../services/notificationService');
      await notificationService.notifyPrescriptionReady(
        appointment.patientId,
        { prescriptionId: prescription._id, appointmentId }
      );
    } catch (notifErr) {
      console.error('Failed to send prescription notification:', notifErr.message);
    }

    res.status(201).json({ success: true, data: prescription });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'A prescription for this appointment already exists',
      });
    }
    next(error);
  }
};

module.exports = {
  getAppointmentPrescription,
  downloadPrescriptionPDF,
  getMyPrescriptions,
  createPrescription,
};
