require('dotenv').config(); // Loads your secret variables
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const tls = require('tls');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_with_a_long_secret_key';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;
const HEARTBEAT_INTERVAL_MS = 14 * 60 * 1000;

// Middleware (Security and formatting)
const ALLOWED_ORIGINS = [
    process.env.ALLOWED_ORIGIN,
    'https://personal-space-backend-w8aq.onrender.com',
    'http://localhost:8081',
    'http://localhost:19006',
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(null, true); // Still permissive for Expo — tighten if needed
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(helmet());
app.use(express.json({ limit: '10mb' })); // Allows your server to read incoming JSON data from the app

const uploadDir = path.join(__dirname, 'uploads', 'vault');
const profileUploadDir = path.join(__dirname, 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
}

app.use('/uploads', (req, res, next) => {
    // Cache uploaded media for 7 days in browser/CDN, 1 day private
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    next();
}, express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname || '') || '.bin';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
        const ok = ['image/', 'video/'].some((prefix) => file.mimetype.startsWith(prefix));
        cb(ok ? null : new Error('Only image/video files are allowed'), ok);
    }
});

const profileStorage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, profileUploadDir),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname || '') || '.jpg';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
});

const profileUpload = multer({
    storage: profileStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
        const ok = file.mimetype.startsWith('image/');
        cb(ok ? null : new Error('Only image files are allowed'), ok);
    }
});

const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Try again later.' }
});

const messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many messages. Please slow down.' }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many uploads. Please wait a moment.' }
});

const nudgeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many nudges. Please slow down.' }
});

function createToken(user) {
    return jwt.sign(
        { userId: user.id, name: user.name },
        JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

function isTrue(value) {
    return String(value).toLowerCase() === 'true';
}

function getNumberEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSslConfig() {
    const sslEnabled = isTrue(process.env.DB_SSL_ENABLED) || process.env.NODE_ENV === 'production';
    if (!sslEnabled) {
        return undefined;
    }

    const renderCaPath = '/etc/secrets/ca.pem';
    const localCaPaths = [
        process.env.DB_SSL_CA_PATH_LOCAL,
        process.env.DB_SSL_CA_PATH,
        path.join(__dirname, 'ca.pem'),
        path.join(process.cwd(), 'ca.pem')
    ].filter(Boolean);

    let ca = null;

    if (fs.existsSync(renderCaPath)) {
        ca = fs.readFileSync(renderCaPath, 'utf8');
    } else {
        for (const candidatePath of localCaPaths) {
            if (candidatePath && fs.existsSync(candidatePath)) {
                ca = fs.readFileSync(candidatePath, 'utf8');
                break;
            }
        }
    }

    if (!ca && process.env.DB_SSL_CA && String(process.env.DB_SSL_CA).trim()) {
        ca = process.env.DB_SSL_CA;
    }

    if (!ca) {
        throw new Error('SSL is enabled but no CA was found. Render expects /etc/secrets/ca.pem; for local runs set DB_SSL_CA_PATH_LOCAL or place ca.pem in the server folder.');
    }

    return {
        // Keep Node's default trusted roots and add TiDB CA to avoid issuer-chain failures.
        ca: [ca, ...tls.rootCertificates],
        minVersion: 'TLSv1.2',
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
    };
}

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: getNumberEnv('DB_PORT', 4000),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: buildSslConfig(),
    waitForConnections: true,
    connectionLimit: getNumberEnv('DB_POOL_LIMIT', 10),
    queueLimit: getNumberEnv('DB_QUEUE_LIMIT', 0),
    connectTimeout: getNumberEnv('DB_CONNECT_TIMEOUT_MS', 15000),
    enableKeepAlive: true,
    charset: 'utf8mb4'
});

const dbPromise = db.promise();

