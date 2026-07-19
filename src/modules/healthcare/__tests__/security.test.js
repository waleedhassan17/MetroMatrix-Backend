/**
 * Healthcare authorisation guards — denial paths must be 403, not 200/500.
 * Pure middleware tests with mocked models (no DB).
 */
jest.mock('../models/Appointment', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Doctor', () => ({ findOne: jest.fn() }));
jest.mock('../models/HealthRecord', () => ({ findById: jest.fn() }));

const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const HealthRecord = require('../models/HealthRecord');
const {
  requireAdmin,
  requireAppointmentParticipant,
  requireRecordOwner,
  requireTreatingDoctor,
} = require('../middleware/healthcareAuth');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// requireAdmin = [protect, checkFn]; test the check function directly
const adminCheck = requireAdmin[1];

describe('requireAdmin (specialty/coupon mutations)', () => {
  it('patient (non-admin) gets 403 creating a specialty', () => {
    const res = mockRes();
    adminCheck({ isAdmin: false, user: { _id: 'patient1' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('doctor (provider) gets 403 too', () => {
    const res = mockRes();
    adminCheck({ isAdmin: false, isProvider: true, user: { _id: 'doc1' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('admin passes', () => {
    const next = jest.fn();
    adminCheck({ isAdmin: true, user: { _id: 'admin1' } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireRecordOwner (health records PHI)', () => {
  it("patient A reading patient B's record → 403", async () => {
    HealthRecord.findById.mockResolvedValue({ userId: 'patientB' });
    const res = mockRes();
    await requireRecordOwner(
      { params: { recordId: 'r1' }, user: { _id: 'patientA' } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('owner passes and record is attached', async () => {
    const record = { userId: 'patientA' };
    HealthRecord.findById.mockResolvedValue(record);
    const req = { params: { recordId: 'r1' }, user: { _id: 'patientA' } };
    const next = jest.fn();
    await requireRecordOwner(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.record).toBe(record);
  });

  it('missing record → 404 (not 500)', async () => {
    HealthRecord.findById.mockResolvedValue(null);
    const res = mockRes();
    await requireRecordOwner({ params: { recordId: 'nope' }, user: { _id: 'x' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('requireTreatingDoctor (patient history/notes PHI)', () => {
  it('doctor with NO appointment with the patient → 403', async () => {
    Doctor.findOne.mockResolvedValue({ _id: 'docA' });
    Appointment.findOne.mockReturnValue({ select: () => Promise.resolve(null) });
    const res = mockRes();
    await requireTreatingDoctor(
      { params: { patientId: 'strangerPatient' }, user: { _id: 'providerA' } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('doctor WITH an appointment passes', async () => {
    Doctor.findOne.mockResolvedValue({ _id: 'docA' });
    Appointment.findOne.mockReturnValue({ select: () => Promise.resolve({ _id: 'apt1' }) });
    const next = jest.fn();
    await requireTreatingDoctor(
      { params: { patientId: 'myPatient' }, user: { _id: 'providerA' } },
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('non-doctor provider → 403', async () => {
    Doctor.findOne.mockResolvedValue(null);
    const res = mockRes();
    await requireTreatingDoctor(
      { params: { patientId: 'p' }, user: { _id: 'plumber1' } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireAppointmentParticipant', () => {
  it('unrelated user → 403', async () => {
    Appointment.findById.mockResolvedValue({ patientId: 'someoneElse', doctorId: 'docX' });
    Doctor.findOne.mockResolvedValue(null);
    const res = mockRes();
    await requireAppointmentParticipant(
      { params: { appointmentId: 'a1' }, user: { _id: 'intruder' }, isAdmin: false },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('the patient passes', async () => {
    Appointment.findById.mockResolvedValue({ patientId: 'me', doctorId: 'docX' });
    const next = jest.fn();
    await requireAppointmentParticipant(
      { params: { appointmentId: 'a1' }, user: { _id: 'me' }, isAdmin: false },
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('the owning doctor passes', async () => {
    Appointment.findById.mockResolvedValue({ patientId: 'someone', doctorId: 'docX' });
    Doctor.findOne.mockResolvedValue({ _id: 'docX' });
    const next = jest.fn();
    await requireAppointmentParticipant(
      { params: { appointmentId: 'a1' }, user: { _id: 'providerX' }, isAdmin: false },
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('admin passes', async () => {
    Appointment.findById.mockResolvedValue({ patientId: 'p', doctorId: 'd' });
    const next = jest.fn();
    await requireAppointmentParticipant(
      { params: { appointmentId: 'a1' }, user: { _id: 'admin' }, isAdmin: true },
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });
});
