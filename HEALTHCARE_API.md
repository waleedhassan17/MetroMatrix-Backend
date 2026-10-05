# MetroMatrix Healthcare API

Base URL: `https://metro-matrix-backend.vercel.app/api` (production, Vercel)
Patient/doctor surface: `/api/v1/healthcare/*` · Admin surface: `/api/v1/admin/*`
Envelope: `{ success, data, message? }` (+ `count`/`pagination` on lists); errors `{ success: false, error }`.

## Roles

| Role | Login | Guard |
|---|---|---|
| Patient (User) | `POST /api/auth/login` | `requireUser` |
| Doctor (Provider `providerType='doctor'`, approved + `Doctor.verificationStatus='verified'`) | `POST /api/auth/provider/login` | `protect+providerOnly` (self-service), `requireDoctor` (module) |
| Admin | `POST /api/admin/auth/login` | `protect+adminOnly` / `requireAdmin` |

## 1. Public / patient — `/api/v1/healthcare`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/specialties`, `/specialties/:id` | public | |
| POST/PUT/DELETE | `/specialties[/:id]` | **admin** (H1 fix — was any user) | |
| GET | `/doctors`, `/doctors/search?specialtyId&q…`, `/doctors/featured` | public | suspended doctors excluded (isActive). `/doctors` also takes `search`, `lat&lng&radiusKm` (each doctor's nearest clinic by `$geoNear` on the `clinics` 2dsphere index; clinics never placed are excluded) → `distanceKm` + `nearestClinic` per doctor, `sortBy=distance`, `minRating`, `minFee/maxFee`, `availability=today\|this-week` |
| GET | `/doctors/:doctorId`, `/:doctorId/clinics`, `/:doctorId/reviews` | public | |
| GET | `/doctors/:doctorId/slots?date=YYYY-MM-DD&clinicId` | public | grouped morning/afternoon/evening |
| POST | `/appointments` | patient | TC-17: 201, slot bookedCount++, patient + doctor notifications; fee frozen from consultationFee |
| GET | `/appointments?status=upcoming\|past\|cancelled` | patient | own only |
| GET | `/appointments/:appointmentId` | patient | own only |
| PATCH | `/appointments/:appointmentId/cancel` | patient | pending/confirmed only; **wallet refund per policy** (full ≥ window, `lateCancelRefundPercent` inside) |
| PATCH | `/appointments/:appointmentId/reschedule` | patient | `{ newSlotId }` |
| POST | `/appointments/:id/pay` | participant | `{ method: 'wallet'\|'cash_at_clinic' }`; 400 insufficient balance / double payment |
| GET | `/appointments/:id/payment` | participant | state + receipt data |
| GET | `/prescriptions/my` | patient | |
| GET | `/prescriptions/:prescriptionId/pdf` | patient **or prescribing doctor** (H1 fix) | application/pdf |
| GET/POST | `/health-records` | patient | owner-scoped; PUT `/:id`, DELETE `/:recordId` check ownership. Categories include `medications`; large files go phone → Cloudinary (`POST /api/uploads/sign`, purpose `health_record`) |
| GET | `/vitals?type=heart_rate\|blood_pressure&limit` | patient | own readings + `latest{heartRate, bloodPressure}` |
| POST | `/vitals` | patient | `{ readings: [...] }` (≤50): `{type:'heart_rate', bpm}` or `{type:'blood_pressure', systolic, diastolic, meanArterial?, pulse?}` + `measuredAt`, `source{kind:'ble'\|'manual', deviceName}`, `clientId` (idempotency). Each reading validated on its own → `{ saved, duplicates, rejected[{index,error}] }`; 400 if none valid |
| DELETE | `/vitals/:id` | patient | own only |
| GET | `/notifications` (+`/read-all`, `/:id/read`, DELETE) | patient/doctor | |
| POST | `/reviews` | patient | `{ appointmentId, doctorId, rating, comment }`; unique per appointment; updates doctor aggregate |
| POST | `/symptom-checker` | patient | `{ symptoms }` → conditions (≤3, ≤90%), recommendedSpecialty (real Specialty), **always** disclaimer; LLM tier w/ rules fallback |
| GET | `/api/recommendations/healthcare?lat&lng` | patient | doctors from the patient's history (nightly batch, else top-rated verified doctors in specialties they have seen) with a `reason` and, given a position, `distanceKm` to the nearest clinic |
| POST | `/video-calls/join/:appointmentId` | **participants only** (patient or owning doctor) | video appts, confirmed; returns `{ provider: 'jitsi', roomUrl }` |
| GET/POST | `/video-calls/:callId/status`, `/:callId/end` | authenticated | end records duration |

Booking policy (documented in `appointmentController.js`): appointments book **unpaid**; pay any time via wallet in-app, or cash captured when the doctor completes.

## 2. Doctor self-service — `/api/v1/healthcare/doctors/*` (35 endpoints, `protect+providerOnly`)

register, signin, verification docs; `me` profile + image; clinics CRUD; schedule; slots create/generate/block/unblock; availability; appointments list/detail/**confirm/complete** (complete = cash capture + **payout: fee − commission% → Provider wallet**)/cancel (always full refund + patient notified); prescriptions create/update/list; dashboard; earnings; transactions; reviews; patient notes CRUD, patient history and **patient vitals** (`GET /doctors/me/patients/:patientId/vitals`, read-only) — all behind **`requireTreatingDoctor`** (H1: ≥1 appointment with that patient or 403).

Every appointment notification (booked, confirmed, cancelled, rescheduled, completed, reminder −1 h, video starting −5 min, prescription ready) also arrives as a **push** (Expo Push → FCM HTTP v1 on Android) to the patient (`User`) or doctor (`Provider` via `Doctor.providerId`). Reminders run from `POST /api/internal/scheduler/tick`, claimed atomically on `Appointment.reminderSentAt` / `videoReminderSentAt`.

## 3. Admin — `/api/v1/admin/*`

Existing: doctors pending/approve/reject/list; specialties CRUD; analytics stats/appointments/revenue.

New (H3, all audited to `HealthcareAuditLog`):

| Method | Path | Notes |
|---|---|---|
| GET | `/doctors/:doctorId` | full detail + clinics + stats (appointments, revenue, rating, reviews) |
| PATCH | `/doctors/:doctorId/status` | `{ status: active\|suspended, reason }` — suspend hides from search, blocks new bookings, keeps existing appointments |
| PATCH | `/doctors/:doctorId` | profile edit |
| GET | `/doctors/:doctorId/documents` | re-review verification docs |
| GET | `/appointments` | all; filters doctorId/status/type/from/to/patient search |
| GET | `/appointments/:id` | detail incl. payment + payout trail |
| PATCH | `/appointments/:id/status` | force-transition, **reason mandatory**; cancel refunds in full, complete settles payout |
| POST | `/appointments/:id/refund` | manual full wallet refund, **reason mandatory**, paid only |
| GET | `/clinics`, `/clinics/:id`; PATCH `/clinics/:id/status` | activate/deactivate |
| GET | `/healthcare/reviews?rating&maxRating&doctorId` | moderation list |
| DELETE | `/healthcare/reviews/:id` | `{ reason }`; recomputes doctor rating atomically |
| GET | `/healthcare/dashboard` | pending approvals, appointments/revenue today, cancellation rate, refund candidates, top specialties |
| GET/PATCH | `/healthcare/settings` | commissionPercent, cancellationWindowHours, lateCancelRefundPercent, defaultSlotDurationMinutes, maxAdvanceBookingDays, autoApproveDoctors — **same values H2 payment code reads** (`AdminSettings.healthcare`) |

## Scripts & demo logins

```
npm run seed:healthcare    # idempotent demo dataset
npm run smoke:healthcare   # 22-step TC-16/TC-17 path — 22/22 vs production
```

Doctors: `doctor1..12.hc@metromatrix.pk` · Patients: `patient1..5.hc@metromatrix.pk` (wallet-funded). Password for every seeded demo account: the `SEED_DEMO_PASSWORD` you seeded with. Admins come from `npm run seed:admin` (credentials from env, never committed).