async function ensurePinColumnSupportsHashes() {
    const [rows] = await dbPromise.query(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS maxLen
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'users'
           AND COLUMN_NAME = 'pin_code'`
    );

    const maxLen = Number(rows?.[0]?.maxLen || 0);
    if (!Number.isFinite(maxLen) || maxLen >= 60) {
        return;
    }

    await dbPromise.query('ALTER TABLE users MODIFY COLUMN pin_code VARCHAR(255) NULL');
    console.log(`✅ Expanded users.pin_code to VARCHAR(255) (was ${maxLen}) for hashed PIN support.`);
}

async function pinColumnSupportsHashes() {
    const [rows] = await dbPromise.query(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS maxLen
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'users'
           AND COLUMN_NAME = 'pin_code'`
    );

    const maxLen = Number(rows?.[0]?.maxLen || 0);
    return Number.isFinite(maxLen) && maxLen >= 60;
}

async function ensureUserPresenceColumn() {
    try {
        await dbPromise.query('ALTER TABLE users ADD COLUMN is_online BOOLEAN DEFAULT FALSE');
        console.log('✅ Added is_online to users');
    } catch { }
    try {
        await dbPromise.query('ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMP NULL');
        console.log('✅ Added last_seen_at to users');
    } catch { }
}

async function ensurePersonalizationColumns() {
    try {
        await dbPromise.query('ALTER TABLE users ADD COLUMN partner_nickname VARCHAR(50) NULL');
        console.log('✅ Added partner_nickname to users');
    } catch { }
    try {
        await dbPromise.query('ALTER TABLE users ADD COLUMN chat_wallpaper VARCHAR(255) NULL');
        console.log('✅ Added chat_wallpaper to users');
    } catch { }
}

async function ensureMessageFeatureColumns() {
    try {
        await dbPromise.query('ALTER TABLE messages ADD COLUMN reply_to_message_id INT NULL');
        console.log('✅ Added reply_to_message_id to messages');
    } catch { }
    try {
        await dbPromise.query('ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMP NULL');
        console.log('✅ Added deleted_at to messages');
    } catch { }
}

async function initializeDatabase() {
    await dbPromise.query('SELECT 1');
    await ensurePinColumnSupportsHashes();
    await ensureUserPresenceColumn();
    await ensurePersonalizationColumns();
    await ensureMessageFeatureColumns();
    console.log('✅ Successfully connected to TiDB/MySQL using pooled connections.');
}

async function getDbStatus() {
    try {
        await dbPromise.query('SELECT 1');
        return 'up';
    } catch (error) {
        return 'down';
    }
}

function startInternalHeartbeat() {
    const baseUrl = process.env.HEARTBEAT_URL || RENDER_EXTERNAL_URL;
    const shouldRun = isTrue(process.env.HEARTBEAT_ENABLED) || process.env.NODE_ENV === 'production';

    if (!shouldRun || !baseUrl) {
        console.log('ℹ️ Heartbeat disabled (set HEARTBEAT_ENABLED=true and RENDER_EXTERNAL_URL/HEARTBEAT_URL to enable).');
        return;
    }

    const pingUrl = `${String(baseUrl).replace(/\/+$/, '')}/ping`;

    setInterval(async () => {
        try {
            const response = await axios.get(pingUrl, { timeout: 10000 });
            console.log(`❤️ Heartbeat: ${response.status} at ${new Date().toLocaleString()}`);
        } catch (error) {
            console.error('❌ Heartbeat failed:', error.message);
        }
    }, HEARTBEAT_INTERVAL_MS);

    console.log(`❤️ Internal heartbeat enabled for ${pingUrl} (every ${HEARTBEAT_INTERVAL_MS / 60000} minutes).`);
}

let messageSchemaCache = null;
let userPresenceSchemaChecked = false;

