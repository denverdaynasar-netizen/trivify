const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const QUESTIONS_PATH = path.join(__dirname, 'questions.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper to load/save config & questions
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return {
      eventName: "B & S Wedding Trivia",
      subtitle: "How well do you know the newlyweds?",
      logoUrl: "/assets/logo.jpg",
      primaryColor: "#d4af37",
      accentColor: "#f3e5ab"
    };
  }
}

function loadQuestions() {
  try {
    return JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

// REST Endpoints
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.post('/api/config', (req, res) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ success: true, config: req.body });
});

app.get('/api/questions', (req, res) => res.json(loadQuestions()));
app.post('/api/questions', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Questions must be an array" });
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ success: true, count: req.body.length });
});

const os = require('os');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Store optional public tunnel URL
let publicTunnelUrl = 'https://plenty-loan-compressed-poet.trycloudflare.com';

app.get('/api/network-info', (req, res) => {
  const localIp = getLocalIp();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const dynamicOrigin = `${proto}://${host}`;

  const isCloudHost = host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('192.168.');
  const publicUrl = isCloudHost ? `${dynamicOrigin}/play` : (publicTunnelUrl ? `${publicTunnelUrl}/play` : `http://${localIp}:${PORT}/play`);

  res.json({
    localIp,
    localUrl: `http://${localIp}:${PORT}/play`,
    publicUrl
  });
});

app.get('/api/qrcode', async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const dynamicOrigin = `${proto}://${host}`;
  const isCloudHost = host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('192.168.');
  const defaultTarget = isCloudHost ? `${dynamicOrigin}/play` : (publicTunnelUrl ? `${publicTunnelUrl}/play` : `http://${getLocalIp()}:${PORT}/play`);

  const text = req.query.text || defaultTarget;
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      margin: 1,
      width: 320,
      color: { dark: '#1a1a24', light: '#ffffff' }
    });
    res.json({ dataUrl, targetUrl: text });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Clean friendly page routes
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- GAME STATE MANAGEMENT ---
class QuizRoom {
  constructor(pin) {
    this.pin = pin;
    this.hostWs = null;
    this.players = new Map(); // id -> { id, nickname, score, streak, lastAnswer, answeredAt, ws }
    this.state = 'LOBBY'; // LOBBY, QUESTION, REVEAL, LEADERBOARD, PODIUM
    this.currentQIndex = -1;
    this.questions = loadQuestions();
    this.timer = null;
    this.timeLeft = 0;
    this.qStartTime = 0;
  }

