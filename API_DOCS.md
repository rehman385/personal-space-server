# Personal Space API Documentation

## Base URL
```
http://YOUR_LOCAL_IP:3000
```

---

## 🔐 Authentication

### POST `/login`
Authenticate user with PIN code.

**Request:**
```json
{
  "pin_code": "1234"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "name": "Shafique",
    "pin_code": "1234"
  }
}
```

**Response (Failure - 401):**
```json
{
  "success": false,
  "message": "Invalid PIN"
}
```

**Test:**
```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"pin_code":"1234"}'
```

---

## 💬 Messages (Chat)

### POST `/messages`
Save a new message to the database.

**Request:**
```json
{
  "sender_id": 1,
  "text": "Hi Maria! I miss you ❤️"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": {
    "id": 5,
    "sender_id": 1,
    "text": "Hi Maria! I miss you ❤️",
    "sent_at": "2026-04-04T10:30:00.000Z"
  }
}
```

**Test:**
```bash
curl -X POST http://localhost:3000/messages \
  -H "Content-Type: application/json" \
  -d '{
    "sender_id": 1,
    "text": "Hello from Shafique!"
  }'
```

---

### GET `/messages`
Fetch all messages (chat history).

**Response (Success - 200):**
```json
{
  "success": true,
  "messages": [
    {
      "id": 1,
      "sender_id": 2,
      "text": "Hi Shafique! I miss you ❤️",
      "sent_at": "2026-04-03T15:22:00.000Z"
    },
    {
      "id": 2,
      "sender_id": 1,
      "text": "Miss you too! 💕",
      "sent_at": "2026-04-03T15:23:00.000Z"
    }
  ]
}
```

**Test:**
```bash
curl http://localhost:3000/messages
```

---

## 🏞️ Vault (File Upload)

### POST `/vault/upload`
Upload a photo to the vault.

**Request:**
- Content-Type: `multipart/form-data`
- Fields:
  - `photo` (file): Image file
  - `user_id` (number): User who uploaded

**Response (Success - 200):**
```json
{
  "success": true,
  "photo": {
    "id": 1,
    "file_path": "/vault/1680520200000-memory.jpg",
    "uploaded_at": "2026-04-04T10:30:00.000Z"
  }
}
```

**Test (using curl):**
```bash
curl -X POST http://localhost:3000/vault/upload \
  -F "photo=@/path/to/image.jpg" \
  -F "user_id=1"
```

---

## 📊 Database Schema

### `users` Table
```sql
id (INT, Primary Key)
name (VARCHAR 50)
pin_code (VARCHAR 10)
created_at (TIMESTAMP)
```

**Sample Data:**
```
id | name     | pin_code | created_at
1  | Shafique | 1234     | [timestamp]
2  | Maria    | 5678     | [timestamp]
```

### `messages` Table
```sql
id (INT, Primary Key)
sender_id (INT, Foreign Key → users.id)
text (TEXT)
sent_at (TIMESTAMP)
```

### `vault_photos` Table (for future use)
```sql
id (INT, Primary Key)
user_id (INT, Foreign Key → users.id)
file_name (VARCHAR 255)
file_path (VARCHAR 255)
uploaded_at (TIMESTAMP)
```

---

## 🧪 Testing Checklist

- [ ] Backend is running: `node server.js`
- [ ] Database is connected: `✅ Successfully connected...` message appears
- [ ] Test login with PIN "1234": Should return Shafique's data
- [ ] Test login with wrong PIN "9999": Should return error
- [ ] Test sending a message: Check database for new record
- [ ] Test fetching messages: Should return all messages in order
- [ ] Frontend connects to backend: Phone shows successful login

---

## 🐛 Error Codes

| Code | Message | Solution |
|------|---------|----------|
| 400 | Missing required fields | Check request body |
| 401 | Invalid PIN | Try correct PIN (1234 or 5678) |
| 500 | Server error | Check backend logs |
| ECONNREFUSED | Can't reach backend | Verify IP, port 3000, WiFi |

---

## 📝 Notes

- All timestamps are in UTC
- PIN codes are stored as strings for flexibility
- Messages include sender_id (1=Shafique, 2=Maria)
- Use timeZone formatting for local display
- File uploads require multer (install separately)

---

## 🔄 Future Endpoints (Socket.io)

When implementing real-time chat:

```javascript
socket.on('message:send', (data) => {
  // emit to other user
});

socket.on('typing', (data) => {
  // show typing indicator
});

socket.on('online', (data) => {
  // show online status
});
```

---

Generated: April 4, 2026  
Last Updated: When you complete the setup guide 🚀