async function resolveMessageSchema() {
    if (messageSchemaCache) {
        return messageSchemaCache;
    }

    const [rows] = await dbPromise.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'messages'`
    );

    const columns = new Set(rows.map((row) => row.COLUMN_NAME));
    const senderColumn = columns.has('sender_id') ? 'sender_id' : (columns.has('sender') ? 'sender' : null);
    const textColumn = columns.has('text') ? 'text' : (columns.has('message') ? 'message' : null);
    const timestampColumn = columns.has('sent_at') ? 'sent_at' : (columns.has('created_at') ? 'created_at' : null);
    const replyColumn = columns.has('reply_to_message_id') ? 'reply_to_message_id' : null;
    const seenColumn = columns.has('seen_at') ? 'seen_at' : null;
    const deletedColumn = columns.has('deleted_at') ? 'deleted_at' : null;

    if (!senderColumn) {
        throw new Error('messages table is missing a sender/sender_id column');
    }

    if (!textColumn) {
        throw new Error('messages table is missing a text/message column');
    }

    messageSchemaCache = { senderColumn, textColumn, timestampColumn, replyColumn, seenColumn, deletedColumn };
    return messageSchemaCache;
}

async function ensureMessageFeatureColumns() {
    const [rows] = await dbPromise.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'messages'`
    );

    const columns = new Set(rows.map((row) => row.COLUMN_NAME));
    const alters = [];

    if (!columns.has('reply_to_message_id')) {
        alters.push('ADD COLUMN reply_to_message_id BIGINT NULL');
    }

    if (!columns.has('seen_at')) {
        alters.push('ADD COLUMN seen_at DATETIME NULL');
    }

    if (!columns.has('deleted_at')) {
        alters.push('ADD COLUMN deleted_at DATETIME NULL');
    }

    if (alters.length > 0) {
        try {
            await dbPromise.query(`ALTER TABLE messages ${alters.join(', ')}`);
            messageSchemaCache = null;
            console.log('✅ Added missing chat message feature columns.');
        } catch (error) {
            console.warn('⚠️ Could not auto-add all message feature columns:', error.message);
        }
    }
}

