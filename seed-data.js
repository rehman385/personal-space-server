require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL_ENABLED === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    console.log('✅ Connected to database. Adding test data...');

    await db.query(`
      INSERT IGNORE INTO users (id, name, pin_code) VALUES
      (1, 'Shafique', '1234'),
      (2, 'Maria', '5678'),
      (30001, 'Mishamina', '4321')
    `);
    console.log('✅ Test users added/verified.');

    const [messageColumns] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'`
    );
    const columns = new Set(messageColumns.map((row) => row.COLUMN_NAME));
    const senderColumn = columns.has('sender_id') ? 'sender_id' : (columns.has('sender') ? 'sender' : null);
    const textColumn = columns.has('text') ? 'text' : (columns.has('message') ? 'message' : null);

    if (!senderColumn || !textColumn) {
      throw new Error('messages table is missing the expected sender/text columns');
    }

    await db.query(
      `INSERT INTO messages (${senderColumn}, ${textColumn}) VALUES (?, ?)`,
      ['2', 'Hi Shafique! I miss you ❤️']
    );
    console.log('✅ Sample message added.');

    console.log('🎉 Database seeded successfully! Exiting...');
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
