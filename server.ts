import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database('bacbo.sqlite');

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS dealers (
    id TEXT PRIMARY KEY,
    name TEXT,
    rounds INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    signals INTEGER DEFAULT 0,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    dealer_id TEXT,
    result TEXT,
    side TEXT,
    confidence REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

async function startServer() {
  const app = express();
  app.use(cors());
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());

  // Helper to sync local crawler rounds to Firebase Realtime Database BAC-BOT path
  async function syncToFirebaseRTDB(result: string) {
    try {
      const rtdbUrl = 'https://fermagna-9f211-default-rtdb.firebaseio.com/BAC-BOT.json';
      const response = await fetch(rtdbUrl);
      const char = result === 'PLAYER' ? 'P' : result === 'BANKER' ? 'B' : 'T';
      
      if (!response.ok) {
        await fetch(rtdbUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(char)
        });
        return;
      }
      
      const data = await response.json();
      
      if (data === null || data === "") {
        await fetch(rtdbUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(char)
        });
      } else if (typeof data === 'string') {
        const updatedStr = `${data},${char}`.split(',').slice(-50).join(',');
        await fetch(rtdbUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedStr)
        });
      } else if (Array.isArray(data)) {
        const updatedArray = [...data, result].slice(-50);
        await fetch(rtdbUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedArray)
        });
      } else if (data && typeof data === 'object') {
        if (data.rounds && Array.isArray(data.rounds)) {
          const updatedRounds = [...data.rounds, result].slice(-50);
          await fetch('https://fermagna-9f211-default-rtdb.firebaseio.com/BAC-BOT/rounds.json', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedRounds)
          });
        } else if (data.history && typeof data.history === 'string') {
          const updatedHistory = `${data.history},${char}`.split(',').slice(-50).join(',');
          await fetch('https://fermagna-9f211-default-rtdb.firebaseio.com/BAC-BOT/history.json', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedHistory)
          });
        } else {
          await fetch('https://fermagna-9f211-default-rtdb.firebaseio.com/BAC-BOT.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              result: result,
              timestamp: Date.now()
            })
          });
        }
      }
    } catch (error) {
      console.error('Failed to sync scraper round to Firebase Realtime Database:', error);
    }
  }

  // API Routes
  app.get('/api/dealers', (req, res) => {
    const dealers = db.prepare('SELECT * FROM dealers ORDER BY rounds DESC').all();
    res.json(dealers);
  });

  app.post('/api/round', (req, res) => {
    const { roundId, dealerName, result, signalSide, confidence, isInitial } = req.body;
    
    try {
      // Sync incoming round from scraper to Firebase Realtime Database
      if (result) {
        syncToFirebaseRTDB(result);
      }

      // Upsert dealer
      db.prepare(`
        INSERT INTO dealers (id, name, rounds, wins, signals, last_active)
        VALUES (?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          rounds = rounds + 1,
          wins = wins + ?,
          signals = signals + ?,
          last_active = CURRENT_TIMESTAMP
      `).run(
        dealerName, 
        dealerName, 
        (signalSide === result ? 1 : 0), 
        (signalSide ? 1 : 0),
        (signalSide === result ? 1 : 0),
        (signalSide ? 1 : 0)
      );

      // Record round
      if (roundId) {
        db.prepare(`
          INSERT OR REPLACE INTO rounds (id, dealer_id, result, side, confidence)
          VALUES (?, ?, ?, ?, ?)
        `).run(roundId, dealerName, result, signalSide, confidence);
      }

      // Broadcast to all clients
      const update = {
        type: 'ROUND_UPDATE',
        payload: { roundId, dealerName, result, signalSide, confidence, isInitial }
      };
      
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(update));
        }
      });

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Vite Integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