  broadcast(msg, excludeWs = null) {
    const data = JSON.stringify(msg);
    this.players.forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN && p.ws !== excludeWs) {
        p.ws.send(data);
      }
    });
    if (this.hostWs && this.hostWs.readyState === WebSocket.OPEN && this.hostWs !== excludeWs) {
      this.hostWs.send(data);
    }
  }

  sendToHost(msg) {
    if (this.hostWs && this.hostWs.readyState === WebSocket.OPEN) {
      this.hostWs.send(JSON.stringify(msg));
    }
  }

  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score
    }));
  }

  startQuestion(index) {
    this.questions = loadQuestions(); // reload in case edited
    if (index >= this.questions.length) {
      this.showPodium();
      return;
    }

    clearInterval(this.timer);
    this.currentQIndex = index;
    this.state = 'QUESTION';
    const q = this.questions[index];
    this.timeLeft = q.timeLimit || 20;
    this.qStartTime = Date.now();

    // Reset round answers
    this.players.forEach(p => {
      p.lastAnswer = null;
      p.answeredAt = null;
    });

    // Notify host with question and options
    this.sendToHost({
      type: 'QUESTION_START_HOST',
      question: q,
      index: index + 1,
      total: this.questions.length,
      timeLeft: this.timeLeft,
      answeredCount: 0,
      totalPlayers: this.players.size
    });

    // Notify players (do NOT send correctIndex to players!)
    const playerData = JSON.stringify({
      type: 'QUESTION_START_PLAYER',
      index: index + 1,
      total: this.questions.length,
      question: q.question,
      options: q.options,
      timeLeft: this.timeLeft
    });

    this.players.forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(playerData);
      }
    });

    // Countdown interval
    this.timer = setInterval(() => {
      this.timeLeft--;
      this.broadcast({ type: 'TIMER_TICK', timeLeft: this.timeLeft });

      if (this.timeLeft <= 0) {
        clearInterval(this.timer);
        this.revealAnswer();
      }
    }, 1000);
  }

  handlePlayerAnswer(playerId, answerIndex) {
    if (this.state !== 'QUESTION') return;
    const player = this.players.get(playerId);
    if (!player || player.lastAnswer !== null) return;

    player.lastAnswer = answerIndex;
    player.answeredAt = Date.now();

    const q = this.questions[this.currentQIndex];
    const isCorrect = (answerIndex === q.correctIndex);

    if (isCorrect) {
      const timeTakenSec = (player.answeredAt - this.qStartTime) / 1000;
      const ratio = Math.max(0, 1 - (timeTakenSec / q.timeLimit));
      // Kahoot-style scoring: 500 base + up to 500 for speed
      const points = Math.round(500 + (500 * ratio));
      player.score += points;
      player.streak = (player.streak || 0) + 1;
      player.lastPointsEarned = points;
    } else {
      player.streak = 0;
      player.lastPointsEarned = 0;
    }

    // Check how many players answered
    let answeredCount = 0;
    this.players.forEach(p => { if (p.lastAnswer !== null) answeredCount++; });

    this.sendToHost({
      type: 'ANSWER_UPDATE',
      answeredCount,
      totalPlayers: this.players.size
    });

    // If everyone answered, finish early
    if (answeredCount >= this.players.size && this.players.size > 0) {
      clearInterval(this.timer);
      this.revealAnswer();
    }
  }

  revealAnswer() {
    this.state = 'REVEAL';
    clearInterval(this.timer);

    const q = this.questions[this.currentQIndex];
    const distribution = [0, 0, 0, 0];

    this.players.forEach(p => {
      if (p.lastAnswer !== null && p.lastAnswer >= 0 && p.lastAnswer < 4) {
        distribution[p.lastAnswer]++;
      }
    });

    // Calculate ranks
    const sorted = Array.from(this.players.values()).sort((a, b) => b.score - a.score);
    sorted.forEach((p, idx) => { p.rank = idx + 1; });

    // Send host full answer statistics
    this.sendToHost({
      type: 'REVEAL_HOST',
      correctIndex: q.correctIndex,
      distribution,
      explanation: q.explanation || null
    });

    // Send individual results to players
    this.players.forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        const isCorrect = (p.lastAnswer === q.correctIndex);
        p.ws.send(JSON.stringify({
          type: 'REVEAL_PLAYER',
          isCorrect,
          correctIndex: q.correctIndex,
          pointsEarned: p.lastPointsEarned || 0,
          totalScore: p.score,
          rank: p.rank,
          streak: p.streak
        }));
      }
    });
  }

  showLeaderboard() {
    this.state = 'LEADERBOARD';
    const sorted = Array.from(this.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((p, idx) => ({
        rank: idx + 1,
        nickname: p.nickname,
        score: p.score,
        streak: p.streak
      }));

    this.broadcast({
      type: 'LEADERBOARD',
      topPlayers: sorted,
      isLastQuestion: (this.currentQIndex >= this.questions.length - 1)
    });
  }

  showPodium() {
    this.state = 'PODIUM';
    clearInterval(this.timer);

    const podium = Array.from(this.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((p, idx) => ({
        rank: idx + 1,
        nickname: p.nickname,
        score: p.score
      }));

    this.broadcast({
      type: 'PODIUM',
      podium
    });
  }
}

// Global rooms store
const rooms = new Map();

function getOrCreateRoom(pin = "WEDDING") {
  const cleanPin = String(pin).toUpperCase().trim();
  if (!rooms.has(cleanPin)) {
    rooms.set(cleanPin, new QuizRoom(cleanPin));
  }
  return rooms.get(cleanPin);
}

// Default room for easy single-event operation
getOrCreateRoom("WEDDING");

// WebSocket Connection handling
wss.on('connection', (ws) => {
  let boundPlayerId = null;
  let boundPin = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // --- HOST ACTIONS ---
      if (data.type === 'HOST_INIT') {
        const pin = (data.pin || "WEDDING").toUpperCase().trim();
        boundPin = pin;
        const room = getOrCreateRoom(pin);
        room.hostWs = ws;
        ws.send(JSON.stringify({
          type: 'HOST_CONNECTED',
          pin: room.pin,
          state: room.state,
          players: room.getPlayerList(),
          config: loadConfig()
        }));
      }

      // --- PING HEARTBEAT ---
      else if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }

      // --- HOST ACTIONS ---
      else if (data.type === 'HOST_INIT') {
        const pin = (data.pin || "WEDDING").toUpperCase().trim();
        boundPin = pin;
        const room = getOrCreateRoom(pin);
        room.hostWs = ws;
        ws.send(JSON.stringify({
          type: 'HOST_CONNECTED',
          pin: room.pin,
          state: room.state,
          players: room.getPlayerList(),
          config: loadConfig()
        }));
      }

      else if (data.type === 'HOST_START_GAME') {
        const room = getOrCreateRoom(boundPin || data.pin || "WEDDING");
        room.startQuestion(0);
      }

      else if (data.type === 'HOST_NEXT_QUESTION') {
        const room = getOrCreateRoom(boundPin || data.pin || "WEDDING");
        if (room.state === 'REVEAL') {
          room.showLeaderboard();
        } else if (room.state === 'LEADERBOARD') {
          room.startQuestion(room.currentQIndex + 1);
        }
      }

      else if (data.type === 'HOST_SKIP_TO_LEADERBOARD') {
        const room = getOrCreateRoom(boundPin || data.pin || "WEDDING");
        room.showLeaderboard();
      }

      else if (data.type === 'HOST_RESET') {
        const room = getOrCreateRoom(boundPin || data.pin || "WEDDING");
        room.state = 'LOBBY';
        room.currentQIndex = -1;
        room.players.clear(); // Clear all players for a fresh start
        room.broadcast({
          type: 'ROOM_RESET',
          players: []
        });
      }

      else if (data.type === 'HOST_KICK_PLAYER') {
        const room = getOrCreateRoom(boundPin || data.pin || "WEDDING");
        if (room.players.has(data.playerId)) {
          const kickedPlayer = room.players.get(data.playerId);
          if (kickedPlayer.ws && kickedPlayer.ws.readyState === WebSocket.OPEN) {
            kickedPlayer.ws.send(JSON.stringify({ type: 'PLAYER_KICKED' }));
          }
          room.players.delete(data.playerId);
          room.sendToHost({
            type: 'ROOM_UPDATE',
            totalPlayers: room.players.size,
            players: room.getPlayerList()
          });
        }
      }

      // --- PLAYER ACTIONS ---
      else if (data.type === 'PLAYER_JOIN') {
        const pin = (data.pin || "WEDDING").toUpperCase().trim();
        const room = getOrCreateRoom(pin);
        boundPin = pin;
        const nickname = (data.nickname || 'Guest').substring(0, 20);
        let playerId = data.playerId;

        let playerObj = null;
        // Check if player is reconnecting with existing ID or same nickname
        if (playerId && room.players.has(playerId)) {
          playerObj = room.players.get(playerId);
          playerObj.ws = ws;
          playerObj.connected = true;
        } else {
          // Check if nickname already exists in room
          for (const [id, p] of room.players.entries()) {
            if (p.nickname.toLowerCase() === nickname.toLowerCase()) {
              playerObj = p;
              playerId = id;
              playerObj.ws = ws;
              playerObj.connected = true;
              break;
            }
          }
        }

        if (!playerObj) {
          playerId = 'p_' + Math.random().toString(36).substring(2, 9);
          playerObj = {
            id: playerId,
            nickname,
            score: 0,
            streak: 0,
            lastAnswer: null,
            answeredAt: null,
            connected: true,
            ws
          };
          room.players.set(playerId, playerObj);
        }

        boundPlayerId = playerId;

        ws.send(JSON.stringify({
          type: 'JOIN_SUCCESS',
          playerId,
          nickname: playerObj.nickname,
          roomState: room.state,
          score: playerObj.score,
          config: loadConfig()
        }));

        // If game is in progress, immediately catch up the player
        if (room.state === 'QUESTION' && room.currentQIndex >= 0) {
          const q = room.questions[room.currentQIndex];
          ws.send(JSON.stringify({
            type: 'QUESTION_START_PLAYER',
            index: room.currentQIndex + 1,
            total: room.questions.length,
            question: q.question,
            options: q.options,
            timeLeft: room.timeLeft,
            alreadyAnswered: (playerObj.lastAnswer !== null)
          }));
        } else if (room.state === 'REVEAL' && room.currentQIndex >= 0) {
          const q = room.questions[room.currentQIndex];
          const isCorrect = (playerObj.lastAnswer === q.correctIndex);
          ws.send(JSON.stringify({
            type: 'REVEAL_PLAYER',
            isCorrect,
            correctIndex: q.correctIndex,
            pointsEarned: playerObj.lastPointsEarned || 0,
            totalScore: playerObj.score,
            rank: playerObj.rank || 1,
            streak: playerObj.streak || 0
          }));
        }

        // Notify host
        room.sendToHost({
          type: 'PLAYER_JOINED',
          player: { id: playerId, nickname: playerObj.nickname, score: playerObj.score },
          totalPlayers: room.players.size,
          players: room.getPlayerList()
        });
      }

      else if (data.type === 'PLAYER_ANSWER') {
        const room = getOrCreateRoom(boundPin || data.pin || "WEDDING");
        if (boundPlayerId) {
          room.handlePlayerAnswer(boundPlayerId, data.answerIndex);
        }
      }

    } catch (err) {
      console.error('WS Error:', err);
    }
  });

  ws.on('close', () => {
    if (boundPin && rooms.has(boundPin)) {
      const room = rooms.get(boundPin);
      if (room.hostWs === ws) {
        room.hostWs = null;
      }
      if (boundPlayerId && room.players.has(boundPlayerId)) {
        const p = room.players.get(boundPlayerId);
        if (p) {
          p.connected = false;
          p.ws = null;
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`⚡ TRIVIFY Live Trivia Platform running on port ${PORT}`);
  console.log(`👉 Host Big-Screen:   http://localhost:${PORT}/host`);
  console.log(`📱 Player Controller: http://localhost:${PORT}/play`);
  console.log(`🎨 Trivify Studio:    http://localhost:${PORT}/admin`);
  console.log(`======================================================\n`);
});
