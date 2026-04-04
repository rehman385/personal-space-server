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
    console.log('✅ Connected to database. Adding test data...');

    // Insert test users (if they don't already exist)
    const insertUsers = `
        INSERT IGNORE INTO users (id, name, pin_code) VALUES
        (1, 'Shafique', '1234'),
        (2, 'Maria', '5678')
    `;

    db.query(insertUsers, (err) => {
        if (err) {
            console.error('Error inserting users:', err);
        } else {
            console.log('✅ Test users added/verified.');
        }

        // Insert a sample message
        const insertMessage = `
            INSERT INTO messages (sender_id, text) VALUES
            (2, 'Hi Shafique! I miss you ❤️')
        `;

        db.query(insertMessage, (err) => {
            if (err) {
                console.error('Error inserting message:', err);
            } else {
                console.log('✅ Sample message added.');
            }
            
            console.log('🎉 Database seeded successfully! Exiting...');
            db.end();
            process.exit();
        });
    });
});
