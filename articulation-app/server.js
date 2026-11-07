require('dotenv').config();
const express = require('express');
const admin = require("firebase-admin");
const path = require('path');
const multer = require('multer');
const cloudinary = require("./cloudinary");
const streamifier = require("streamifier");
const cors = require('cors');
const jwt = require('jsonwebtoken');

const { v4: uuidv4 } = require('uuid');
const { initDatabase, dbGet, dbAll, dbRun, saveDatabase } = require('./database');
const { db, firebaseReady } = require("./config/firebase");
const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key';

// ===================== MIDDLEWARE =====================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===================== EMAIL (Brevo HTTP API) =====================
async function sendOTP(email, otp) {
  if (!process.env.BREVO_API_KEY) {
    console.log(`\n🔐 OTP for ${email}: ${otp}\n`); // dev fallback
    return;
  }
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Smart Articulation', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: 'Smart Articulation — Your Login Code',
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <div style="background:#0F7A72;color:#fff;padding:18px 24px;border-radius:16px 16px 0 0;text-align:center;">
            <h2 style="margin:0;">Smart Articulation</h2>
          </div>
          <div style="background:#fff;border:1px solid #D9ECE9;border-top:none;padding:24px;border-radius:0 0 16px 16px;">
            <p style="color:#0F2E2B;font-size:16px;">Your verification code is:</p>
            <div style="background:#F5FBFA;border:2px solid #DFF3F0;border-radius:12px;padding:18px;text-align:center;margin:16px 0;">
              <span style="font-size:36px;font-weight:800;color:#0F7A72;letter-spacing:6px;">${otp}</span>
            </div>
            <p style="color:#6B8B87;font-size:14px;">This code expires in 10 minutes.</p>
          </div>
        </div>`
    })
  });
  if (!resp.ok) throw new Error(`Brevo failed: ${resp.status} ${await resp.text()}`);
  console.log(`📧 OTP sent to ${email}`);
}
// ===================== AUTH MIDDLEWARE =====================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ===================== FILE UPLOAD =====================
const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: {
        fileSize: 100 * 1024 * 1024
    }
});


// ===================== AUTH ROUTES =====================

// Step 1: Request OTP
app.post('/api/auth/request-otp', async (req, res) => {
  console.log("===== OTP REQUEST =====");
  console.log("Request Body:", req.body);
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const normalizedEmail = email.toLowerCase().trim();
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const existing = dbGet('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) {
      dbRun('UPDATE users SET otp = ?, otp_expires_at = ? WHERE id = ?', [otp, expiresAt, existing.id]);
    } else {
      dbRun('INSERT INTO users (email, name, role, otp, otp_expires_at) VALUES (?, ?, ?, ?, ?)', [normalizedEmail, normalizedEmail.split('@')[0], 'learner', otp, expiresAt]);
    }

    await sendOTP(normalizedEmail, otp);
    res.json({ message: 'OTP sent to your email', email: normalizedEmail });
  } catch (err) {
    console.error('Request OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Step 2: Verify OTP
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { email, otp, name, role, doctorEmail } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });

    const normalizedEmail = email.toLowerCase().trim();
    const user = dbGet('SELECT * FROM users WHERE email = ?', [normalizedEmail]);

    if (!user) return res.status(404).json({ error: 'User not found. Request OTP first.' });
    if (user.otp !== otp) return res.status(400).json({ error: 'Invalid OTP. Please check your email.' });
    if (new Date(user.otp_expires_at) < new Date()) return res.status(400).json({ error: 'OTP expired. Request a new one.' });

    const finalRole = (role && ['learner', 'doctor'].includes(role)) ? role : user.role;
    const finalName = name || user.name;

    dbRun('UPDATE users SET is_verified = 1, otp = NULL, otp_expires_at = NULL, name = ?, role = ?, updated_at = datetime(\'now\') WHERE id = ?', [finalName, finalRole, user.id]);

    // Initialize default settings if not exists
    const settings = dbGet('SELECT id FROM user_settings WHERE user_id = ?', [user.id]);
    if (!settings) {
      dbRun('INSERT INTO user_settings (user_id) VALUES (?)', [user.id]);
    }

    // Initialize default assigned sounds for new learners
    const assigned = dbGet('SELECT COUNT(*) as cnt FROM assigned_sounds WHERE user_id = ?', [user.id]);
    if (assigned.cnt === 0 && finalRole === 'learner') {
      const allSounds = dbAll('SELECT sound_id FROM sounds WHERE is_active = 1');
      allSounds.forEach(s => {
        dbRun('INSERT OR IGNORE INTO assigned_sounds (user_id, sound_id) VALUES (?, ?)', [user.id, s.sound_id]);
      });
    }

    // Handle doctor assignment for learners
    if (finalRole === 'learner' && doctorEmail) {
      const normalizedDocEmail = doctorEmail.toLowerCase().trim();
      const doctor = dbGet('SELECT id FROM users WHERE email = ? AND role = ?', [normalizedDocEmail, 'doctor']);
      if (doctor) {
        dbRun('INSERT OR IGNORE INTO learner_doctor (learner_id, doctor_id) VALUES (?, ?)', [user.id, doctor.id]);
      } else {
        const result = dbRun('INSERT INTO users (email, name, role, is_verified) VALUES (?, ?, ?, 1)', [normalizedDocEmail, 'Dr. ' + normalizedDocEmail.split('@')[0], 'doctor']);
        dbRun('INSERT OR IGNORE INTO learner_doctor (learner_id, doctor_id) VALUES (?, ?)', [user.id, result.lastInsertRowid]);
      }
    }

    saveDatabase();

    const token = jwt.sign({ id: user.id, email: normalizedEmail, role: finalRole }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: { id: user.id, email: normalizedEmail, name: finalName, role: finalRole },
      isNewUser: !user.is_verified
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});
app.post("/api/auth/google-login", async (req, res) => {
  if (!firebaseReady) {
    return res.status(501).json({ error: "Google sign-in is not configured on this server. Use Gmail OTP login instead." });
  }
  try {
    const { token } = req.body;

    const decodedToken = await admin.auth().verifyIdToken(token);

    const email = decodedToken.email;
    const name = decodedToken.name || email.split("@")[0];

    // Check if user exists
    const existing = dbGet(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (!existing) {
      dbRun(
        "INSERT INTO users (email, name, role) VALUES (?, ?, ?)",
        [email, name, "learner"]
      );
    }

    const user = dbGet(
  "SELECT * FROM users WHERE email = ?",
  [email]
);

const jwtToken = jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role
  },
  JWT_SECRET,
  { expiresIn: "7d" }
);

res.json({
  token: jwtToken,
  user: {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role
  }
});

  } catch (err) {
    console.error(err);
    res.status(401).json({
      error: "Invalid Google Token"
    });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const settings = dbGet('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);

  let doctor = null;
  if (user.role === 'learner') {
    doctor = dbGet(`SELECT u.id, u.email, u.name FROM users u JOIN learner_doctor ld ON u.id = ld.doctor_id WHERE ld.learner_id = ?`, [req.user.id]);
  }

  res.json({ user, settings: settings || {}, doctor });
});

// ===================== SOUNDS ROUTES =====================
app.get('/api/sounds', (req, res) => {
  const sounds = dbAll('SELECT * FROM sounds WHERE is_active = 1 ORDER BY sort_order');
  const parsed = sounds.map(s => ({
    ...s,
    words: JSON.parse(s.words_json || '{}'),
    sentences: JSON.parse(s.sentences_json || '[]'),
    videoTargets: JSON.parse(s.video_targets_json || '{}')
  }));
  res.json({ sounds: parsed });
});

app.post('/api/sounds', authMiddleware, (req, res) => {
  const user = dbGet('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (user?.role !== 'doctor') return res.status(403).json({ error: 'Only doctors can add sounds' });

  const { id, label, symbol, category, voicing, description, tongue, lips, jaw, airflow, tip, tongueTarget, words, sentences, videoTargets } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'Sound id and label are required' });

  try {
    dbRun(`INSERT OR REPLACE INTO sounds (sound_id, label, symbol, category, voicing, description, tongue, lips, jaw, airflow, tip, tongue_target, words_json, sentences_json, video_targets_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, label, symbol, category, voicing, description, tongue, lips, jaw, airflow, tip, tongueTarget, JSON.stringify(words||{}), JSON.stringify(sentences||[]), JSON.stringify(videoTargets||{}), 99]);
    saveDatabase();
    res.json({ message: 'Sound added successfully' });
  }catch (err) {
    console.error("===== OTP ERROR =====");
    console.error(err);
    console.error(err.stack);

    res.status(500).json({
        error: err.message
    });
  }
});

