require('dotenv').config();
const mysql = require('mysql2');

// Connect using the secrets from your .env file
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('❌ Connection error:', err.message);
        return;
    }
    console.log('✅ Connected to database. Building tables...');

    // SQL to create the Users table
    const createUsersTable = `
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL,
            pin_code VARCHAR(255) NOT NULL,
            profile_pic VARCHAR(255) DEFAULT NULL,
            last_seen_at DATETIME DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    // SQL to create the Messages table
    const createMessagesTable = `
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            sender_id INT NOT NULL,
            text TEXT NOT NULL,
            reply_to_message_id BIGINT DEFAULT NULL,
            seen_at DATETIME DEFAULT NULL,
            deleted_at DATETIME DEFAULT NULL,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users(id)
        )
    `;

    const createVaultTable = `
        CREATE TABLE IF NOT EXISTS vault_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            media_type ENUM('image', 'video') NOT NULL,
            file_path VARCHAR(255) NOT NULL,
            caption VARCHAR(255) DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `;

    const createDatesTable = `
        CREATE TABLE IF NOT EXISTS special_dates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            title VARCHAR(120) NOT NULL,
            event_date DATE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `;

    const createNudgesTable = `
        CREATE TABLE IF NOT EXISTS nudges (
            id INT AUTO_INCREMENT PRIMARY KEY,
            sender_id INT NOT NULL,
            text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users(id)
        )
    `;

    // Execute the commands
    db.query(createUsersTable, (err) => {
        if (err) throw err;
        console.log('✅ "users" table is ready.');

        db.query(createMessagesTable, (err) => {
            if (err) throw err;
            console.log('✅ "messages" table is ready.');

            db.query(createVaultTable, (err) => {
                if (err) throw err;
                console.log('✅ "vault_items" table is ready.');

                db.query(createDatesTable, (err) => {
                    if (err) throw err;
                    console.log('✅ "special_dates" table is ready.');

                    db.query(createNudgesTable, (err) => {
                        if (err) throw err;
                        console.log('✅ "nudges" table is ready.');

                        db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL', (err) => {
                            if (err && err.code !== 'ER_DUP_FIELDNAME') throw err;

                            db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT NULL', (err) => {
                                if (err && err.code !== 'ER_DUP_FIELDNAME') throw err;

                                db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at DATETIME NULL', (err) => {
                                    if (err && err.code !== 'ER_DUP_FIELDNAME') throw err;

                                    db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL', (err) => {
                                        if (err && err.code !== 'ER_DUP_FIELDNAME') throw err;

                                        console.log('✅ Chat presence and receipt columns are ready.');

                                        console.log('🎉 All feature tables are ready! Exiting setup.');
                                        process.exit(); // Closes the script automatically
                                    });
                                });
                            });
                        });
    });
});