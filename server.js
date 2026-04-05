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

const app = express();
app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_with_a_long_secret_key';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;
const HEARTBEAT_INTERVAL_MS = 14 * 60 * 1000;

// Middleware (Security and formatting)
app.use(cors());
app.use(helmet());
app.use(express.json()); // Allows your server to read incoming JSON data from the app

const uploadDir = path.join(__dirname, 'uploads', 'vault');
const profileUploadDir = path.join(__dirname, 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

async function initializeDatabase() {
    await dbPromise.query('SELECT 1');
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

    if (!senderColumn) {
        throw new Error('messages table is missing a sender/sender_id column');
    }

    if (!textColumn) {
        throw new Error('messages table is missing a text/message column');
    }

    messageSchemaCache = { senderColumn, textColumn, timestampColumn };
    return messageSchemaCache;
}

// ==================== AUTHENTICATION ====================

// POST /login - Verify PIN and return user data
app.post('/login', authLimiter, (req, res) => {
    const { pin_code } = req.body;

    if (!pin_code) {
        return res.status(400).json({ success: false, message: 'PIN is required' });
    }

    if (!/^\d{4}$/.test(String(pin_code))) {
        return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });
    }

    // Query all users and verify pin (supports both plain and hashed pin_code)
    db.query('SELECT id, name, pin_code, profile_pic FROM users', async (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Server error' });
        }

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

        // Auto-migrate plain text PIN to hashed on successful login
        if (!matchedUser.pin_code.startsWith('$2')) {
            const hashed = await bcrypt.hash(pin_code, 12);
            db.query('UPDATE users SET pin_code = ? WHERE id = ?', [hashed, matchedUser.id]);
        }

        const token = createToken(matchedUser);

        res.json({
            success: true,
            token,
            user: {
                id: matchedUser.id,
                name: matchedUser.name,
                profile_pic: matchedUser.profile_pic
            }
        });
    });
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

        const newHashed = await bcrypt.hash(new_password, 12);

        // Update to new password
        db.query('UPDATE users SET pin_code = ? WHERE id = ?', [newHashed, user_id], (err) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ success: false, message: 'Failed to update password' });
            }

            res.json({
                success: true,
                message: 'PIN changed successfully! 🎉'
            });
        });
    });
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

app.get('/users/profiles', requireAuth, (_, res) => {
    db.query('SELECT id, name, profile_pic FROM users ORDER BY id ASC', (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch user profiles' });
        }
        res.json({ success: true, users: results });
    });
});

// ==================== CHAT MESSAGES ====================

// POST /messages - Save a message to the database
app.post('/messages', requireAuth, async (req, res) => {
    const { text } = req.body;
    const sender_id = req.user.userId;

    if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    try {
        const { senderColumn, textColumn } = await resolveMessageSchema();
        const [result] = await dbPromise.query(
            `INSERT INTO messages (${senderColumn}, ${textColumn}) VALUES (?, ?)`,
            [String(sender_id), String(text).trim()]
        );

        res.json({
            success: true,
            message: {
                id: result.insertId,
                sender_id,
                text: String(text).trim(),
                sent_at: new Date()
            }
        });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to save message' });
    }
});

// GET /messages - Fetch all chat history
app.get('/messages', requireAuth, async (req, res) => {
    try {
        const { senderColumn, textColumn, timestampColumn } = await resolveMessageSchema();
        const orderColumn = timestampColumn || 'id';
        const selectTimestamp = timestampColumn ? `${timestampColumn} AS sent_at` : 'NOW() AS sent_at';
        const selectSender = senderColumn === 'sender_id'
            ? 'sender_id'
            : `CAST(${senderColumn} AS UNSIGNED) AS sender_id`;

        const [results] = await dbPromise.query(
            `SELECT id, ${selectSender}, ${textColumn} AS text, ${selectTimestamp}
             FROM messages
             ORDER BY ${orderColumn} ASC`
        );

        res.json({ success: true, messages: results });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch messages' });
    }
});

// ==================== VAULT (FILE UPLOADS) ====================