// ===================== LEARNER ROUTES =====================

app.get('/api/learner/assigned-sounds', authMiddleware, (req, res) => {
  const assigned = dbAll(`SELECT s.*, asg.assigned_at FROM assigned_sounds asg JOIN sounds s ON s.sound_id = asg.sound_id WHERE asg.user_id = ? AND s.is_active = 1 ORDER BY s.sort_order`, [req.user.id]);
  const parsed = assigned.map(s => ({
    ...s,
    words: JSON.parse(s.words_json || '{}'),
    sentences: JSON.parse(s.sentences_json || '[]'),
    videoTargets: JSON.parse(s.video_targets_json || '{}')
  }));
  res.json({ sounds: parsed });
});

app.get('/api/learner/progress', authMiddleware, (req, res) => {
  const progress = dbAll('SELECT * FROM learner_progress WHERE user_id = ?', [req.user.id]);
  const attempts = dbAll('SELECT * FROM practice_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const settings = dbGet('SELECT * FROM user_settings WHERE user_id = ?', [req.user.id]);
  const doctor = dbGet(`SELECT u.id, u.email, u.name FROM users u JOIN learner_doctor ld ON u.id = ld.doctor_id WHERE ld.learner_id = ?`, [req.user.id]);

  res.json({ progress, attempts, settings: settings || {}, doctor });
});

app.post('/api/learner/attempt', authMiddleware, (req, res) => {
  const { soundId, level, score, transcript, targetText, mouthShape } = req.body;

  dbRun(`INSERT INTO practice_attempts (user_id, sound_id, level, score, transcript, target_text, mouth_shape_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, soundId, level, score, transcript || '', targetText || '', JSON.stringify(mouthShape || null)]);

  // Update or create progress record
  const existing = dbGet('SELECT * FROM learner_progress WHERE user_id = ? AND sound_id = ?', [req.user.id, soundId]);
  if (existing) {
    const attempts = dbAll('SELECT score FROM practice_attempts WHERE user_id = ? AND sound_id = ? AND level = ? ORDER BY created_at DESC LIMIT 3', [req.user.id, soundId, level]);
    const avgScore = attempts.reduce((a, b) => a + b.score, 0) / attempts.length;

    let updates = { points: existing.points + Math.round(score / 10), sessions: existing.sessions + 1 };
    if (level === 'sound' && avgScore >= 80) updates.unlocked_word = 1;
    if (level === 'word' && avgScore >= 80) updates.unlocked_sentence = 1;

    dbRun(`UPDATE learner_progress SET points = ?, sessions = ?, unlocked_word = COALESCE(?, unlocked_word), unlocked_sentence = COALESCE(?, unlocked_sentence), last_practice_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [updates.points, updates.sessions, updates.unlocked_word || null, updates.unlocked_sentence || null, existing.id]);
  } else {
    dbRun(`INSERT INTO learner_progress (user_id, sound_id, points, sessions, last_practice_at) VALUES (?, ?, ?, 1, datetime('now'))`,
      [req.user.id, soundId, Math.round(score / 10)]);
  }

  saveDatabase();
  res.json({ message: 'Attempt recorded' });
});

