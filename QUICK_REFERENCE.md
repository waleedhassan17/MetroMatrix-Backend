# 🚀 QUICK DEPLOYMENT & API REFERENCE

---

## 🌐 API Base URL
```
https://metromatrix-api-2e35f5f074df.herokuapp.com
```

---

## ⚡ Quick Deployment (5 Steps)

```bash
# 1. Commit changes
git add .
git commit -m "v2.0: Email verification & provider approval flow"

# 2. Set environment variables (run each)
heroku config:set MONGODB_URI="your-mongodb-uri"
heroku config:set JWT_SECRET="your-jwt-secret"
heroku config:set REFRESH_TOKEN_SECRET="your-refresh-secret"
heroku config:set EMAIL_HOST="smtp.gmail.com"
heroku config:set EMAIL_PORT="587"
heroku config:set EMAIL_USER="your-email@gmail.com"
heroku config:set EMAIL_PASS="your-email-password"
heroku config:set API_URL="https://metromatrix-api-2e35f5f074df.herokuapp.com"
heroku config:set NODE_ENV="production"

# 3. Deploy
git push heroku main

# 4. Check logs
heroku logs --tail

# 5. Test
curl https://metromatrix-api-2e35f5f074df.herokuapp.com/health
```

---

## 🔐 User Registration Flow

```
1. POST /api/auth/register
   → PendingSignup created, email sent
   
2. User clicks email link
   → /verify-email?token=xxx&type=user
   
3. POST /api/auth/user/verify-email
   → User account created
   → Auth tokens returned
   → Immediate login
```

---

## 🏥 Provider Registration Flow

```
1. POST /api/auth/provider/register
   → PendingSignup created, email sent
   
2. Provider clicks email link
   → /verify-email?token=xxx&type=provider
   
3. POST /api/auth/provider/verify-email
   → Provider account created
   → Auth tokens returned
   → Can login (limited access)
   → Awaits admin approval
   
4. Admin: POST /api/admin/providers/:id/approve
   → Full features unlocked
```

---

## 📊 56 Total Endpoints

| Category | Count |
|----------|-------|
| Auth (new flows) | 17 |
| Users | 6 |
| Providers | 11 |
| Posts | 10 |
| Admin | 12 |
| **TOTAL** | **56** |

---

## 🔑 Key Credentials

```
Admin Email: waleedhassansfd@gmail.com
Admin Pass: Waleed@107

API URL: https://metromatrix-api-2e35f5f074df.herokuapp.com
```

---

## ✅ Top 5 New Endpoints

1. **POST /api/auth/user/verify-email**
   - User email verification after signup
   - Returns: Auth tokens + User data

2. **POST /api/auth/provider/verify-email**
   - Provider email verification after signup
   - Returns: Auth tokens + Provider data
   - Status: pending (awaiting admin approval)

3. **POST /api/admin/providers/:id/approve**
   - Admin approves provider
   - Provider gains full access

4. **POST /api/admin/providers/:id/reject**
   - Admin rejects provider
   - Provider cannot login

5. **GET /api/health**
   - Health check endpoint
   - Verify deployment works

---

## 🎯 Testing Key Flows

### User Flow
```bash
# 1. Register
curl -X POST https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Doe",
    "phoneNumber": "1234567890",
    "email": "user@example.com",
    "password": "Pass123!"
  }'

# 2. Check email, get token from link
# 3. Verify email
curl -X POST https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth/user/verify-email \
  -H "Content-Type: application/json" \
  -d '{"token": "token-from-email"}'

# 4. Get access token from response
# 5. Use in subsequent requests
curl -X GET https://metromatrix-api-2e35f5f074df.herokuapp.com/api/users/profile \
  -H "Authorization: Bearer <accessToken>"
```

### Provider Flow
```bash
# 1. Register provider (same as user)
# 2. Verify email
# 3. Can login with limited access
# 4. Wait for admin approval
# 5. After approval, full access
```

---

## 📁 Documentation Files

Created for reference:

1. **API_ENDPOINTS_UPDATED.md**
   - All 56 endpoints documented
   - Request/response examples
   - Query parameters & body schemas

2. **FRONTEND_INTEGRATION_GUIDE.md**
   - Complete user signup flow
   - Complete provider signup flow
   - Code examples
   - Error handling

3. **HEROKU_DEPLOYMENT_GUIDE.md**
   - Step-by-step deployment
   - Environment variables
   - Troubleshooting guide
   - Monitoring tips

4. **RELEASE_SUMMARY_v2.0.md**
   - What's new
   - File changes
   - Testing checklist
   - Next steps

---

## ⚠️ Important: Before Going Live

- [ ] Set all environment variables
- [ ] Test user signup → verification → login
- [ ] Test provider signup → verification → admin approval → login
- [ ] Verify email sending works
- [ ] Check Cloudinary uploads work
- [ ] Test token refresh
- [ ] Test OAuth flows
- [ ] Monitor first 24 hours
- [ ] Have rollback plan ready

---

## 🐛 Quick Troubleshooting

**Signup not working?**
- Check MongoDB connection
- Verify email credentials

**Verification email not arriving?**
- Check EMAIL_USER, EMAIL_PASS env vars
- Enable "Less secure apps" in Gmail
- Check spam folder

**Token errors?**
- Verify JWT_SECRET is set
- Check token format in header
- Use: `Authorization: Bearer <token>`

**Provider can't login?**
- Check `canLogin` is true in DB
- Verify tokens were returned on verification
- Admin may need to approve first

---

## 📞 Need Help?

1. Check relevant documentation file
2. Review error message carefully
3. Check Heroku logs: `heroku logs --tail`
4. Test with Postman/Insomnia
5. Contact: waleedhassansfd@gmail.com

---

## ✨ What Changed from v1.0 to v2.0

```
BEFORE (v1.0):
User signup → User created immediately → Can login
                ↓
                ✗ Fake emails stored in DB!

AFTER (v2.0):
User signup → Temp PendingSignup created → Email sent
             ↓
        Click email link
             ↓
        Verify token → User created → Can login
                ↓
                ✓ Only valid emails in DB!
```

---

## 🎉 You're Ready!

1. ✅ Code updated with all fixes
2. ✅ Models created
3. ✅ Routes updated
4. ✅ Controllers improved
5. ✅ Documentation complete
6. ✅ Ready to deploy

**Next Step:** Run deployment commands above!

---

**Version:** 2.0  
**Date:** November 29, 2025  
**Status:** ✅ READY FOR PRODUCTION
