/**
 * MetroMatrix Healthcare API Health Check v4
 * Pure HTTP-based - no direct MongoDB needed
 */

const http = require('http');

const BASE = 'http://localhost:5000';
const HC = '/api/v1/healthcare';
const DOCTOR_ID = '69fdc91008e230ccb6c0c043';

let TOKEN = '';
let results = [];

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...headers } };
    let data;
    if (body && Buffer.isBuffer(body)) { data = body; }
    else if (body) { data = JSON.stringify(body); opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json'; }
    if (data) opts.headers['Content-Length'] = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        let parsed;
        if (ct.includes('json')) { try { parsed = JSON.parse(raw.toString()); } catch { parsed = raw.toString(); } }
        else { parsed = raw.toString().substring(0, 500); }
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function auth() { return { Authorization: `Bearer ${TOKEN}` }; }

function record(num, api, method, expected, actual, result, detail) {
  results.push({ num, api, method, expected, actual, result, detail });
  const icon = result === 'PASS' ? '✅' : result === 'SKIP' ? '⚠️' : '❌';
  console.log(`${icon} #${num} [${method}] ${api} → ${actual} (${result})`);
  if (result === 'FAIL') console.log(`   Detail: ${JSON.stringify(detail).substring(0, 400)}`);
}

function buildMultipart(fields, fileFieldName, fileName, fileBuffer, fileMime) {
  const boundary = '----FormBoundary' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\nContent-Type: ${fileMime}\r\n\r\n`));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  console.log('=== MetroMatrix Healthcare API Health Check v4 ===\n');

  // ── Login ─────────────────────────────────────────────────────────────────
  console.log('🔑 Logging in...');
  const login = await req('POST', '/api/auth/login', { email: 'usama@test.com', password: 'password' });
  if (login.status !== 200 || !login.data?.accessToken) {
    console.error('❌ Login failed:', login.status, login.data); process.exit(1);
  }
  TOKEN = login.data.accessToken;
  console.log('✅ Login successful.\n');

  // ── Create test slots via API (user is doctor) ────────────────────────────
  console.log('🔧 Creating test slots via API...');
  const slotResp = await req('POST', HC + '/slots', {
    slots: [
      { date: '2026-05-10', startTime: '18:00', endTime: '18:30', type: 'in-clinic', status: 'available' },
      { date: '2026-05-10', startTime: '18:30', endTime: '19:00', type: 'in-clinic', status: 'available' },
      { date: '2026-06-01', startTime: '10:00', endTime: '10:30', type: 'in-clinic', status: 'available' },
      { date: '2026-06-01', startTime: '10:30', endTime: '11:00', type: 'in-clinic', status: 'available' },
      { date: '2026-06-01', startTime: '11:00', endTime: '11:30', type: 'in-clinic', status: 'available' },
    ]
  }, auth());

  let createdSlots = [];
  if (slotResp.status === 201 && slotResp.data?.data) {
    createdSlots = slotResp.data.data;
    console.log(`✅ Created ${createdSlots.length} test slots.\n`);
  } else {
    console.log(`⚠️ Slot creation response: ${slotResp.status} - ${JSON.stringify(slotResp.data).substring(0, 200)}\n`);
  }

  const slotIds = createdSlots.map(s => s.id || s._id);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('─── PUBLIC APIs (1-9) ──────────────────────────────\n');

  // 1. GET /specialties
  { const r = await req('GET', HC + '/specialties'); record(1, '/specialties', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} items` : r.data); }

  // 2. GET /specialties?search=cardio
  { const r = await req('GET', HC + '/specialties?search=cardio'); record(2, '/specialties?search=cardio', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} items` : r.data); }

  // 3. GET /doctors
  { const r = await req('GET', HC + '/doctors'); record(3, '/doctors', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} items` : r.data); }

  // 4. GET /doctors/search?q=ahmed
  { const r = await req('GET', HC + '/doctors/search?q=ahmed'); record(4, '/doctors/search?q=ahmed', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} items` : r.data); }

  // 5. GET /doctors/featured
  { const r = await req('GET', HC + '/doctors/featured'); record(5, '/doctors/featured', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} items` : r.data); }

  // 6. GET /doctors/:id
  { const r = await req('GET', HC + '/doctors/' + DOCTOR_ID); record(6, '/doctors/:id', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? (r.data?.data?.userId?.fullName || 'ok') : r.data); }

  // 7. GET /doctors/:id/slots
  { const r = await req('GET', HC + `/doctors/${DOCTOR_ID}/slots?date=2026-05-10&type=in-clinic`); record(7, '/doctors/:id/slots', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `totalSlots: ${r.data?.totalSlots}` : r.data); }

  // 8. GET /doctors/:id/clinics
  { const r = await req('GET', HC + `/doctors/${DOCTOR_ID}/clinics`); record(8, '/doctors/:id/clinics', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} clinics` : r.data); }

  // 9. GET /doctors/:id/reviews
  { const r = await req('GET', HC + `/doctors/${DOCTOR_ID}/reviews`); record(9, '/doctors/:id/reviews', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} reviews` : r.data); }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n─── PROTECTED APIs (10-24) ─────────────────────────\n');

  // 10. GET /appointments
  { const r = await req('GET', HC + '/appointments', null, auth()); record(10, '/appointments', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} items` : r.data); }

  // 11. GET /appointments/:id
  { const r = await req('GET', HC + '/appointments/69fdca9f56f7ba5d7e32a29c', null, auth()); record(11, '/appointments/:id', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? 'ok' : r.data); }

  // 12. GET /appointments/:id/prescription
  { const r = await req('GET', HC + '/appointments/69fdca9f56f7ba5d7e32a29c/prescription', null, auth()); record(12, '/appointments/:id/prescription', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data); }

  // 13. GET /prescriptions/:id/pdf
  { const r = await req('GET', HC + '/prescriptions/69fddd2808e230ccb6c0c05b/pdf', null, auth()); record(13, '/prescriptions/:id/pdf', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `content-type: ${r.headers['content-type']}` : r.data); }

  // 14. GET /health-records
  { const r = await req('GET', HC + '/health-records', null, auth()); record(14, '/health-records', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${r.data?.data?.length} records` : r.data); }

  // 15. GET /notifications
  let notifications = [];
  {
    const r = await req('GET', HC + '/notifications', null, auth());
    // Response shape: { data: { notifications: [...], unreadCount, pagination } }
    if (r.status === 200 && r.data?.data?.notifications) notifications = r.data.data.notifications;
    else if (r.status === 200 && Array.isArray(r.data?.data)) notifications = r.data.data;
    record(15, '/notifications', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.status === 200 ? `${notifications.length} notifications` : r.data);
  }

  // 16. POST /coupons/validate
  { const r = await req('POST', HC + '/coupons/validate', { code: 'HEALTH20', doctorId: DOCTOR_ID, amount: 2000 }, auth()); record(16, '/coupons/validate', 'POST', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data); }

  // 17. POST /appointments — book using created slot
  let newAppointmentId = null;
  {
    if (slotIds.length === 0) {
      record(17, '/appointments (book)', 'POST', 201, 'N/A', 'SKIP', 'No slots created');
    } else {
      const r = await req('POST', HC + '/appointments', {
        slotId: slotIds[0], doctorId: DOCTOR_ID, type: 'in-clinic',
        patientInfo: { name: 'Test Patient', phone: '03001234567', age: 25, gender: 'male', relationship: 'self' },
        symptoms: 'Test symptoms'
      }, auth());
      const ok = r.status === 201 || r.status === 200;
      if (ok) newAppointmentId = r.data?.data?.id || r.data?.data?._id;
      record(17, '/appointments (book)', 'POST', 201, r.status, ok ? 'PASS' : 'FAIL', ok ? `id: ${newAppointmentId}` : r.data);
    }
  }

  // 18. PATCH /appointments/:id/cancel
  {
    if (!newAppointmentId) { record(18, '/appointments/:id/cancel', 'PATCH', 200, 'N/A', 'SKIP', 'Depends on #17'); }
    else {
      // Small delay so booking is fully committed
      await new Promise(r => setTimeout(r, 500));
      const r = await req('PATCH', HC + `/appointments/${newAppointmentId}/cancel`, { reason: 'Test cancellation' }, auth());
      record(18, '/appointments/:id/cancel', 'PATCH', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data);
    }
  }

  // 19. PATCH /appointments/:id/reschedule
  {
    if (slotIds.length < 4) {
      record(19, '/appointments/:id/reschedule', 'PATCH', 200, 'N/A', 'SKIP', 'Not enough slots');
    } else {
      // Book with slot #2, reschedule to slot #3
      const createR = await req('POST', HC + '/appointments', {
        slotId: slotIds[2], doctorId: DOCTOR_ID, type: 'in-clinic',
        patientInfo: { name: 'Reschedule Test', phone: '03009999999', age: 30, gender: 'female', relationship: 'self' },
        symptoms: 'Reschedule test'
      }, auth());
      if (createR.status !== 201 && createR.status !== 200) {
        record(19, '/appointments/:id/reschedule', 'PATCH', 200, 'N/A', 'SKIP', `Create failed: ${JSON.stringify(createR.data).substring(0, 200)}`);
      } else {
        const apptId = createR.data?.data?.id || createR.data?.data?._id;
        const r = await req('PATCH', HC + `/appointments/${apptId}/reschedule`, { newSlotId: slotIds[3] }, auth());
        record(19, '/appointments/:id/reschedule', 'PATCH', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data);
        // Cleanup
        await req('PATCH', HC + `/appointments/${apptId}/cancel`, { reason: 'Cleanup' }, auth());
      }
    }
  }

  // 20. POST /reviews
  {
    const r = await req('POST', HC + '/reviews', { appointmentId: '69fdca9f56f7ba5d7e32a29c', rating: 4, comment: 'Good doctor' }, auth());
    if (r.status === 409 || (r.status === 400 && JSON.stringify(r.data).toLowerCase().includes('already'))) {
      record(20, '/reviews', 'POST', '201/409', r.status, 'SKIP', 'Already reviewed (expected)');
    } else {
      const ok = r.status === 201 || r.status === 200;
      record(20, '/reviews', 'POST', 201, r.status, ok ? 'PASS' : 'FAIL', r.data);
    }
  }

  // 21. POST /health-records (multipart, field="files", category required)
  let healthRecordId = null;
  {
    const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const { buffer, contentType } = buildMultipart(
      { title: 'Test Health Record', category: 'lab_reports', notes: 'API test' },
      'files', 'test.png', pngBuf, 'image/png'
    );
    const r = await req('POST', HC + '/health-records', buffer, { ...auth(), 'Content-Type': contentType });
    const ok = r.status === 201 || r.status === 200;
    if (ok) healthRecordId = r.data?.data?.id || r.data?.data?._id;
    record(21, '/health-records (upload)', 'POST', 201, r.status, ok ? 'PASS' : 'FAIL', ok ? `id: ${healthRecordId}` : r.data);
  }

  // 22. DELETE /health-records/:id
  {
    if (!healthRecordId) { record(22, '/health-records/:id', 'DELETE', 200, 'N/A', 'SKIP', 'Depends on #21'); }
    else {
      await new Promise(r => setTimeout(r, 300));
      const r = await req('DELETE', HC + `/health-records/${healthRecordId}`, null, auth());
      record(22, '/health-records/:id', 'DELETE', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data);
    }
  }

  // 23. PATCH /notifications/:id/read
  {
    // Re-fetch notifications (booking created new ones)
    await new Promise(r => setTimeout(r, 500));
    const notifsR = await req('GET', HC + '/notifications', null, auth());
    if (notifsR.status === 200 && notifsR.data?.data?.notifications) notifications = notifsR.data.data.notifications;
    else if (notifsR.status === 200 && Array.isArray(notifsR.data?.data)) notifications = notifsR.data.data;
    
    if (notifications.length === 0) {
      record(23, '/notifications/:id/read', 'PATCH', 200, 'N/A', 'SKIP', 'No notifications available');
    } else {
      const nid = notifications[0].id || notifications[0]._id;
      const r = await req('PATCH', HC + `/notifications/${nid}/read`, {}, auth());
      record(23, '/notifications/:id/read', 'PATCH', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data);
    }
  }

  // 24. PATCH /notifications/read-all
  { const r = await req('PATCH', HC + '/notifications/read-all', {}, auth()); record(24, '/notifications/read-all', 'PATCH', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data); }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n─── VIDEO CALL APIs (25-27) ─────────────────────────\n');

  // 25. POST /video-calls/join/:appointmentId
  // First try to clean up old ended calls via the admin helper
  await req('POST', '/api/v1/healthcare/video-calls/cleanup-test/69fe2a0d7c91ccaa8a6796f5', {}, auth());
  
  let callId = null;
  {
    let r = await req('POST', HC + '/video-calls/join/69fe2a0d7c91ccaa8a6796f5', {}, auth());
    let ok = r.status === 200 || r.status === 201;
    if (ok) {
      callId = r.data?.data?.callId || r.data?.data?.id || r.data?.data?._id;
      record(25, '/video-calls/join/:id', 'POST', 200, r.status, 'PASS', `callId: ${callId}`);
    } else {
      const errMsg = JSON.stringify(r.data).toLowerCase();
      if (errMsg.includes('already ended')) {
        record(25, '/video-calls/join/:id', 'POST', 200, r.status, 'SKIP', 'Call already ended — need to delete videocall doc from MongoDB manually');
        console.log('   ℹ️  Run in MongoDB: db.videocalls.deleteMany({appointmentId: ObjectId("69fe2a0d7c91ccaa8a6796f5")})');
      } else {
        record(25, '/video-calls/join/:id', 'POST', 200, r.status, 'FAIL', r.data);
      }
    }
  }

  // 26. GET /video-calls/:callId/status
  {
    if (!callId) { record(26, '/video-calls/:id/status', 'GET', 200, 'N/A', 'SKIP', 'Depends on #25'); }
    else {
      const r = await req('GET', HC + `/video-calls/${callId}/status`, null, auth());
      record(26, '/video-calls/:id/status', 'GET', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data);
    }
  }

  // 27. POST /video-calls/:callId/end
  {
    if (!callId) { record(27, '/video-calls/:id/end', 'POST', 200, 'N/A', 'SKIP', 'Depends on #25'); }
    else {
      const r = await req('POST', HC + `/video-calls/${callId}/end`, {}, auth());
      record(27, '/video-calls/:id/end', 'POST', 200, r.status, r.status === 200 ? 'PASS' : 'FAIL', r.data);
    }
  }

  // ── Cleanup: delete test slots ────────────────────────────────────────────
  console.log('\n🧹 Cleaning up test slots...');
  for (const sid of slotIds) {
    await req('DELETE', HC + `/slots/${sid}`, null, auth());
  }
  console.log('✅ Cleanup done.');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n\n════════════════════════════════════════════════════════════════');
  console.log('                    FINAL SUMMARY TABLE');
  console.log('════════════════════════════════════════════════════════════════\n');

  console.log('| #  | API                              | Method | Expected | Actual | Result    |');
  console.log('|----|----------------------------------|--------|----------|--------|-----------|');
  results.forEach(r => {
    const icon = r.result === 'PASS' ? '✅' : r.result === 'SKIP' ? '⚠️' : '❌';
    console.log(`| ${String(r.num).padStart(2)} | ${r.api.padEnd(32)} | ${r.method.padEnd(6)} | ${String(r.expected).padEnd(8)} | ${String(r.actual).padEnd(6)} | ${icon} ${r.result.padEnd(7)} |`);
  });

  const pass = results.filter(r => r.result === 'PASS').length;
  const fail = results.filter(r => r.result === 'FAIL').length;
  const skip = results.filter(r => r.result === 'SKIP').length;

  console.log(`\n📊 Total: ${results.length} | ✅ PASS: ${pass} | ❌ FAIL: ${fail} | ⚠️ SKIP: ${skip}`);
  console.log(`\n🏥 Overall Health: ${fail === 0 ? '🟢 HEALTHY' : '🔴 NEEDS ATTENTION'}`);

  if (fail > 0) {
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('                    FAILED API DETAILS');
    console.log('════════════════════════════════════════════════════════════════\n');
    results.filter(r => r.result === 'FAIL').forEach(r => {
      console.log(`❌ #${r.num} [${r.method}] ${r.api}`);
      console.log(`   Status: ${r.actual}`);
      console.log(`   Detail: ${JSON.stringify(r.detail).substring(0, 500)}\n`);
    });
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
