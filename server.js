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
const EVENTS_DIR = path.join(__dirname, 'events');
const SESSIONS_PATH = path.join(__dirname, 'game_sessions.json');

// Ensure events directory exists
if (!fs.existsSync(EVENTS_DIR)) {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

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

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading sessions:', err);
  }
  return [];
}

function recordGameSession(sessionData) {
  try {
    const list = loadSessions();
    list.unshift(sessionData); // newest first
    // keep last 50 games
    const trimmed = list.slice(0, 50);
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('Error recording session:', err);
  }
}

// REST Endpoints
app.get('/api/ping', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.post('/api/config', (req, res) => {
  const updatedConfig = req.body;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2), 'utf8');

  // Sync to matching event preset file if one exists
  try {
    const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.json'));
    files.forEach(filename => {
      const filePath = path.join(EVENTS_DIR, filename);
      const ev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (ev.name === updatedConfig.eventName || (ev.config && ev.config.eventName === updatedConfig.eventName)) {
        ev.config = { ...ev.config, ...updatedConfig };
        fs.writeFileSync(filePath, JSON.stringify(ev, null, 2), 'utf8');
      }
    });
  } catch (err) {
    console.error('Error syncing config to preset:', err);
  }

  // Broadcast updated config to all active rooms
  rooms.forEach(room => {
    room.broadcast({ type: 'CONFIG_UPDATED', config: updatedConfig });
  });

  res.json({ success: true, config: updatedConfig });
});

app.get('/api/questions', (req, res) => res.json(loadQuestions()));
app.post('/api/questions', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Questions must be an array" });
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ success: true, count: req.body.length });
});

// --- MULTI-CLIENT EVENT LIBRARY API ---
app.get('/api/events', (req, res) => {
  try {
    const liveConfig = loadConfig();
    const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.json'));
    const events = files.map(filename => {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, filename), 'utf8'));
        const isCurrent = (liveConfig.eventName === (content.name || content.config?.eventName));
        const isGameActive = isCurrent ? (liveConfig.isGameActive !== false) : (content.config?.isGameActive !== false);
        return {
          id: filename.replace('.json', ''),
          name: content.name || content.config?.eventName || 'Untitled Event',
          client: content.client || '',
          date: content.date || '',
          theme: content.theme || content.config?.theme || 'theme-sky-blue',
          logoUrl: content.config?.logoUrl || content.logoUrl || '/assets/logo.jpg',
          questionCount: Array.isArray(content.questions) ? content.questions.length : 0,
          isGameActive,
          isCurrent,
          updatedAt: content.updatedAt || ''
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list events' });
  }
});