app.post('/api/learner/assign-doctor', authMiddleware, (req, res) => {
  const { doctorEmail } = req.body;
  if (!doctorEmail) return res.status(400).json({ error: 'Doctor email is required' });

  const normalizedEmail = doctorEmail.toLowerCase().trim();
  let doctor = dbGet('SELECT id FROM users WHERE email = ? AND role = ?', [normalizedEmail, 'doctor']);

  if (!doctor) {
    const result = dbRun('INSERT INTO users (email, name, role, is_verified) VALUES (?, ?, ?, 1)', [normalizedEmail, 'Dr. ' + normalizedEmail.split('@')[0], 'doctor']);
    doctor = { id: result.lastInsertRowid };
  }

  dbRun('INSERT OR IGNORE INTO learner_doctor (learner_id, doctor_id) VALUES (?, ?)', [req.user.id, doctor.id]);
  saveDatabase();
  res.json({ message: 'Doctor assigned successfully', doctorEmail: normalizedEmail });
});

// ===================== VIDEO SUBMISSIONS =====================

app.post('/api/learner/submit-video', authMiddleware, upload.single('video'), async (req, res) => {
    try {
        const { soundId, level, score, targetText, notes, analysisData } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: "No video uploaded" });
        }

        const assignment = dbGet(
            'SELECT doctor_id FROM learner_doctor WHERE learner_id = ?',
            [req.user.id]
        );

        if (!assignment) {
            return res.status(400).json({
                error: "No doctor assigned. Please add a doctor email first."
            });
        }

        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    resource_type: "video",
                    folder: "articulation-videos"
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );

            streamifier.createReadStream(req.file.buffer).pipe(stream);
        });

        const videoPath = uploadResult.secure_url;

        dbRun(
            `INSERT INTO video_submissions
            (learner_id, doctor_id, sound_id, level, video_path, notes, score, target_text, analysis_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.user.id,
                assignment.doctor_id,
                soundId,
                level,
                videoPath,
                notes || "",
                parseInt(score) || 0,
                targetText || "",
                analysisData || null
            ]
        );

        saveDatabase();

        res.json({
            message: "Video uploaded successfully!",
            videoUrl: videoPath
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: "Video upload failed."
        });
    }
});

app.get('/api/learner/videos', authMiddleware, (req, res) => {
  const videos = dbAll(`SELECT vs.*, u.name as doctor_name FROM video_submissions vs JOIN users u ON u.id = vs.doctor_id WHERE vs.learner_id = ? ORDER BY vs.created_at DESC`, [req.user.id]);
  res.json({ videos });
});

// ===================== DOCTOR ROUTES =====================

app.get('/api/doctor/learners', authMiddleware, (req, res) => {
  const user = dbGet('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (user?.role !== 'doctor') return res.status(403).json({ error: 'Doctor access only' });

  const learners = dbAll(`SELECT u.id, u.email, u.name, u.created_at, ld.assigned_at FROM users u JOIN learner_doctor ld ON u.id = ld.learner_id WHERE ld.doctor_id = ? ORDER BY ld.assigned_at DESC`, [req.user.id]);

  const enriched = learners.map(l => {
    const attempts = dbGet('SELECT COUNT(*) as count FROM practice_attempts WHERE user_id = ?', [l.id]);
    const avgScore = dbGet('SELECT AVG(score) as avg FROM practice_attempts WHERE user_id = ?', [l.id]);
    const videoCount = dbGet('SELECT COUNT(*) as count FROM video_submissions WHERE learner_id = ? AND doctor_id = ?', [l.id, req.user.id]);
    const pendingVideos = dbGet("SELECT COUNT(*) as count FROM video_submissions WHERE learner_id = ? AND doctor_id = ? AND status = 'pending'", [l.id, req.user.id]);

    return {
      ...l,
      totalAttempts: attempts?.count || 0,
      avgScore: Math.round(avgScore?.avg || 0),
      videoCount: videoCount?.count || 0,
      pendingVideos: pendingVideos?.count || 0
    };
  });

  res.json({ learners: enriched });
});

app.get('/api/doctor/learner/:id', authMiddleware, (req, res) => {
  const learnerId = parseInt(req.params.id);

  const learner = dbGet('SELECT id, email, name, created_at FROM users WHERE id = ?', [learnerId]);
  if (!learner) return res.status(404).json({ error: 'Learner not found' });

  const progress = dbAll('SELECT * FROM learner_progress WHERE user_id = ?', [learnerId]);
  const recentAttempts = dbAll('SELECT * FROM practice_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [learnerId]);
  const videos = dbAll('SELECT * FROM video_submissions WHERE learner_id = ? AND doctor_id = ? ORDER BY created_at DESC', [learnerId, req.user.id]);
  const notes = dbAll('SELECT * FROM doctor_notes WHERE learner_id = ? AND doctor_id = ? ORDER BY created_at DESC', [learnerId, req.user.id]);
  const assigned = dbAll('SELECT s.sound_id, s.label, s.category FROM assigned_sounds asg JOIN sounds s ON s.sound_id = asg.sound_id WHERE asg.user_id = ?', [learnerId]);

  res.json({ learner, progress, recentAttempts, videos, notes, assigned });
});

app.post('/api/doctor/note', authMiddleware, (req, res) => {
  const { learnerId, note } = req.body;
  if (!learnerId || !note) return res.status(400).json({ error: 'Learner ID and note required' });

  dbRun('INSERT INTO doctor_notes (doctor_id, learner_id, note) VALUES (?, ?, ?)', [req.user.id, learnerId, note]);
  saveDatabase();
  res.json({ message: 'Note added' });
});

app.post('/api/doctor/video-feedback', authMiddleware, (req, res) => {
  const { videoId, feedback, rating } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Video ID required' });

  dbRun(`UPDATE video_submissions SET doctor_feedback = ?, doctor_rating = ?, status = 'feedback_given', reviewed_at = datetime('now') WHERE id = ? AND doctor_id = ?`,
    [feedback || '', rating || null, videoId, req.user.id]);
  saveDatabase();
  res.json({ message: 'Feedback submitted' });
});

app.post('/api/doctor/assign-sounds', authMiddleware, (req, res) => {
  const { learnerId, soundIds } = req.body;
  if (!learnerId || !Array.isArray(soundIds)) return res.status(400).json({ error: 'Learner ID and sound IDs required' });

  dbRun('DELETE FROM assigned_sounds WHERE user_id = ?', [learnerId]);
  soundIds.forEach(sid => {
    dbRun('INSERT INTO assigned_sounds (user_id, sound_id, assigned_by) VALUES (?, ?, ?)', [learnerId, sid, req.user.id]);
  });

  saveDatabase();
  res.json({ message: 'Sounds assigned' });
});

// ===================== SETTINGS =====================
app.put('/api/settings', authMiddleware, (req, res) => {
  const { language, consentRecording, consentCamera, privacyMode } = req.body;

  const existing = dbGet('SELECT id FROM user_settings WHERE user_id = ?', [req.user.id]);
  if (existing) {
    dbRun('UPDATE user_settings SET language = ?, consent_recording = ?, consent_camera = ?, privacy_mode = ? WHERE user_id = ?',
      [language || 'en', consentRecording ? 1 : 0, consentCamera ? 1 : 0, privacyMode || 'emoji', req.user.id]);
  } else {
    dbRun('INSERT INTO user_settings (user_id, language, consent_recording, consent_camera, privacy_mode) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, language || 'en', consentRecording ? 1 : 0, consentCamera ? 1 : 0, privacyMode || 'emoji']);
  }

  saveDatabase();
  res.json({ message: 'Settings updated' });
});

// ===================== SERVE FRONTEND =====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== START SERVER =====================
async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`\n🚀 Smart Articulation Training System`);
    console.log(`   Server running at http://localhost:${PORT}`);
    console.log(`   Database: ${process.env.DB_PATH || './data/articulation.db'}`);
    console.log("✅ Firebase connected successfully!");
    if (!process.env.EMAIL_HOST) {
      console.log(`   ⚠️  No email configured — OTPs shown in console`);
    }
    console.log('');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
