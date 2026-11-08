# Lightweight Multi-Session WhatsApp Gateway

A lightweight, memory-efficient multi-session **WhatsApp Gateway REST Service** built with Baileys (`@whiskeysockets/baileys`) and Express. 

Designed specifically to run smoothly on **free/cheap hosting tiers** with constrained RAM (<512 MB) and ephemeral filesystems (such as Oracle Cloud Free Tier, Render, Hostinger, GoDaddy, or Suga).

---

## Architecture & Features

- **Zero Local Disk Dependency**: WhatsApp multi-device authentication credentials and signal cryptographic keys are stored directly in MySQL using `useMySQLAuthState` with `BufferJSON` serialization/deserialization.
- **Write Debouncing & Batching**: Batches updates and key mutations to MySQL with a debounce buffer to prevent connection saturation and high CPU spikes.
- **Auto-Restoration**: On gateway boot or process restarts, automatically restores all active sessions in MySQL with a 2-second staggered delay to protect memory and CPU.
- **Sequential Queuing (Mutex)**: Per-session mutex prevents race conditions or overlapping socket queries by executing sends strictly in sequence.
- **Human-like Presence**: Supports presence typing simulation (`composing` with configurable duration clamped between 1000ms and 15000ms, then `paused`) and `mark_read` chat presence.
- **Media Support**: Downloads media files up to 20MB (30s timeout) and streams buffers directly for image, video, or documents.
- **Webhooks with HMAC-SHA256**: Real-time events (`connection.update` and `message.status`) delivered to the panel with retry backoff and timing verification.
- **Persistent Message Status Mapping**: Maps Baileys ack receipts (`sent`, `delivered`, `read`) back to the panel's custom `client_ref` using the `wa_gw_msgmap` MySQL table.
- **Timing-Safe Authentication**: API key check uses constant-time string buffers (`crypto.timingSafeEqual`) to prevent timing attack vulnerabilities.

---

## Folder Structure

```
wa-getway/
├── .env.example              # Configuration environment template
├── Dockerfile                # Production alpine container with low-memory flag
├── ecosystem.config.js       # PM2 ecosystem configuration with 450M memory limit
├── package.json              # Dependencies and scripts
├── schema.sql                # MySQL table definitions
├── scripts/
│   └── test.js               # CLI test client (health check, start session, save qr.png)
└── src/
    ├── mysqlAuthState.js     # Baileys MySQL auth state store with debounced batching
    ├── server.js             # Express app setup, rate limit, graceful shutdown, boot
    ├── sessionManager.js     # Session lifecycle, sequential mutex queue, sockets
    ├── webhook.js            # Outbound HMAC-SHA256 signed webhook dispatcher
    ├── routes/
    │   ├── authMiddleware.js # Timing-safe X-API-KEY validation
    │   ├── messages.js       # /messages/send route with media & typing presence
    │   ├── numbers.js        # /numbers/check route with onWhatsApp lookup
    │   └── sessions.js       # /sessions/start, /sessions/:session_key/status, /logout
    └── utils/
        ├── db.js             # MySQL2 connection pool & auto-migration
        └── logger.js         # Lightweight Pino logger
```

---

## 1. Local Run & Setup

### Prerequisites
- Node.js 18+ (tested on Node 20 and 22)
- MySQL database (v5.7+ or v8.0+ or MariaDB)

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Update `.env` with your MySQL database credentials and secure random keys:
```env
PORT=3000
API_KEY=your_secure_api_key_here
WEBHOOK_URL=https://your-panel.com/webhook/gateway
WEBHOOK_SECRET=your_webhook_hmac_secret
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=your_password
DB_NAME=wa_gateway
MAX_SESSIONS=20
LOG_LEVEL=info
```

### Step 3: Run Server
Tables (`wa_gw_auth` and `wa_gw_msgmap`) will be **auto-created** on first run:
```bash
npm start
```

### Step 4: Run Test Client
In another terminal, run the test script:
```bash
# Windows
set API_KEY=your_secure_api_key_here && node scripts/test.js

# Linux / macOS
API_KEY="your_secure_api_key_here" node scripts/test.js
```
The test script calls `/health`, starts a test session (`session_demo_1`), and extracts the QR code directly into `qr.png` in the project root.

---

## 2. REST API Documentation

All endpoints except `GET /health` require the `X-API-KEY` header matching `API_KEY`.

### `GET /health`
Keep-alive ping used by monitoring services like UptimeRobot.
- **Request**:
  ```bash
  curl -X GET http://localhost:3000/health
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "uptime": 1284,
    "sessions": 1
  }
  ```

