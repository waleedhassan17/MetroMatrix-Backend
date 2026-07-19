# SECURITY_FIXES.md — Healthcare authorisation audit (H1)

Every hole found, the fix, and the test proving it. Supports FR-17 (role-based access control) and NFR-08 (health-data protection).

| # | Hole | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | `POST/PUT/DELETE /api/v1/healthcare/specialties` guarded by `requireUser` — **any logged-in patient could create, edit or delete a medical specialty**, cascading to every doctor under it. The code comment admitted it ("add admin middleware in production"). | Critical | New `requireAdmin` in `src/modules/healthcare/middleware/healthcareAuth.js` (reuses `protect` + `req.isAdmin`, no new auth mechanism) applied to all three mutations (`specialtyRoutes.js`). | `security.test.js` — "patient (non-admin) gets 403 creating a specialty"; doctor also 403; admin passes |
| 2 | `POST /api/v1/healthcare/coupons` (create) and `GET /` (list all incl. inactive) guarded by `requireUser` — any patient could mint discount coupons. | High | `requireAdmin` on create + full listing (`couponRoutes.js`). `POST /validate` stays user-level (that's its purpose). | Covered by the same requireAdmin denial tests |
| 3 | Prescription PDF (`GET /prescriptions/:id/pdf`) allowed **only** the patient — the prescribing doctor was wrongly 403'd (spec: both may read). Not a leak, an availability bug in a PHI path. | Medium | Controller now allows patient **or** the prescribing doctor (Doctor looked up via `providerId`, matched against `prescription.doctorId`). No other party. `prescriptionController.js`. | Manual verification via smoke path (doctor writes → patient downloads) |
| 4 | `GET /doctors/me/patients/:patientId/history` and `/notes` returned the **patient's name/phone for any patientId** — queries were scoped to the doctor's own notes/appointments (empty for strangers) but the `User.findById` ran unconditionally, leaking patient identity to any verified doctor guessing ids. | High (PHI) | New `requireTreatingDoctor` middleware: the caller must have ≥1 appointment with that patient, else 403 before any patient data is read. Applied to history, notes list, and note creation (`healthcareDoctorRoutes.js`). | `security.test.js` — "doctor with NO appointment with the patient → 403"; with appointment passes |
| 5 | No reusable participant guard for appointment-scoped resources (checks lived inline in services). | Hardening | New `requireAppointmentParticipant` (patient / owning doctor / admin) and `requireRecordOwner` middleware, available for any appointment/record route; used by H2 payment endpoints. | `security.test.js` — unrelated user 403, patient/doctor/admin pass; record owner tests incl. cross-patient 403 |

## Verified NOT vulnerable (audited, no change needed)

- Health records: `getMyRecords` scopes by `userId`; `updateRecord` uses `{ _id, userId }` filter; `deleteRecord` explicitly checks ownership before delete.
- Slots: update/delete pass `req.doctor._id` into the service filter — a doctor cannot touch another doctor's slots.
- Clinics: `findOneAndUpdate({ _id, doctorId: req.doctor._id })`.
- Appointments: list/detail/cancel/reschedule all pass `req.user._id` into the service, which scopes the query; doctor endpoints scope by `req.doctor._id`.
- Prescriptions `/my`: scoped by `patientId = req.user._id`.
- All `/doctors/me/*`: `protect + providerOnly` — unauthenticated requests get 401 from `protect` (existing behaviour, re-verified).
- Admin routes (`adminDoctorRoutes`, `adminSpecialtyRoutes`, `adminAnalyticsRoutes`): `protect + adminOnly` throughout.

## Unmounted attack surface

`videoCallRoutes.js` and `couponRoutes.js` are not mounted in `routes/index.js`. Coupon fixes above apply if/when mounted; video-call routes only check `requireUser` and would need `requireAppointmentParticipant` before mounting (recorded in TELEMEDICINE_DECISION.md).

Response shapes unchanged everywhere — the frontend wiring (H4) is unaffected.
Tests: 13 new denial-path tests in `src/modules/healthcare/__tests__/security.test.js`, all green.
