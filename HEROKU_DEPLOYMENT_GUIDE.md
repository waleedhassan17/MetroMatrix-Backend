# 🚀 MetroMatrix Backend - Heroku Deployment Guide

## Prerequisites
- Heroku CLI installed: https://devcenter.heroku.com/articles/heroku-cli
- GitHub account (for easy deployments)
- Existing Heroku app: `metromatrix-api-2e35f5f074df`

---

## 📋 Step-by-Step Deployment

### 1. Login to Heroku
```bash
heroku login
```

### 2. Add Heroku Remote (if not already added)
```bash
heroku git:remote -a metromatrix-api-2e35f5f074df
```

### 3. Check Current Environment Variables
```bash
heroku config
```

### 4. Update/Add Required Environment Variables
```bash
# Database
heroku config:set MONGODB_URI="your-mongodb-connection-string"

# JWT Secrets
heroku config:set JWT_SECRET="your-jwt-secret"
heroku config:set REFRESH_TOKEN_SECRET="your-refresh-token-secret"

# Email Service (NodeMailer)
heroku config:set EMAIL_HOST="your-email-host"
heroku config:set EMAIL_PORT="587"
heroku config:set EMAIL_USER="your-email"
heroku config:set EMAIL_PASS="your-email-password"
heroku config:set EMAIL_FROM="noreply@metromatrix.com"

# Cloudinary (Image Upload)
heroku config:set CLOUDINARY_NAME="your-cloudinary-name"
heroku config:set CLOUDINARY_API_KEY="your-cloudinary-key"
heroku config:set CLOUDINARY_API_SECRET="your-cloudinary-secret"

# OAuth (Google & Facebook)
heroku config:set GOOGLE_CLIENT_ID="your-google-client-id"
heroku config:set GOOGLE_CLIENT_SECRET="your-google-client-secret"
heroku config:set FACEBOOK_APP_ID="your-facebook-app-id"
heroku config:set FACEBOOK_APP_SECRET="your-facebook-app-secret"

# URLs
heroku config:set API_URL="https://metromatrix-api-2e35f5f074df.herokuapp.com"
heroku config:set CLIENT_URL="your-frontend-url"

# Environment
heroku config:set NODE_ENV="production"

# Admin Credentials (for seeding)
heroku config:set ADMIN_EMAIL="waleedhassansfd@gmail.com"
heroku config:set ADMIN_PASSWORD="Waleed@107"
```

### 5. Commit and Push to Heroku
```bash
# Commit all changes
git add .
git commit -m "Update email verification flow and add separate user/provider flows"

# Push to Heroku
git push heroku main
# OR if using different branch
git push heroku your-branch-name:main
```

### 6. View Deployment Logs
```bash
heroku logs --tail
```

### 7. Run Database Migrations/Seeding (if needed)
```bash
# Run admin seeder
heroku run node src/seeder/adminSeeder.js

# Or run cleanup (optional)
heroku run node src/scripts/cleanUpUploads.js
```

### 8. Scale Dynos (if needed)
```bash
# Check current dyno setup
heroku ps

# Scale to 1 web dyno (free tier default)
heroku ps:scale web=1
```

### 9. Verify Deployment
```bash
# Test health endpoint
curl https://metromatrix-api-2e35f5f074df.herokuapp.com/health

# Check if it returns
# {
#   "status": "OK",
#   "timestamp": "...",
#   "environment": "production",
#   "uptime": ...
# }
```

---

## 🔄 Alternative: Deploy via GitHub

### 1. Enable GitHub Integration in Heroku Dashboard
1. Go to: https://dashboard.heroku.com/apps/metromatrix-api-2e35f5f074df
2. Click "Deploy" tab
3. Connect to GitHub
4. Select your repository
5. Enable "Automatic Deploys" (optional)

### 2. Manual GitHub Deployment
```bash
# Just push to GitHub
git push origin main

# Then deploy from Heroku dashboard or use:
heroku deploy:github
```

---

## ✅ Post-Deployment Checklist

- [ ] Verify health endpoint works: `GET /health`
- [ ] Test user signup: `POST /api/auth/register`
- [ ] Test provider signup: `POST /api/auth/provider/register`
- [ ] Test user login: `POST /api/auth/login`
- [ ] Test provider login: `POST /api/auth/provider/login`
- [ ] Test admin login: `POST /api/admin/login`
- [ ] Verify email sending works
- [ ] Test file upload (Cloudinary)
- [ ] Check MongoDB connection
- [ ] Monitor logs for errors
- [ ] Update frontend with new API base URL (if changed)

---

## 🐛 Troubleshooting

### Build Fails
```bash
# Check build logs
heroku logs

# Clear build cache and rebuild
heroku builds:cache:purge
git commit --allow-empty -m "Rebuild"
git push heroku main
```

### Database Connection Issues
```bash
# Verify MongoDB URI is correct
heroku config:get MONGODB_URI

# Test connection
heroku run "mongo your-connection-string"
```

### Email Not Sending
- Check EMAIL_USER and EMAIL_PASS are correct
- Verify EMAIL_HOST and EMAIL_PORT
- Check email service credentials
- Ensure "Less secure apps" is enabled (for Gmail)

### Cloudinary Upload Fails
- Verify CLOUDINARY_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
- Check Cloudinary account is active
- Verify upload folder permissions

### OAuth Redirect Issues
- Update callback URLs in Google/Facebook console
- Ensure CLIENT_URL env variable is set correctly
- Check CORS settings in app.js

---

## 📊 Monitoring

### View Real-time Logs
```bash
heroku logs --tail
```

### Check Dyno Status
```bash
heroku ps
```

### Monitor Application Metrics
```bash
# Open Heroku dashboard
heroku open
```

---

## 🔄 Rollback to Previous Version

If deployment has issues:

```bash
# View recent releases
heroku releases

# Rollback to previous version
heroku rollback v123  # Replace 123 with version number
```

---

## 📝 Important Notes

1. **Free Tier Limitations**: 
   - App sleeps after 30 min of inactivity
   - Limited monthly hours
   - Upgrade to Hobby tier for 24/7 uptime

2. **Database Backups**:
   - MongoDB should handle automatic backups
   - Verify backup schedule in MongoDB Atlas

3. **Security**:
   - Never commit `.env` file
   - Use environment variables for all secrets
   - Rotate JWT secrets periodically
   - Keep dependencies updated

4. **Performance**:
   - Enable gzip compression (done in app.js)
   - Use CDN for images (Cloudinary handles this)
   - Monitor database query performance

---

## 🚀 After Successful Deployment

1. **Update Frontend Configuration**
   - Base URL: `https://metromatrix-api-2e35f5f074df.herokuapp.com`

2. **Send API Documentation to Frontend Team**
   - Include `API_ENDPOINTS_UPDATED.md`
   - Provide admin credentials

3. **Set Up Monitoring**
   - Configure error tracking (Sentry, DataDog, etc.)
   - Set up alerts for failures
   - Monitor response times

4. **Test All Features**
   - User signup → verification → login
   - Provider signup → verification → login → admin approval
   - Image uploads
   - Email notifications
   - OAuth flows

---

## 📞 Support

If you encounter issues:
1. Check Heroku logs: `heroku logs --tail`
2. Check MongoDB connection
3. Verify all environment variables are set
4. Test endpoints using Postman/Insomnia
5. Check email service credentials
6. Verify OAuth provider settings

---

Last Updated: November 29, 2025
Backend Version: 2.0 (Updated with Email Verification Improvements)