---

### `POST /sessions/start`
Starts a session or retrieves its current QR / status. Waits up to ~10s for the first QR code to be generated.
- **Request**:
  ```bash
  curl -X POST http://localhost:3000/sessions/start \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: your_secure_api_key_here" \
    -d '{"session_key": "marketing_1"}'
  ```
- **Response (when QR code is generated)**:
  ```json
  {
    "ok": true,
    "status": "qr",
    "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  }
  ```
- **Response (when already connected)**:
  ```json
  {
    "ok": true,
    "status": "connected",
    "phone": "6281234567890",
    "name": "Customer Support"
  }
  ```

---

### `GET /sessions/:session_key/status`
Checks live status of a session (`disconnected`, `qr`, `connecting`, or `connected`).
- **Request**:
  ```bash
  curl -X GET http://localhost:3000/sessions/marketing_1/status \
    -H "X-API-KEY: your_secure_api_key_here"
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "status": "connected",
    "phone": "6281234567890",
    "name": "Customer Support"
  }
  ```

---

### `POST /sessions/:session_key/logout`
Logs out the WhatsApp session, terminates the socket, and purges all credentials from MySQL.
- **Request**:
  ```bash
  curl -X POST http://localhost:3000/sessions/marketing_1/logout \
    -H "X-API-KEY: your_secure_api_key_here"
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "status": "logged_out"
  }
  ```

---

### `POST /messages/send`
Sends a message sequentially using the per-session queue mutex. Supports presence typing (`typing_ms`), `mark_read`, and media attachment.
- **Text Message**:
  ```bash
  curl -X POST http://localhost:3000/messages/send \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: your_secure_api_key_here" \
    -d '{
      "session_key": "marketing_1",
      "to": "1234567890",
      "text": "Hello! Your order #1043 is confirmed.",
      "typing_ms": 2000,
      "mark_read": true,
      "client_ref": "order_msg_1043"
    }'
  ```
- **Media Message (Image/Video/Document)**:
  ```bash
  curl -X POST http://localhost:3000/messages/send \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: your_secure_api_key_here" \
    -d '{
      "session_key": "marketing_1",
      "to": "1234567890",
      "media_url": "https://example.com/invoice-1043.pdf",
      "media_type": "document",
      "file_name": "invoice-1043.pdf",
      "text": "Here is your invoice receipt.",
      "typing_ms": 2500,
      "client_ref": "inv_1043"
    }'
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "message_id": "BAE59183491E23F"
  }
  ```

---

### `POST /numbers/check`
Validates whether up to 50 phone numbers are registered on WhatsApp using `onWhatsApp`.
- **Request**:
  ```bash
  curl -X POST http://localhost:3000/numbers/check \
    -H "Content-Type: application/json" \
    -H "X-API-KEY: your_secure_api_key_here" \
    -d '{
      "session_key": "marketing_1",
      "numbers": ["1234567890", "9876543210"]
    }'
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "results": [
      {
        "number": "1234567890",
        "exists": true,
        "jid": "1234567890@s.whatsapp.net"
      },
      {
        "number": "9876543210",
        "exists": false
      }
    ]
  }
  ```

---

## 3. Webhooks (Gateway -> PHP SaaS Panel)

When session connection updates occur or message delivery receipts change, the gateway dispatches a `POST` request to `WEBHOOK_URL` with headers:
- `Content-Type: application/json`
- `X-Signature: <hex HMAC-SHA256(rawBody, WEBHOOK_SECRET)>`
- `X-Timestamp: <unix_seconds>`

### Events Dispatched:
1. **Connection Update**:
   ```json
   {
     "event": "connection.update",
     "session_key": "marketing_1",
     "status": "connected",
     "phone": "6281234567890",
     "name": "Customer Support"
   }
   ```
2. **Message Status Update**:
   ```json
   {
     "event": "message.status",
     "session_key": "marketing_1",
     "message_id": "BAE59183491E23F",
     "client_ref": "order_msg_1043",
     "status": "delivered"
   }
   ```
   *(Status values: `sent`, `delivered`, `read`, or `failed`)*

---

## 4. Connecting to PHP (CodeIgniter) SaaS Panel

### In Panel Settings:
1. **Gateway Base URL**: `https://gateway.yourdomain.com`
2. **API Key**: Value matching `API_KEY` in gateway `.env`.
3. **Webhook Secret**: Value matching `WEBHOOK_SECRET` in gateway `.env`.
4. **Gateway Webhook Target URL**: `https://your-panel.com/webhook/gateway`

