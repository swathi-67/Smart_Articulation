# Smart Articulation Training System — Full Stack

A complete speech therapy training platform with **Gmail OTP authentication**, **expanded syllabus (20 sounds)**, **doctor-patient assignment**, and **video practice sharing** — all in the same beautiful theme.

## ✅ Features Implemented

### 🔐 Gmail OTP Login
- Users enter their Gmail address and receive a 6-digit OTP code
- OTP is sent via Gmail SMTP (configurable in `.env`)
- Without SMTP config, OTPs appear in the server console for development
- 60-second cooldown timer for resend
- Auto-focus between OTP input boxes

### 📚 Expanded Syllabus (20 Sounds)
| Category | Sounds |
|----------|--------|
| **Liquids** | R, L |
| **Fricatives** | S, SH, F, V, Z, H |
| **Affricates** | CH |
| **Interdental** | TH |
| **Stops** | K, G, P, B, T, D |
| **Nasals** | N, M |
| **Glides** | W, Y |

Each sound includes: description, tongue/lips/jaw/airflow positions, tips, words (initial/medial/final), sentences, and video coaching targets.

### 🧑‍⚕️ Doctor Assignment
- During login, learners enter their doctor's email
- Doctor account is auto-created if it doesn't exist
- Learners can change their assigned doctor from their profile
- Doctors see all assigned patients in their dashboard

### 📹 Video Practice to Doctor
- Learners record practice videos during sessions
- Videos are sent directly to their assigned doctor
- Doctors can:
  - Watch patient practice videos
  - Add written feedback
  - Rate performance (1-5 stars)
  - Add clinical notes
- Learners see feedback status (pending → reviewed → feedback given)

### 🗄️ Database & Server
- **Express.js** backend with REST API
- **SQLite** database (via better-sqlite3) — zero config, portable
- **JWT authentication** with 7-day expiry
- **Multer** for video file uploads (up to 100MB)
- All data persisted in `data/articulation.db`

## 🚀 Quick Start

```bash
cd /home/user/articulation-app
npm install
npm start
```

Open **http://localhost:3000** in your browser.

## 📧 Enable Gmail OTP (Production)

1. Enable 2-Factor Authentication on your Google account
2. Go to https://myaccount.google.com/apppasswords
3. Generate an App Password for "Mail"
4. Edit `.env`:

```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
EMAIL_FROM=Smart Articulation <your-email@gmail.com>
```

5. Restart the server

## 🌐 Production Deployment

### Option 1: Railway / Render / Fly.io
1. Push to GitHub
2. Connect to Railway/Render
3. Set environment variables from `.env`
4. Deploy!

### Option 2: VPS (Ubuntu/Debian)
```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone/upload project
cd /opt/articulation-app
npm install --production

# Use PM2 for process management
npm install -g pm2
pm2 start server.js --name articulation
pm2 startup
pm2 save

# Nginx reverse proxy
sudo apt install nginx
```

Nginx config:
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    client_max_body_size 100M;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Option 3: With SSL (Let's Encrypt)
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 📁 Project Structure

```
articulation-app/
├── server.js          # Express API server
├── database.js        # SQLite schema + seed data (20 sounds)
├── package.json       # Dependencies
├── .env               # Environment config
├── .env.example       # Template
├── public/
│   ├── index.html     # Frontend entry point
│   ├── style.css      # Same beautiful theme (CSS tokens)
│   └── script.js      # Full frontend logic
├── uploads/
│   └── videos/        # Uploaded practice videos
└── data/
    └── articulation.db  # SQLite database (auto-created)
```

## 🔒 Security Notes

- JWT tokens expire after 7 days
- OTPs expire after 10 minutes
- Passwords are not stored (OTP-only auth)
- Video files stored locally on server
- In production, add rate limiting and HTTPS

## 📊 Database Schema

| Table | Purpose |
|-------|---------|
| `users` | Learners and doctors (email OTP auth) |
| `learner_doctor` | Doctor-patient assignments |
| `sounds` | 20 speech sounds with full data |
| `practice_attempts` | All practice session records |
| `video_submissions` | Videos sent to doctors |
| `learner_progress` | Per-sound progress tracking |
| `assigned_sounds` | Which sounds are assigned to each learner |
| `doctor_notes` | Clinical notes from doctors |
| `user_settings` | Language, consent, preferences |