// POST /vault/upload - Upload image/video to private vault
app.post('/vault/upload', requireAuth, upload.single('media'), (req, res) => {
    const userId = req.user.userId;
    const caption = (req.body.caption || '').toString().trim();

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No media file uploaded' });
    }

    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const filePath = `/uploads/vault/${req.file.filename}`;

    db.query(
        'INSERT INTO vault_items (user_id, media_type, file_path, caption) VALUES (?, ?, ?, ?)',
        [userId, mediaType, filePath, caption],
        (err, result) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ success: false, message: 'Failed to save media item' });
            }

            res.json({
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
        }
    );
});

// GET /vault - Fetch vault media history
app.get('/vault', requireAuth, (_, res) => {
    db.query('SELECT * FROM vault_items ORDER BY created_at DESC', (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch vault items' });
        }

        res.json({ success: true, items: results });
    });
});

// DELETE /vault/:id - Delete own vault item
app.delete('/vault/:id', requireAuth, (req, res) => {
    const itemId = Number(req.params.id);
    const userId = req.user.userId;

    db.query('SELECT * FROM vault_items WHERE id = ? AND user_id = ?', [itemId, userId], (err, rows) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to verify item' });
        }
        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Item not found' });
        }

        const fullPath = path.join(__dirname, rows[0].file_path.replace(/^\//, ''));
        db.query('DELETE FROM vault_items WHERE id = ?', [itemId], (deleteErr) => {
            if (deleteErr) {
                console.error('Database error:', deleteErr);
                return res.status(500).json({ success: false, message: 'Failed to delete item' });
            }

            fs.unlink(fullPath, () => {
                // Ignore file delete errors if file already missing.
            });

            res.json({ success: true });
        });
    });
});

// ==================== DATES ====================

app.get('/dates', requireAuth, (_, res) => {
    db.query('SELECT * FROM special_dates ORDER BY event_date ASC', (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch dates' });
        }
        res.json({ success: true, items: results });
    });
});

app.post('/dates', requireAuth, (req, res) => {
    const userId = req.user.userId;
    const title = (req.body.title || '').toString().trim();
    const eventDate = (req.body.date || '').toString().trim();

    if (!title || !eventDate) {
        return res.status(400).json({ success: false, message: 'title and date are required' });
    }

    db.query(
        'INSERT INTO special_dates (user_id, title, event_date) VALUES (?, ?, ?)',
        [userId, title, eventDate],
        (err, result) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ success: false, message: 'Failed to save date' });
            }
            res.json({
                success: true,
                item: { id: result.insertId, user_id: userId, title, date: eventDate }
            });
        }
    );
});

app.delete('/dates/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user.userId;
    db.query('DELETE FROM special_dates WHERE id = ? AND user_id = ?', [id, userId], (err) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to delete date' });
        }
        res.json({ success: true });
    });
});

// ==================== NUDGES ====================

app.get('/nudges', requireAuth, (_, res) => {
    db.query(
        `SELECT n.id, n.sender_id, n.text, n.created_at, u.name AS sender_name, u.profile_pic AS sender_profile_pic
         FROM nudges n
         JOIN users u ON n.sender_id = u.id
         ORDER BY n.created_at DESC`,
        (err, results) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ success: false, message: 'Failed to fetch nudges' });
            }
            res.json({ success: true, items: results });
        }
    );
});

app.post('/nudges', requireAuth, (req, res) => {
    const senderId = req.user.userId;
    const senderName = req.user.name;
    const text = (req.body.text || '').toString().trim();

    if (!text) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    db.query('INSERT INTO nudges (sender_id, text) VALUES (?, ?)', [senderId, text], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to save nudge' });
        }

        db.query('SELECT profile_pic FROM users WHERE id = ?', [senderId], (profileErr, rows) => {
            if (profileErr) {
                console.error('Database error:', profileErr);
                return res.status(500).json({ success: false, message: 'Failed to fetch sender profile' });
            }

            res.json({
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
        });
    });
});

app.delete('/nudges/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const senderId = req.user.userId;
    db.query('DELETE FROM nudges WHERE id = ? AND sender_id = ?', [id, senderId], (err) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ success: false, message: 'Failed to delete nudge' });
        }
        res.json({ success: true });
    });
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
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`);
            if (RENDER_EXTERNAL_URL) {
                console.log(`🌐 Public URL: ${RENDER_EXTERNAL_URL}`);
            }
            startInternalHeartbeat();
        });
    } catch (error) {
        console.error('❌ Server startup failed:', error.message);
        process.exit(1);
    }
}

startServer();