### CodeIgniter Controller Webhook Verification Example:
```php
<?php
namespace App\Controllers;
use CodeIgniter\RESTful\ResourceController;

class Webhook extends ResourceController
{
    public function gateway()
    {
        $rawPayload = $this->request->getBody();
        $signature  = $this->request->getHeaderLine('X-Signature');
        $timestamp  = $this->request->getHeaderLine('X-Timestamp');
        $secret     = getenv('WEBHOOK_SECRET');

        // Verify HMAC-SHA256
        $expectedSignature = hash_hmac('sha256', $rawPayload, $secret);
        if (!hash_equals($expectedSignature, $signature)) {
            return $this->failUnauthorized('Invalid HMAC signature');
        }

        $data = json_decode($rawPayload, true);
        if ($data['event'] === 'message.status') {
            // Update message status in CodeIgniter database
            // $data['client_ref'], $data['status'], $data['message_id']
        } elseif ($data['event'] === 'connection.update') {
            // Update device status: $data['session_key'], $data['status'], $data['phone']
        }

        return $this->respond(['ok' => true]);
    }
}
```

---

## 5. Deployment Guides

### A. Oracle Cloud Always Free VM (Ubuntu / Ampere ARM or AMD)
Oracle Cloud Always Free provides VMs with 1-4 cores and free public IPs.

1. **Install Node.js 20 & PM2**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
   sudo npm install -g pm2
   ```

2. **Clone & Setup App**:
   ```bash
   sudo mkdir -p /var/www/wa-gateway
   sudo chown -R $USER:$USER /var/www/wa-gateway
   cd /var/www/wa-gateway
   # Copy files or git clone here
   npm ci --omit=dev
   cp .env.example .env
   nano .env # configure your DB and keys
   ```

3. **Start with PM2 (Memory-guarded at 450 MB)**:
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

4. **Nginx Reverse Proxy Configuration**:
   Create `/etc/nginx/sites-available/wa-gateway`:
   ```nginx
   server {
       server_name gateway.yourdomain.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 60s;
           proxy_send_timeout 60s;
       }
   }
   ```
   Enable site and obtain free SSL certificate with Let's Encrypt / Certbot:
   ```bash
   sudo ln -s /etc/nginx/sites-available/wa-gateway /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d gateway.yourdomain.com
   ```

---

### B. Generic Free Node.js Hosts (Render / Hostinger / GoDaddy Node / Suga)
Many free hosting platforms run on containers with ephemeral disks and sleep after inactivity.

1. **Database Setup**:
   - Because disks are ephemeral on free containers, use a free cloud MySQL (e.g., Aiven, PlanetScale, FreeSQLDatabase, or your existing cPanel MySQL).
   - Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` in the host's Environment Variables dashboard.

2. **Deploy via Git**:
   - Build Command: `npm install`
   - Start Command: `node --max-old-space-size=400 src/server.js`

3. **Prevent Sleep via UptimeRobot Keep-Alive Tip**:
   - Free tiers (such as Render Free Web Service) enter idle sleep after 15 minutes of inactivity.
   - Go to [UptimeRobot.com](https://uptimerobot.com) (free account).
   - Create an **HTTP(s)** monitor:
     - URL: `https://your-service-name.onrender.com/health`
     - Monitoring Interval: Every **5 minutes**.
   - Because `GET /health` is public and lightweight, it executes in <5ms, keeping the gateway active without waking unneeded socket cycles.

---

## 6. Reliability & Memory Management Guarantees

1. **Memory Ceiling (<512 MB)**:
   - Node flag `--max-old-space-size=400` restricts heap usage.
   - PM2 config includes `max_memory_restart: '450M'`.
   - Baileys option `syncFullHistory: false` ensures months of chat history are discarded upon session connection.
   - Baileys option `markOnlineOnConnect: false` avoids unnecessary background sync traffic.
2. **Ephemeral Disk Safe**:
   - Every credential (`creds.json`) and pre-key/signal key is written to the remote MySQL database in table `wa_gw_auth`. If the container restarts or migrates to a different physical host, sessions resume transparently.
3. **Database Write Debouncing**:
   - Memory buffer aggregates socket key changes and updates MySQL in batches every 500ms, minimizing database connection spikes.
4. **Reconnection Logic**:
   - Recovers from WhatsApp disconnection code `515` (`restartRequired`) and standard network disconnects with exponential backoff up to 60s.
   - Explicit user logout cleanly purges database rows and frees memory.
5. **Sequential Message Sending**:
   - A promise-based FIFO mutex on each session ensures sending messages sequentially, preventing out-of-order deliveries and spam detection.
