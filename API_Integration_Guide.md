# MetroMatrix Healthcare API Integration Guide
**For Frontend Developers**

This document outlines the differences between the original API Requirements Document (`Healthcare_Usama.docx`) and the **actual, tested Backend implementation**. 

The backend has been rigorously tested and is 100% healthy. To ensure system stability and avoid breaking existing integrations, the backend code has not been restructured. Instead, please use this guide to map your frontend API services to the actual responses provided by the backend.

---

## 1. Global ID Fields
**Requirement Doc:** Uses custom ID fields like `specialtyId`, `doctorId`, `slotId`, `appointmentId`, `prescriptionId`, `callId`.
**Actual Implementation:** The backend uses standard Mongoose properties. You will receive both `_id` and `id` in almost all JSON responses.
✅ **Frontend Action:** Use `_id` or `id` instead of the custom named IDs (except where specifically noted below, like in video call join).

---

## 2. GET `/specialties`
**Expected:** `data: { specialties: [{ specialtyId, ... }] }`
**Actual:** Matches perfectly, except for the ID field.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "specialties": [
      {
        "_id": "...", 
        "id": "...",
        "name": "Cardiology",
        "icon": "heart",
        "doctorCount": 45
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 25 }
  }
}
```

---

## 3. GET `/doctors`
**Expected:** Flat object `data: { doctors: [{ name, specialtyName, profileImage, ... }] }`
**Actual:** Returns populated MongoDB references. The name and specialty are nested inside `userId` and `specialtyId` objects.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "doctors": [
      {
        "_id": "...",
        "id": "...",
        "userId": {
          "_id": "...",
          "fullName": "Dr. Ahmed Khan",
          "avatar": "https://..."
        },
        "specialtyId": {
          "_id": "...",
          "name": "Cardiology",
          "icon": "heart"
        },
        "qualifications": ["MBBS"],
        "consultationFee": 2500,
        "rating": 4.8
      }
    ],
    "pagination": { ... }
  }
}
```
✅ **Frontend Action:** Map `name` from `doctor.userId.fullName`, `specialtyName` from `doctor.specialtyId.name`, and `profileImage` from `doctor.userId.avatar`.

---

## 4. GET `/doctors/:doctorId/slots`
**Expected:** `data: { date, slots: { morning: [{...}], afternoon: [], evening: [] } }`
**Actual:** The `date` and `totalSlots` are at the root level. The `data` object contains `morning`, `afternoon`, and `evening` groups, but the slots array is nested inside an object with a `label` and `start`/`end` times.
**JSON Structure:**
```json
{
  "success": true,
  "date": "2026-05-10",
  "totalSlots": 5,
  "data": {
    "morning": {
      "label": "Morning",
      "start": "06:00",
      "end": "12:00",
      "slots": [
        { "_id": "...", "id": "...", "startTime": "09:00", "endTime": "09:20", "status": "available", "type": "in-clinic" }
      ]
    },
    "afternoon": { "label": "Afternoon", "start": "12:00", "end": "17:00", "slots": [] },
    "evening": { "label": "Evening", "start": "17:00", "end": "22:00", "slots": [] }
  }
}
```
✅ **Frontend Action:** Access slots via `response.data.morning.slots`, map `slotId` to `slot._id`, `isAvailable` to `slot.status === 'available'`, and `appointmentType` to `slot.type`.

---

## 5. POST `/appointments` (Booking)
**Expected:** `data: { appointment: { appointmentId, ... } }`
**Actual:** The created appointment object is returned directly inside `data`, not wrapped in an `appointment` key.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "id": "...",
    "status": "pending",
    "patientId": "...",
    "doctorId": "...",
    "slotId": "...",
    "totalAmount": 2000
  }
}
```
✅ **Frontend Action:** Read the newly created appointment ID directly from `response.data._id`.

---

## 6. GET `/appointments/:appointmentId/prescription`
**Expected:** `data: { prescription: { prescriptionId, ... } }`
**Actual:** The prescription object is returned directly inside `data`.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "id": "...",
    "diagnosis": "Mild Hypertension",
    "medications": [ ... ],
    "tests": [ ... ],
    "advice": "Reduce salt intake"
  }
}
```

---

## 7. GET `/health-records`
**Expected:** (Not explicitly defined in doc, usually assumed to be an object)
**Actual:** The `data` property is an **Array** of records. Pagination is separated.
**JSON Structure:**
```json
{
  "success": true,
  "count": 5,
  "data": [
    {
      "_id": "...",
      "id": "...",
      "title": "Lab Report",
      "category": "lab_reports",
      "fileUrl": "https://..."
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 5 }
}
```

---

## 8. POST `/video-calls/join/:appointmentId`
**Actual:** Matches the requirement document exactly.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "callId": "...",
    "roomId": "room_xyz",
    "token": "agora_token...",
    "provider": "agora",
    "appId": "abc123",
    "channelName": "metromatrix_call_xyz",
    "status": "waiting"
  }
}
```

---

## 9. POST `/coupons/validate`
**Actual:** Matches the requirement document exactly.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "coupon": { "code": "HEALTH20", "type": "percentage", "value": 20 },
    "discountAmount": 500,
    "finalAmount": 2000
  }
}
```

---

## 10. GET `/notifications`
**Actual:** The `data` property contains a `notifications` array, `unreadCount`, and `pagination`.
**JSON Structure:**
```json
{
  "success": true,
  "data": {
    "notifications": [
      { "_id": "...", "id": "...", "title": "...", "isRead": false }
    ],
    "unreadCount": 1,
    "pagination": { ... }
  }
}
```