// Toggle ON/OFF for an event preset
app.post('/api/events/toggle/:id', (req, res) => {
  try {
    const eventFile = path.join(EVENTS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(eventFile)) return res.status(404).json({ error: 'Event not found' });

    const eventData = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
    if (!eventData.config) eventData.config = {};

    const currentlyActive = eventData.config.isGameActive !== false;
    const newStatus = !currentlyActive;
    eventData.config.isGameActive = newStatus;
    fs.writeFileSync(eventFile, JSON.stringify(eventData, null, 2), 'utf8');

    // If this preset is the currently active live game, also update the live config & kick players if turned off
    const liveConfig = loadConfig();
    if (liveConfig.eventName === eventData.name || liveConfig.eventName === eventData.config.eventName) {
      liveConfig.isGameActive = newStatus;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(liveConfig, null, 2), 'utf8');

      if (!newStatus) {
        // Lock out currently connected players immediately
        rooms.forEach(room => {
          room.broadcast({
            type: 'GAME_LOCKED',
            message: 'This event is currently closed by the organizer. Thank you for playing!'
          });
        });
      }
    }

    res.json({ success: true, isGameActive: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle event' });
  }
});

// Save an event preset into the library
app.post('/api/events/save', (req, res) => {
  try {
    const { id, name, client, date, theme } = req.body;
    const cleanId = (id || name || 'event').toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 50);
    const eventFile = path.join(EVENTS_DIR, `${cleanId}.json`);

    const currentConfig = loadConfig();
    const currentQuestions = loadQuestions();

    const eventData = {
      id: cleanId,
      name: name || currentConfig.eventName || 'Untitled Event',
      client: client || '',
      date: date || new Date().toISOString().split('T')[0],
      theme: theme || 'theme-sky-blue',
      config: currentConfig,
      questions: currentQuestions,
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(eventFile, JSON.stringify(eventData, null, 2), 'utf8');
    res.json({ success: true, event: eventData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save event preset' });
  }
});

// Save complete custom event preset
app.post('/api/events/save-custom', (req, res) => {
  try {
    const { id, name, client, date, theme, config, questions } = req.body;
    const cleanId = (id || name || 'event').toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 50);
    const eventFile = path.join(EVENTS_DIR, `${cleanId}.json`);

    const eventData = {
      id: cleanId,
      name: name || 'Untitled Event',
      client: client || '',
      date: date || new Date().toISOString().split('T')[0],
      theme: theme || 'theme-sky-blue',
      config: config || loadConfig(),
      questions: Array.isArray(questions) ? questions : loadQuestions(),
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(eventFile, JSON.stringify(eventData, null, 2), 'utf8');
    res.json({ success: true, event: eventData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save custom event' });
  }
});

// Activate an event preset as the LIVE active game
app.post('/api/events/activate/:id', (req, res) => {
  try {
    const eventFile = path.join(EVENTS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(eventFile)) {
      return res.status(404).json({ error: 'Event preset not found' });
    }

    const eventData = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
    if (eventData.config) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(eventData.config, null, 2), 'utf8');
    }
    if (eventData.questions && Array.isArray(eventData.questions)) {
      fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(eventData.questions, null, 2), 'utf8');
    }

    // Reset room state so fresh active event is ready
    rooms.forEach(room => {
      room.questions = loadQuestions();
      room.currentQIndex = -1;
      room.state = 'LOBBY';
      room.players.clear();
      room.broadcast({ type: 'ROOM_RESET', players: [] });
    });

    res.json({ success: true, message: `Activated "${eventData.name}" as live game!`, event: eventData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to activate event' });
  }
});

// Get a specific event preset
app.get('/api/events/:id', (req, res) => {
  try {
    const eventFile = path.join(EVENTS_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(eventFile)) return res.status(404).json({ error: 'Event not found' });
    const content = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
    res.json(content);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read event' });
  }
});

// Delete an event preset from library
app.delete('/api/events/:id', (req, res) => {
  try {
    const eventFile = path.join(EVENTS_DIR, `${req.params.id}.json`);
    if (fs.existsSync(eventFile)) {
      fs.unlinkSync(eventFile);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// --- GAME SESSIONS HISTORY API ---
app.get('/api/sessions', (req, res) => {
  res.json(loadSessions());
});

app.delete('/api/sessions', (req, res) => {
  try {
    fs.writeFileSync(SESSIONS_PATH, '[]', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear session history' });
  }
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
    if (index === 0) {
      this.gameStartTime = Date.now();
    }
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

    const allPlayersSorted = Array.from(this.players.values())
      .sort((a, b) => b.score - a.score)
      .map((p, idx) => ({
        rank: idx + 1,
        nickname: p.nickname,
        score: p.score
      }));

    const podium = allPlayersSorted.slice(0, 3);

    this.broadcast({
      type: 'PODIUM',
      podium
    });

    // Automatically record completed game session
    try {
      const cfg = loadConfig();
      const endTime = Date.now();
      const startTime = this.gameStartTime || (endTime - (this.questions.length * 25 * 1000));
      const durationSeconds = Math.max(1, Math.round((endTime - startTime) / 1000));
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;

      recordGameSession({
        id: `game_${Date.now()}`,
        eventName: cfg.eventName || 'Trivia Game',
        pin: this.pin,
        playedAt: new Date().toISOString(),
        duration: `${minutes}m ${seconds}s`,
        totalPlayers: this.players.size,
        totalQuestions: this.questions.length,
        winners: podium,
        fullLeaderboard: allPlayersSorted.slice(0, 10)
      });
    } catch (e) {
      console.error('Error logging game session:', e);
    }
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
        const cfg = loadConfig();
        if (cfg.isGameActive === false) {
          ws.send(JSON.stringify({
            type: 'GAME_LOCKED',
            message: "This event is currently closed. Please check back during scheduled event hours!"
          }));
          return;
        }

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