async function ensureUserPresenceColumn() {
    if (userPresenceSchemaChecked) {
        return;
    }

    const [rows] = await dbPromise.query(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'users'
           AND COLUMN_NAME = 'last_seen_at'`
    );

    if (!rows.length) {
        try {
            await dbPromise.query('ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL');
            console.log('✅ Added users.last_seen_at for presence tracking.');
        } catch (error) {
            console.warn('⚠️ Could not add users.last_seen_at:', error.message);
        }
    }

    userPresenceSchemaChecked = true;
}

async function touchUserPresence(userId) {
    try {
        await ensureUserPresenceColumn();
        await dbPromise.query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [userId]);
    } catch (error) {
        console.warn('⚠️ Presence update skipped:', error.message);
    }
}

// ==================== AUTHENTICATION ====================

// POST /login - Verify PIN and return user data
app.post('/login', authLimiter, async (req, res) => {
    const { pin_code } = req.body;

    if (!pin_code) {
        return res.status(400).json({ success: false, message: 'PIN is required' });
    }

    if (!/^\d{4}$/.test(String(pin_code))) {
        return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });
    }

    try {
        // Fetch only users — kept small deliberately (couples app, 2-5 users max).
        // We must check all because PINs are bcrypt-hashed (can't query by plain value).
        const [results] = await dbPromise.query(
            'SELECT id, name, pin_code, profile_pic, partner_nickname, chat_wallpaper FROM users LIMIT 20'
        );

        let matchedUser = null;

        for (const user of results) {
            let valid = false;
            if (user.pin_code && user.pin_code.startsWith('$2')) {
                valid = await bcrypt.compare(pin_code, user.pin_code);
            } else {
                valid = user.pin_code === pin_code;
            }

            if (valid) {
                matchedUser = user;
                break;
            }
        }

        if (!matchedUser) {
            return res.status(401).json({ success: false, message: 'Invalid PIN' });
        }

        // Auto-migrate plain text PIN to hashed on successful login when column supports it.
        if (!matchedUser.pin_code.startsWith('$2')) {
            try {
                if (await pinColumnSupportsHashes()) {
                    const hashed = await bcrypt.hash(pin_code, 12);
                    await dbPromise.query('UPDATE users SET pin_code = ? WHERE id = ?', [hashed, matchedUser.id]);
                }
            } catch (migrationErr) {
                console.error('PIN hash migration skipped:', migrationErr.message);
            }
        }

        await touchUserPresence(matchedUser.id);

        const token = createToken(matchedUser);

        return res.json({
            success: true,
            token,
            user: {
                id: matchedUser.id,
                name: matchedUser.name,
                profile_pic: matchedUser.profile_pic,
                partner_nickname: matchedUser.partner_nickname,
                chat_wallpaper: matchedUser.chat_wallpaper
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /change-password - Change PIN/Password
app.post('/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    const user_id = req.user.userId;

    if (!current_password || !new_password) {
        return res.status(400).json({ 
            success: false, 
            message: 'current_password and new_password are required' 
        });
    }

    if (!/^\d{4}$/.test(String(new_password))) {
        return res.status(400).json({ success: false, message: 'New PIN must be exactly 4 digits' });
    }

    db.query('SELECT id, pin_code FROM users WHERE id = ?', [user_id], async (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Server error' });
        }

        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = results[0];
        const currentMatches = user.pin_code.startsWith('$2')
            ? await bcrypt.compare(current_password, user.pin_code)
            : user.pin_code === current_password;

        if (!currentMatches) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        try {
            const canStoreHashedPin = await pinColumnSupportsHashes();
            const valueToStore = canStoreHashedPin
                ? await bcrypt.hash(new_password, 12)
                : new_password;

            db.query('UPDATE users SET pin_code = ? WHERE id = ?', [valueToStore, user_id], (err) => {
                if (err) {
                    console.error('Database error:', err);
                    return res.status(500).json({ success: false, message: 'Failed to update password' });
                }

                res.json({
                    success: true,
                    message: 'PIN changed successfully! 🎉'
                });
            });
        } catch (schemaErr) {
            console.error('Password update schema check failed:', schemaErr);
            return res.status(500).json({ success: false, message: 'Failed to update password' });
        }
    });
});

app.post('/profile-pic/upload', requireAuth, uploadLimiter, upload.single('profile_pic'), async (req, res) => {
    const userId = req.user.userId;
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const publicFilePath = `/uploads/profiles/${req.file.filename}`;

    try {
        await dbPromise.query('UPDATE users SET profile_pic = ? WHERE id = ?', [publicFilePath, userId]);
        return res.json({ success: true, profile_pic: publicFilePath });
    } catch (err) {
        console.error('Database error updating profile_pic:', err);
        return res.status(500).json({ success: false, message: 'Failed to upload image' });
    }
});

// POST /settings/personalization - Set wallpaper & nickname
app.post('/settings/personalization', requireAuth, uploadLimiter, upload.single('chat_wallpaper'), async (req, res) => {
    const userId = req.user.userId;
    const partnerNickname = req.body.partner_nickname || null;
    let wallpaperPath = req.body.chat_wallpaper || null; // for resetting to default if empty

    if (req.file) {
        wallpaperPath = `/uploads/profiles/${req.file.filename}`;
    }

    try {
        if (wallpaperPath !== undefined && partnerNickname !== undefined) {
             await dbPromise.query('UPDATE users SET chat_wallpaper = ?, partner_nickname = ? WHERE id = ?', [wallpaperPath, partnerNickname, userId]);
        } else if (wallpaperPath !== undefined) {
             await dbPromise.query('UPDATE users SET chat_wallpaper = ? WHERE id = ?', [wallpaperPath, userId]);
        } else if (partnerNickname !== undefined) {
             await dbPromise.query('UPDATE users SET partner_nickname = ? WHERE id = ?', [partnerNickname, userId]);
        }
        
        return res.json({ success: true, chat_wallpaper: wallpaperPath, partner_nickname: partnerNickname });
    } catch (err) {
        console.error('Database error updating personalization:', err);
        return res.status(500).json({ success: false, message: 'Failed to save personalization' });
    }
});

app.post('/profile/picture', requireAuth, profileUpload.single('avatar'), (req, res) => {
    const userId = req.user.userId;

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image uploaded' });
    }

    const filePath = `/uploads/profiles/${req.file.filename}`;

    db.query('UPDATE users SET profile_pic = ? WHERE id = ?', [filePath, userId], (err) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to save profile picture' });
        }

        res.json({
            success: true,
            profile_pic: filePath,
            profile_pic_url: `${req.protocol}://${req.get('host')}${filePath}`
        });
    });
});

