// Web Audio API Synthesizer for Kahoot-style Trivia Sound FX & Music
// 100% Free, Zero Dependencies, Zero Audio Files to buffer or fail!

class TriviaAudio {
  constructor() {
    this.ctx = null;
    this.isMuted = false;
    this.currentTrack = null;
    this.volumeNode = null;
    this.masterGain = 0.6;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
      this.volumeNode = this.ctx.createGain();
      this.volumeNode.gain.value = this.isMuted ? 0 : this.masterGain;
      this.volumeNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.volumeNode) {
      this.volumeNode.gain.value = this.isMuted ? 0 : this.masterGain;
    }
    return this.isMuted;
  }

  stopMusic() {
    if (this.currentInterval) {
      clearInterval(this.currentInterval);
      this.currentInterval = null;
    }
    if (this.activeOscillators) {
      this.activeOscillators.forEach(osc => {
        try { osc.stop(); } catch(e) {}
      });
      this.activeOscillators = [];
    }
  }

  // Helper to play a clean synth tone with ADSR envelope
  playTone(freq, type = 'sine', duration = 0.3, volume = 0.4, startTime = 0) {
    if (this.isMuted || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime + startTime);

    gain.gain.setValueAtTime(0.001, this.ctx.currentTime + startTime);
    gain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + startTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + startTime + duration);

    osc.connect(gain);
    gain.connect(this.volumeNode);

    osc.start(this.ctx.currentTime + startTime);
    osc.stop(this.ctx.currentTime + startTime + duration);
  }

  // --- 1. LOBBY GROOVE (Classy, Upbeat Wedding Vibe) ---
  playLobbyMusic() {
    this.init();
    this.stopMusic();
    if (this.isMuted) return;

    // Upbeat elegant chord progression: F -> G -> Em -> Am
    const chords = [
      [349.23, 440.00, 523.25], // F major (F4, A4, C5)
      [392.00, 493.88, 587.33], // G major (G4, B4, D5)
      [329.63, 392.00, 493.88], // E minor (E4, G4, B4)
      [440.00, 523.25, 659.25]  // A minor (A4, C5, E5)
    ];

    let step = 0;
    this.currentInterval = setInterval(() => {
      if (this.isMuted) return;
      const chord = chords[Math.floor(step / 4) % chords.length];
      const note = chord[step % chord.length];

      // Soft marimba-style bell
      this.playTone(note, 'triangle', 0.25, 0.15);
      
      // Bass thump every 4 beats
      if (step % 4 === 0) {
        this.playTone(note / 2, 'sine', 0.35, 0.25);
      }
      step++;
    }, 280);
  }

  // --- 2. COUNTDOWN SUSPENSE (Kahoot-Style Tension) ---
  playQuestionMusic(timeLeft = 20) {
    this.init();
    this.stopMusic();
    if (this.isMuted) return;

    let beat = 0;
    // Rhythmic pulse
    this.currentInterval = setInterval(() => {
      if (this.isMuted) return;

      // Base tension bassline (D - F - G - A)
      const bassNotes = [146.83, 174.61, 196.00, 220.00];
      const bass = bassNotes[beat % bassNotes.length];
      
      this.playTone(bass, 'sawtooth', 0.12, 0.12);
      this.playTone(bass * 2, 'triangle', 0.1, 0.1);

      // Hi-hat tick
      this.playTone(800, 'square', 0.03, 0.04);

      beat++;
    }, 450);
  }

  // Tick sound when time is under 5 seconds
  playUrgentTick() {
    this.init();
    if (this.isMuted) return;
    this.playTone(880, 'sine', 0.08, 0.3); // High alert pip
  }

  // --- 3. REVEAL CHIME (Answer Unveiled) ---
  playRevealJingle() {
    this.init();
    this.stopMusic();
    if (this.isMuted) return;

    // Upbeat ascending chime: C5 -> E5 -> G5 -> C6
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, idx) => {
      this.playTone(freq, 'triangle', 0.4, 0.35, idx * 0.1);
    });
  }

  // --- 4. LEADERBOARD DRUMROLL / SUSPENSE ---
  playLeaderboardSting() {
    this.init();
    this.stopMusic();
    if (this.isMuted) return;

    // Dramatic brass swell
    const chord = [261.63, 329.63, 392.00, 523.25];
    chord.forEach(f => {
      this.playTone(f, 'sawtooth', 0.8, 0.18, 0);
    });
    // High shimmer
    this.playTone(1318.51, 'sine', 1.0, 0.25, 0.15);
  }

  // --- 5. PODIUM / WINNER GRAND FANFARE 👑 ---
  playPodiumFanfare() {
    this.init();
    this.stopMusic();
    if (this.isMuted) return;

    // Grand Olympic/Wedding Fanfare: G4 -> C5 -> E5 -> G5 -> C6
    const fanfare = [
      { f: 392.00, t: 0.0, d: 0.25 }, // G4
      { f: 523.25, t: 0.22, d: 0.25 }, // C5
      { f: 659.25, t: 0.44, d: 0.25 }, // E5
      { f: 783.99, t: 0.66, d: 0.7 },  // G5
      { f: 659.25, t: 1.35, d: 0.2 },  // E5
      { f: 1046.50, t: 1.55, d: 1.8 }  // Grand C6 chord!
    ];

    fanfare.forEach(note => {
      this.playTone(note.f, 'sawtooth', note.d, 0.25, note.t);
      this.playTone(note.f * 1.5, 'triangle', note.d, 0.15, note.t);
    });
  }
}

// Global instance
window.triviaAudio = new TriviaAudio();