app.get('/users/profiles', requireAuth, async (req, res) => {
    try {
        const [rows] = await dbPromise.query(
            'SELECT id, name, profile_pic, last_seen_at, partner_nickname, chat_wallpaper, CASE WHEN last_seen_at IS NOT NULL AND last_seen_at >= (NOW() - INTERVAL 45 SECOND) THEN 1 ELSE 0 END AS is_online FROM users'
        );
        return res.json({ success: true, users: rows });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Server error fetching profiles' });
    }
});

app.post('/presence/heartbeat', requireAuth, async (req, res) => {
    await touchUserPresence(req.user.userId);
    res.json({ success: true, status: 'ok' });
});

app.post('/messages/mark-seen', requireAuth, async (req, res) => {
    try {
        const { senderColumn, seenColumn } = await resolveMessageSchema();

        if (!seenColumn) {
            return res.json({ success: true, updated: 0 });
        }

        const [result] = await dbPromise.query(
            `UPDATE messages
             SET ${seenColumn} = NOW()
             WHERE CAST(${senderColumn} AS UNSIGNED) <> ?
               AND ${seenColumn} IS NULL`,
            [req.user.userId]
        );

        res.json({ success: true, updated: result.affectedRows || 0 });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to mark messages as seen' });
    }
});

// ==================== CHAT MESSAGES ====================

// POST /messages - Save a message to the database
app.post('/messages', requireAuth, messageLimiter, async (req, res) => {
    const { text, reply_to_message_id } = req.body;
    const sender_id = req.user.userId;

    if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    if (String(text).trim().length > 5000) {
        return res.status(400).json({ success: false, message: 'Message too long (max 5000 characters)' });
    }

    try {
        const { senderColumn, textColumn, replyColumn } = await resolveMessageSchema();
        const columns = [senderColumn, textColumn];
        const values = [String(sender_id), String(text).trim()];

        if (replyColumn) {
            columns.push(replyColumn);
            values.push(reply_to_message_id ? Number(reply_to_message_id) : null);
        }

        const [result] = await dbPromise.query(
            `INSERT INTO messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            values
        );

        return res.json({
            success: true,
            message: {
                id: result.insertId,
                sender_id,
                text: String(text).trim(),
                reply_to_message_id: reply_to_message_id ? Number(reply_to_message_id) : null,
                sent_at: new Date()
            }
        });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to save message' });
    }
});

// POST /messages/voice - Upload voice memo and send as [VOICE] payload message
app.post('/messages/voice', requireAuth, messageLimiter, upload.single('audio'), async (req, res) => {
    const senderId = req.user.userId;
    const replyTo = req.body.replyTo ? Number(req.body.replyTo) : null;
    
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No audio file uploaded' });
    }

    const durationMs = req.body.durationMs ? Number(req.body.durationMs) : 0;
    const filePath = `/uploads/vault/${req.file.filename}`;
    
    const payload = JSON.stringify({
        text: '',
        attachments: [
            {
                type: 'voice',
                uri: filePath,
                durationMs: durationMs
            }
        ]
    });
    const messageContent = `[MEDIA_PAYLOAD]${payload}`;

    try {
        const schema = await resolveMessageSchema();
        let query, params;

        if (schema.replyColumn) {
            query = `INSERT INTO messages (${schema.senderColumn}, ${schema.textColumn}, ${schema.replyColumn}) VALUES (?, ?, ?)`;
            params = [senderId, messageContent, replyTo];
        } else {
            query = `INSERT INTO messages (${schema.senderColumn}, ${schema.textColumn}) VALUES (?, ?)`;
            params = [senderId, messageContent];
        }

        const [result] = await dbPromise.query(query, params);
        io.emit('new-message', { id: result.insertId }); // Broadcast natively
        return res.json({ success: true, messageId: result.insertId });
    } catch (err) {
        console.error('Save voice msg error:', err);
        return res.status(500).json({ success: false, message: 'Database error saving voice message' });
    }
});

// GET /messages - Fetch all chat history
app.get('/messages', requireAuth, async (req, res) => {
    try {
        await touchUserPresence(req.user.userId);

        const { senderColumn, textColumn, timestampColumn, replyColumn, seenColumn, deletedColumn } = await resolveMessageSchema();
        const orderColumn = timestampColumn || 'id';
        const selectTimestamp = timestampColumn ? `m.${timestampColumn} AS sent_at` : 'NOW() AS sent_at';
        const selectSender = senderColumn === 'sender_id'
            ? 'm.sender_id'
            : `CAST(m.${senderColumn} AS UNSIGNED) AS sender_id`;

          const replySelects = replyColumn
                ? `, m.${replyColumn} AS reply_to_message_id,
                    ${seenColumn ? `m.${seenColumn} AS seen_at` : 'NULL AS seen_at'},
                    ${deletedColumn ? `m.${deletedColumn} AS deleted_at` : 'NULL AS deleted_at'},
                    parent.${textColumn} AS reply_text,
                    CASE WHEN parent.id IS NULL THEN NULL ELSE CAST(parent.${senderColumn} AS UNSIGNED) END AS reply_sender_id,
                    ${deletedColumn ? 'parent.deleted_at AS reply_deleted_at' : 'NULL AS reply_deleted_at'}`
                : `, NULL AS reply_to_message_id, NULL AS seen_at, NULL AS deleted_at, NULL AS reply_text, NULL AS reply_sender_id, NULL AS reply_deleted_at`;

        if (seenColumn) {
            await dbPromise.query(
                `UPDATE messages
                 SET ${seenColumn} = NOW()
                 WHERE CAST(${senderColumn} AS UNSIGNED) <> ?
                   AND ${seenColumn} IS NULL`,
                [req.user.userId]
            );
        }

        const [results] = await dbPromise.query(
            `SELECT m.id,
                    ${selectSender},
                    CASE WHEN ${deletedColumn ? `m.${deletedColumn} IS NULL` : '1=1'} THEN m.${textColumn} ELSE NULL END AS text,
                    ${selectTimestamp}${replySelects}
             FROM messages m
             LEFT JOIN messages parent ON ${replyColumn ? `parent.id = m.${replyColumn}` : '1 = 0'}
             ORDER BY m.${orderColumn} ASC`
        );

        res.json({ success: true, messages: results });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch messages' });
    }
});

// DELETE /messages/:id - Soft-delete (unsend) a specific message
app.delete('/messages/:id', requireAuth, async (req, res) => {
    const messageId = Number(req.params.id);
    const userId = req.user.userId;

    if (!Number.isFinite(messageId)) {
        return res.status(400).json({ success: false, message: 'Invalid message id' });
    }

    try {
        const { senderColumn, deletedColumn } = await resolveMessageSchema();

        if (!deletedColumn) {
            return res.status(404).json({ success: false, message: 'Unsend feature not available' });
        }

        const [rows] = await dbPromise.query(
            `SELECT id FROM messages WHERE id = ? AND CAST(${senderColumn} AS UNSIGNED) = ? AND ${deletedColumn} IS NULL`,
            [messageId, userId]
        );

        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Message not found or already unsent' });
        }

        await dbPromise.query(
            `UPDATE messages SET ${deletedColumn} = NOW() WHERE id = ?`,
            [messageId]
        );

        return res.json({ success: true, message: 'Message unsent' });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to unsend message' });
    }
});

// POST /messages/:id/unsend - Alias for DELETE (for clients that can't send DELETE)
app.post('/messages/:id/unsend', requireAuth, async (req, res) => {
    const messageId = Number(req.params.id);
    const userId = req.user.userId;

    if (!Number.isFinite(messageId)) {
        return res.status(400).json({ success: false, message: 'Invalid message id' });
    }

    try {
        const { senderColumn, deletedColumn } = await resolveMessageSchema();

        if (!deletedColumn) {
            return res.status(404).json({ success: false, message: 'Unsend feature not available' });
        }

        const [rows] = await dbPromise.query(
            `SELECT id FROM messages WHERE id = ? AND CAST(${senderColumn} AS UNSIGNED) = ? AND ${deletedColumn} IS NULL`,
            [messageId, userId]
        );

        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Message not found or already unsent' });
        }

        await dbPromise.query(
            `UPDATE messages SET ${deletedColumn} = NOW() WHERE id = ?`,
            [messageId]
        );

        return res.json({ success: true, message: 'Message unsent' });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to unsend message' });
    }
});

// POST /messages/clear - Clear all chat history (requires explicit confirmation)
app.post('/messages/clear', requireAuth, async (req, res) => {
    const { confirm } = req.body || {};

    if (confirm !== 'DELETE_ALL_MESSAGES') {
        return res.status(400).json({
            success: false,
            message: 'Confirmation token is required to clear chat history.'
        });
    }

    try {
        const [result] = await dbPromise.query('DELETE FROM messages');
        await touchUserPresence(req.user.userId);

        res.json({
            success: true,
            deleted: result.affectedRows || 0,
            message: 'All chat messages deleted.'
        });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to clear messages' });
    }
});

// ==================== VAULT (FILE UPLOADS) ====================

// POST /vault/upload - Upload image/video to private vault
app.post('/vault/upload', requireAuth, uploadLimiter, upload.single('media'), async (req, res) => {
    const userId = req.user.userId;
    const caption = (req.body.caption || '').toString().trim();

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No media file uploaded' });
    }

    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const filePath = `/uploads/vault/${req.file.filename}`;

    try {
        const [result] = await dbPromise.query(
            'INSERT INTO vault_items (user_id, media_type, file_path, caption) VALUES (?, ?, ?, ?)',
            [userId, mediaType, filePath, caption]
        );

        return res.json({
            success: true,
            item: {
                id: result.insertId,
                user_id: userId,
                media_type: mediaType,
                file_path: filePath,
                caption,
                created_at: new Date()
            }
        });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to save media item' });
    }
});

// GET /vault - Fetch own vault media history
app.get('/vault', requireAuth, async (req, res) => {
    const userId = req.user.userId;
    try {
        const [results] = await dbPromise.query(
            'SELECT * FROM vault_items WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        return res.json({ success: true, items: results });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch vault items' });
    }
});

// DELETE /vault - Clear authenticated user's vault
app.delete('/vault', requireAuth, async (req, res) => {
    const userId = req.user.userId;
    try {
        const [rows] = await dbPromise.query(
            'SELECT file_path FROM vault_items WHERE user_id = ?',
            [userId]
        );
        const deletedCount = rows.length;

        await dbPromise.query('DELETE FROM vault_items WHERE user_id = ?', [userId]);

        rows.forEach((row) => {
            const fullPath = path.join(__dirname, String(row.file_path || '').replace(/^\//, ''));
            // Best-effort cleanup if file is already missing.
            fs.unlink(fullPath, () => { });
        });

        return res.json({ success: true, deleted: deletedCount, message: 'Vault cleared.' });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to clear vault' });
    }
});

// DELETE /vault/:id - Delete own vault item
app.delete('/vault/:id', requireAuth, async (req, res) => {
    const itemId = Number(req.params.id);
    const userId = req.user.userId;

    try {
        const [rows] = await dbPromise.query(
            'SELECT * FROM vault_items WHERE id = ? AND user_id = ?',
            [itemId, userId]
        );
        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Item not found' });
        }

        const fullPath = path.join(__dirname, rows[0].file_path.replace(/^\//, ''));
        await dbPromise.query('DELETE FROM vault_items WHERE id = ?', [itemId]);
        fs.unlink(fullPath, () => { /* Ignore if file already missing */ });
        return res.json({ success: true });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete item' });
    }
});

// ==================== DATES ====================

app.get('/dates', requireAuth, async (_, res) => {
    try {
        const [results] = await dbPromise.query('SELECT * FROM special_dates ORDER BY event_date ASC');
        return res.json({ success: true, items: results });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch dates' });
    }
});

app.post('/dates', requireAuth, async (req, res) => {
    const userId = req.user.userId;
    const title = (req.body.title || '').toString().trim();
    const eventDate = (req.body.date || '').toString().trim();

    if (!title || !eventDate) {
        return res.status(400).json({ success: false, message: 'title and date are required' });
    }

    try {
        const [result] = await dbPromise.query(
            'INSERT INTO special_dates (user_id, title, event_date) VALUES (?, ?, ?)',
            [userId, title, eventDate]
        );
        res.json({
            success: true,
            item: { id: result.insertId, user_id: userId, title, date: eventDate }
        });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to save date' });
    }
});

app.delete('/dates/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user.userId;
    try {
        await dbPromise.query('DELETE FROM special_dates WHERE id = ? AND user_id = ?', [id, userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete date' });
    }
});

// ==================== NUDGES ====================

app.get('/nudges', requireAuth, async (_, res) => {
    try {
        const [results] = await dbPromise.query(
            `SELECT n.id, n.sender_id, n.text, n.created_at, u.name AS sender_name, u.profile_pic AS sender_profile_pic
             FROM nudges n
             JOIN users u ON n.sender_id = u.id
             ORDER BY n.created_at DESC`
        );
        res.json({ success: true, items: results });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch nudges' });
    }
});

app.post('/nudges', requireAuth, nudgeLimiter, async (req, res) => {
    const senderId = req.user.userId;
    const senderName = req.user.name;
    const text = (req.body.text || '').toString().trim();

    if (!text) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    if (text.length > 500) {
        return res.status(400).json({ success: false, message: 'Nudge too long (max 500 characters)' });
    }

    try {
        const [result] = await dbPromise.query('INSERT INTO nudges (sender_id, text) VALUES (?, ?)', [senderId, text]);
        const [rows] = await dbPromise.query('SELECT profile_pic FROM users WHERE id = ?', [senderId]);

        return res.json({
            success: true,
            item: {
                id: result.insertId,
                sender_id: senderId,
                sender_name: senderName,
                sender_profile_pic: rows[0]?.profile_pic || null,
                text,
                created_at: new Date()
            }
        });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to save nudge' });
    }
});

app.delete('/nudges/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const senderId = req.user.userId;
    try {
        await dbPromise.query('DELETE FROM nudges WHERE id = ? AND sender_id = ?', [id, senderId]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete nudge' });
    }
});

// ==================== HEALTH & ROOT ROUTES ====================

app.get('/health', async (_, res) => {
    const dbStatus = await getDbStatus();
    const status = dbStatus === 'up' ? 200 : 503;
    res.status(status).json({
        success: dbStatus === 'up',
        status: dbStatus === 'up' ? 'ok' : 'degraded',
        db: dbStatus,
        timestamp: new Date().toISOString()
    });
});

app.get('/ping', async (_, res) => {
    const dbStatus = await getDbStatus();
    const status = dbStatus === 'up' ? 200 : 503;
    res.status(status).json({
        success: dbStatus === 'up',
        status: dbStatus === 'up' ? 'ok' : 'degraded',
        db: dbStatus,
        timestamp: new Date().toISOString()
    });
});

app.get('/', (_, res) => {
    res.json({ message: 'Welcome to the Personal Space API! Server is online.' });
});

const PORT = getNumberEnv('PORT', 10000);

async function startServer() {
    try {
        await initializeDatabase();
        app.use((req, res) => res.status(404).json({ success: false, message: 'Not Found' }));

        // Socket.IO Setup
        const io = new Server(httpServer, {
            cors: { origin: '*', methods: ['GET', 'POST'] },
            pingTimeout: 60000,
        });

        // Make io global for route emit access (if needed, though standard events are mostly handled inside socket)
        global.io = io;

        io.use((socket, next) => {
            const token = socket.handshake.auth.token || socket.handshake.query.token;
            if (!token) return next(new Error('Authentication error'));
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                socket.user = decoded;
                next();
            } catch (err) {
                next(new Error('Authentication error'));
            }
        });

        io.on('connection', (socket) => {
            const userId = socket.user.userId;
            socket.join(`user_${userId}`);
            
            socket.on('typing', (isTyping) => {
                socket.broadcast.emit('typing', { userId, isTyping });
            });

            socket.on('disconnect', () => {
                // Not broadcasting immediate offline since they might just be refreshing
            });
        });

        httpServer.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`);
            if (RENDER_EXTERNAL_URL) {
                console.log(`🌐 Public URL: ${RENDER_EXTERNAL_URL}`);
            }
            startInternalHeartbeat();
        });
    } catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
}

startServer();