// ---------------------------------------------------------------------------
// WAV encoding (mono 16-bit PCM) — used for per-track export downloads.
// ---------------------------------------------------------------------------
function encodeWav(float32Array, sampleRate) {
  const numFrames = float32Array.length;
  const buffer = new ArrayBuffer(44 + numFrames * 2);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numFrames * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, numFrames * 2, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

// Single source of truth for the app version (semver). Keep CACHE_NAME in
// sw.js in sync — patch = fixes, minor = features, major = reworks.
const APP_VERSION = '1.4.0';

// Bold, Jam-Looper-style track colors. Mid-saturated so a full-color card
// still reads white text; each track's card, lane tiles and waveform take
// its color.
const TRACK_PALETTE = ['#ef6d66', '#4e86f5', '#17b79e', '#8a7bf0', '#e85fa0', '#3da96e', '#e08a4e', '#35a5db'];

// ---------------------------------------------------------------------------
// Track — one loopable recording with its own trim (loopStart/loopEnd),
// volume, mute and solo state.
// ---------------------------------------------------------------------------
let trackIdCounter = 0;

class Track {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.id = opts.id || `track-${Date.now()}-${trackIdCounter++}`;
    this.order = opts.order ?? engine.tracks.length;
    this.name = opts.name || `Track ${this.order + 1}`;
    this.buffer = null;
    this.loopStart = opts.loopStart ?? 0;
    this.loopEnd = opts.loopEnd ?? 0;
    this.volume = opts.volume ?? 1;
    this.muted = opts.muted ?? false;
    this.fade = opts.fade ?? 0.015; // crossfade length at the loop seam (s)
    this.offset = opts.offset ?? 0; // position within the master cycle (s)
    this.repeat = opts.repeat ?? 'fill'; // 'fill' or a count: times to repeat per cycle
    this.color = opts.color || null; // assigned on first view, then persisted
    this.solo = false;
    this.sourceNode = null;
    // Rendered full-cycle buffer: the trimmed region (with seam crossfade)
    // placed at `offset` and repeated per `repeat`, in a buffer exactly one
    // master cycle long — so every track loops at the identical length.
    this._proc = null;
    this._procDirty = true;
    this._cycleSecs = 0;
    this._regionSecs = 0;
    this._reps = 0;

    this.gainNode = engine.audioContext.createGain();
    this.gainNode.gain.value = this.muted ? 0 : this.volume;
    this.gainNode.connect(engine.masterGain);
  }

  setBuffer(audioBuffer) {
    this.buffer = audioBuffer;
    this.loopStart = 0;
    this.loopEnd = audioBuffer.duration;
    this._procDirty = true;
  }

  // The trimmed region with the seam crossfade baked in: the head is blended
  // equal-power with the audio following the loop end (or the tail with the
  // audio before the start) so continuous repetition is seamless; with no
  // material outside the region, short declick fades are used instead.
  // Also used for WAV export, so downloads are the region — not a whole
  // cycle of mostly silence.
  _renderRegion() {
    const sr = this.buffer.sampleRate;
    const data = this.buffer.getChannelData(0);
    const s = Math.max(0, Math.floor(this.loopStart * sr));
    const e = Math.min(Math.floor(this.loopEnd * sr), data.length);
    const len = Math.max(1, e - s);
    const out = new Float32Array(len);
    out.set(data.subarray(s, e));

    const F = Math.min(Math.floor(this.fade * sr), Math.floor(len / 2));
    if (F > 4) {
      const post = data.length - e; // samples available after the loop end
      const pre = s;                // samples available before the loop start
      for (let j = 0; j < F; j++) {
        const w = (j + 1) / (F + 1);
        const fadeIn = Math.sin(w * Math.PI / 2);
        const fadeOut = Math.cos(w * Math.PI / 2);
        if (post >= F) {
          out[j] = out[j] * fadeIn + data[e + j] * fadeOut;
        } else if (pre >= F) {
          out[len - F + j] = out[len - F + j] * fadeOut + data[s - F + j] * fadeIn;
        } else {
          out[j] *= fadeIn;
          out[len - 1 - j] *= fadeIn;
        }
      }
    }
    return { out, sr };
  }

  _rebuildProc() {
    if (!this.buffer) { this._proc = null; return; }
    const { out, sr } = this._renderRegion();
    const len = out.length;

    // Compose the full master cycle: this region placed at `offset`,
    // repeated `repeat` times (or filling the cycle), wrapping at the end.
    const regionSecs = len / sr;
    const L = Math.max(this.engine.masterLen(), regionSecs);
    const Lsamps = Math.max(1, Math.round(L * sr));
    const cycle = new Float32Array(Lsamps);
    const offSamps = Math.round(((this.offset % L) + L) % L * sr) % Lsamps;
    const maxReps = Math.ceil(Lsamps / len);
    const reps = this.repeat === 'fill'
      ? maxReps
      : Math.min(Math.max(1, parseInt(this.repeat, 10) || 1), maxReps);
    let totalPlaced = 0;
    for (let k = 0; k < reps; k++) {
      const placed = k * len;
      if (placed >= Lsamps) break;
      const copyLen = Math.min(len, Lsamps - placed);
      const pos = (offSamps + placed) % Lsamps;
      const first = Math.min(copyLen, Lsamps - pos);
      cycle.set(out.subarray(0, first), pos);
      if (copyLen > first) cycle.set(out.subarray(first, copyLen), 0);
      totalPlaced = placed + copyLen;
    }

    // Declick: the region's crossfaded edges are full-amplitude (designed
    // for continuous looping), so wherever a repeat starts/ends against
    // silence — or at the fill-truncation seam — splice pops occur. Ramp
    // ~4ms at those outer edges. A perfectly periodic fill needs none.
    const periodic = Lsamps % len === 0 && totalPlaced === Lsamps;
    const edge = Math.min(Math.round(0.004 * sr), Math.floor(len / 4));
    if (!periodic && edge > 2 && totalPlaced > 0) {
      for (let j = 0; j < edge; j++) {
        const g = j / edge;
        // fade-in at the first repeat's start
        cycle[(offSamps + j) % Lsamps] *= g;
        // fade-out at the last repeat's end
        cycle[(offSamps + totalPlaced - 1 - j + Lsamps) % Lsamps] *= g;
      }
    }

    this._proc = this.engine.audioContext.createBuffer(1, Lsamps, sr);
    this._proc.copyToChannel(cycle, 0);
    this._cycleSecs = L;
    this._regionSecs = regionSecs;
    this._reps = reps;
    this._procDirty = false;
  }

  _procBuffer() {
    if (!this._proc || this._procDirty) this._rebuildProc();
    return this._proc;
  }

  play(when, phase = 0) {
    if (!this.buffer) return;
    this.stop();
    const proc = this._procBuffer();
    if (!proc) return;
    const src = this.engine.audioContext.createBufferSource();
    src.buffer = proc;
    src.loop = true;
    src.loopStart = 0;
    // Loop at the exact cycle length in seconds (fractional-sample looping),
    // so every track wraps at the identical instant — zero long-term drift.
    src.loopEnd = this._cycleSecs;
    src.connect(this.gainNode);
    src.start(when, Math.max(0, Math.min(phase, this._cycleSecs - 0.001)));
    this.sourceNode = src;
    this._startedAt = when - phase;
  }

  // Start (or restart) locked to the engine's shared cycle. Every track's
  // buffer is a full cycle (position/repeats baked in), so alignment is just
  // joining at the current cycle phase.
  playSynced() {
    if (!this.buffer) return;
    const engine = this.engine;
    const ctx = engine.audioContext;
    const proc = this._procBuffer();
    if (!proc) return;
    if (engine.timelineStart == null) engine.setTimeline(ctx.currentTime + 0.05);
    const now = ctx.currentTime;
    if (engine.timelineStart > now + 0.02) {
      this.play(engine.timelineStart);
    } else {
      const phase = (((now + 0.03 - engine.timelineStart) % this._cycleSecs) + this._cycleSecs) % this._cycleSecs;
      this.play(now + 0.03, phase);
    }
  }

  stop() {
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (e) { /* already stopped */ }
      try { this.sourceNode.disconnect(); } catch (e) { /* noop */ }
      this.sourceNode = null;
      this._startedAt = null;
    }
  }

  // Current playback position in buffer time for the seeker, or null when
  // not playing or in a silent gap of the cycle (between repeats).
  playheadTime() {
    if (!this.sourceNode || this._startedAt == null) return null;
    const L = this._cycleSecs;
    const len = this._regionSecs;
    if (L <= 0 || len <= 0) return this.loopStart;
    let elapsed = this.engine.audioContext.currentTime - this._startedAt;
    if (elapsed < 0) elapsed = 0; // scheduled but not started yet
    const cyclePos = elapsed % L;
    const off = ((this.offset % L) + L) % L;
    const rel = ((cyclePos - off) % L + L) % L;
    const k = Math.floor(rel / len);
    if (k >= this._reps) return null; // in the silence between repeats
    return this.loopStart + (rel - k * len);
  }

  setLoopPoints(start, end) {
    if (!this.buffer) return;
    const minGap = 0.03;
    const dur = this.buffer.duration;
    start = Math.max(0, Math.min(start, dur - minGap));
    end = Math.max(start + minGap, Math.min(end, dur));
    this.loopStart = start;
    this.loopEnd = end;
    this._procDirty = true;
  }

  setFade(f) {
    this.fade = Math.max(0, Math.min(0.2, f));
    this._procDirty = true;
  }

  setOffset(o) {
    const L = this.engine.masterLen();
    o = Math.round(o * 1000) / 1000;
    this.offset = L > 0 ? ((o % L) + L) % L : Math.max(0, o);
    this._procDirty = true; // position is baked into the cycle buffer
  }

  setRepeat(r) {
    this.repeat = r === 'fill' ? 'fill' : Math.max(1, parseInt(r, 10) || 1);
    this._procDirty = true;
  }

  setVolume(v) {
    this.volume = v;
    this.applyGain();
  }

  setMuted(m) {
    this.muted = m;
    this.applyGain();
  }

  setSolo(s) {
    this.solo = s;
    this.engine.tracks.forEach((t) => t.applyGain());
  }

  applyGain() {
    const anySolo = this.engine.tracks.some((t) => t.solo);
    let effective = this.muted ? 0 : this.volume;
    if (anySolo && !this.solo) effective = 0;
    this.gainNode.gain.setTargetAtTime(effective, this.engine.audioContext.currentTime, 0.01);
  }

  toStorageRecord() {
    return {
      id: this.id,
      order: this.order,
      name: this.name,
      sampleRate: this.buffer ? this.buffer.sampleRate : this.engine.audioContext.sampleRate,
      channelData: this.buffer ? this.buffer.getChannelData(0).slice().buffer : null,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      volume: this.volume,
      muted: this.muted,
      fade: this.fade,
      offset: this.offset,
      repeat: this.repeat,
      color: this.color,
    };
  }
}

// ---------------------------------------------------------------------------
// Sample — a one-shot clip in the pad bank. Trigger it live, edit/trim it,
// or drop it into the arrangement (which spins up a one-shot track from it).
// ---------------------------------------------------------------------------
let sampleIdCounter = 0;

class Sample {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.id = opts.id || `sample-${Date.now()}-${sampleIdCounter++}`;
    this.slot = opts.slot ?? 0;
    this.name = opts.name || `Pad ${this.slot + 1}`;
    this.color = opts.color || TRACK_PALETTE[this.slot % TRACK_PALETTE.length];
    this.buffer = opts.buffer || null;
    this.loopStart = opts.loopStart ?? 0;
    this.loopEnd = opts.loopEnd ?? (opts.buffer ? opts.buffer.duration : 0);
    this.volume = opts.volume ?? 1;
    this.sourceNode = null;
  }

  setBuffer(buf) {
    this.buffer = buf;
    this.loopStart = 0;
    this.loopEnd = buf.duration;
  }

  setLoopPoints(start, end) {
    if (!this.buffer) return;
    const minGap = 0.02;
    const dur = this.buffer.duration;
    start = Math.max(0, Math.min(start, dur - minGap));
    end = Math.max(start + minGap, Math.min(end, dur));
    this.loopStart = start;
    this.loopEnd = end;
  }

  // Trimmed region with tiny declick edges — used for one-shot playback,
  // WAV export and building a track from the sample.
  renderRegion() {
    const sr = this.buffer.sampleRate;
    const s = Math.max(0, Math.floor(this.loopStart * sr));
    const e = Math.min(Math.floor(this.loopEnd * sr), this.buffer.length);
    const len = Math.max(1, e - s);
    const out = new Float32Array(len);
    out.set(this.buffer.getChannelData(0).subarray(s, e));
    const F = Math.min(Math.floor(0.004 * sr), Math.floor(len / 2));
    for (let j = 0; j < F; j++) { const g = j / F; out[j] *= g; out[len - 1 - j] *= g; }
    return { out, sr };
  }

  play() {
    if (!this.buffer) return;
    const ctx = this.engine.audioContext;
    this.stop();
    const { out, sr } = this.renderRegion();
    const buf = ctx.createBuffer(1, out.length, sr);
    buf.copyToChannel(out, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = this.volume;
    src.connect(g);
    g.connect(this.engine.masterGain);
    src.start();
    src.onended = () => { if (this.sourceNode === src) this.sourceNode = null; };
    this.sourceNode = src;
  }

  stop() {
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (e) { /* noop */ }
      this.sourceNode = null;
    }
  }

  // One-shots have no cycle position — lets WaveformEditor treat a Sample
  // like a Track (it draws a playhead only when this returns non-null).
  playheadTime() { return null; }

  toStorageRecord() {
    return {
      id: this.id,
      slot: this.slot,
      name: this.name,
      color: this.color,
      sampleRate: this.buffer ? this.buffer.sampleRate : 44100,
      channelData: this.buffer ? this.buffer.getChannelData(0).slice().buffer : null,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      volume: this.volume,
    };
  }
}

// ---------------------------------------------------------------------------
// AudioEngine — mic capture (via AudioWorklet) + playback graph.
// ---------------------------------------------------------------------------
class AudioEngine {
  constructor() {
    this.audioContext = null; // playback-only; the mic NEVER touches this
    this.masterGain = null;
    this.micStream = null;
    this.tracks = [];
    this.timelineStart = null; // shared cycle epoch (playback-context time)
    this._timelineWall = null; // same epoch in wall-clock ms — survives context rebuilds
    this._stallTicks = 0;
    this._rebuilding = false;
    this.recordingTrack = null;   // loop currently being recorded (or null)
    this.capturing = false;       // mic capture pipeline is active
    this.samples = [];            // pad-bank one-shot samples
    this.recordedChunks = [];
    this.recordedLength = 0;
    this.initialized = false;
    this.onLevelUpdate = null;
    // Capture runs on its own context so iOS route flips during recording
    // can't suspend or stall the playback graph.
    this._captureCtx = null;
    this._captureNode = null;
    this._captureAnalyser = null;
    this._captureSource = null;
    this._recWatchdog = null;
  }

  // WebKit's Audio Session API (iOS 17+): explicitly telling iOS the page is
  // a playback app is what makes it route Web Audio to A2DP Bluetooth instead
  // of the call-audio (receiver/HFP) route it picks after any mic use.
  _setSessionType(type) {
    if ('audioSession' in navigator) {
      try { navigator.audioSession.type = type; } catch (e) { /* older WebKit */ }
    }
  }

  // A hidden <audio> element looping a (file-backed) silent WAV. Actively
  // playing FILE media is what anchors Safari's audio session in the "media
  // playback" category, which iOS routes to Bluetooth A2DP. (A MediaStream-
  // backed element does NOT work for this — WebKit treats live streams as
  // call audio, which is exactly the route we're escaping.)
  _ensureKeepAlive() {
    if (!this.keepAliveEl) {
      this.keepAliveEl = document.getElementById('audioOut');
      const silence = encodeWav(new Float32Array(2205), 44100); // 50 ms of silence
      this.keepAliveEl.src = URL.createObjectURL(silence);
      this.keepAliveEl.loop = true;
      this.keepAliveEl.volume = 0.01;
    }
    if (this.keepAliveEl.paused) {
      this.keepAliveEl.play().catch(() => { /* will retry on next gesture */ });
    }
  }

  // Called from every user gesture that should produce sound: revives a
  // suspended context and the keep-alive element (iOS pauses media elements
  // on route changes and interruptions).
  _ensureOutput() {
    if (this.audioContext && this.audioContext.state !== 'running') {
      this.audioContext.resume();
    }
    this._ensureKeepAlive();
  }

  // Manual escape hatch (the "↻ Audio" button): tear the whole audio path
  // down and rebuild it, keeping whatever was playing playing. For when iOS
  // wedges the route in call mode despite everything.
  async recoverAudio() {
    const playing = this.tracks.filter((t) => t.sourceNode);
    // Never yank the mic mid-take — only rebuild the playback side then.
    if (!this.recordingTrack) this._releaseMic();
    await this._rebuildGraph();
    this._ensureOutput();
    if (playing.length) {
      if (this.timelineStart == null) this.setTimeline(this.audioContext.currentTime + 0.05);
      playing.forEach((t) => t.playSynced());
    }
  }

  async _createGraph() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioContext.state !== 'running') this.audioContext.resume();
    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.audioContext.destination);
    this._ensureKeepAlive();

    // iOS marks the context 'interrupted'/'suspended' on audio route changes
    // (e.g. when the mic is released and output flips back to Bluetooth).
    this.audioContext.onstatechange = () => {
      if (this.audioContext.state !== 'running' && document.visibilityState === 'visible') {
        this.audioContext.resume();
      }
    };
  }

  // An iOS AudioContext that has lived through a "play and record" session can
  // stay stuck on the call-audio route even after the mic is released. The
  // only reliable escape is to close it and build a fresh context, which opens
  // a clean playback-only session that iOS routes to the Bluetooth speaker.
  async _rebuildGraph() {
    const old = this.audioContext;
    if (old) {
      try { old.onstatechange = null; if (old.state !== 'closed') await old.close(); } catch (e) { /* noop */ }
    }
    await this._createGraph();
    // Restore the cycle epoch in the new context's timebase via the
    // wall-clock anchor so playback rejoins at the same phase.
    this.timelineStart = this._timelineWall != null
      ? this.audioContext.currentTime + (this._timelineWall - Date.now()) / 1000
      : null;
    for (const t of this.tracks) {
      t.sourceNode = null;
      t._proc = null;
      t._procDirty = true;
      t.gainNode = this.audioContext.createGain();
      t.gainNode.gain.value = t.muted ? 0 : t.volume;
      t.gainNode.connect(this.masterGain);
      t.applyGain();
      if (t.buffer) {
        const nb = this.audioContext.createBuffer(1, t.buffer.length, t.buffer.sampleRate);
        nb.copyToChannel(t.buffer.getChannelData(0), 0);
        t.buffer = nb;
      }
    }
    for (const s of this.samples) {
      s.stop();
      if (s.buffer) {
        const nb = this.audioContext.createBuffer(1, s.buffer.length, s.buffer.sampleRate);
        nb.copyToChannel(s.buffer.getChannelData(0), 0);
        s.buffer = nb;
      }
    }
  }

  async init() {
    if (this.initialized) return;
    this._setSessionType('playback');
    // NOTE: the mic is deliberately NOT touched here. Any getUserMedia call
    // flips the iOS audio session into call mode — the mic permission prompt
    // now happens on the first record instead (see _acquireMic).
    await this._createGraph();

    this.initialized = true;
    this._startLevelLoop();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._ensureOutput();
    });
  }

  _isBuiltInMicLabel(label) {
    return /built[- ]?in|iphone|ipad|internal/i.test(label || '');
  }

  async _builtInMicId() {
    // Labels are only populated once mic permission has been granted.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const builtIn = devices.find(
        (d) => d.kind === 'audioinput' && this._isBuiltInMicLabel(d.label)
      );
      return builtIn ? builtIn.deviceId : null;
    } catch (e) {
      return null;
    }
  }

  async _acquireMic() {
    if (this.micStream) return;
    this._setSessionType('play-and-record');
    const baseConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    try {
      // Always record from the phone's BUILT-IN mic. If iOS picks the
      // Bluetooth speaker's own microphone, the speaker is forced into HFP
      // call mode — and many stay stuck there until reconnected.
      const knownId = await this._builtInMicId();
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: knownId ? { ...baseConstraints, deviceId: { exact: knownId } } : baseConstraints,
      });
      const got = this.micStream.getAudioTracks()[0];
      if (got && !this._isBuiltInMicLabel(got.label)) {
        // Landed on some other mic (labels weren't available before the
        // permission grant) — now they are, so swap to the built-in one.
        const builtInId = await this._builtInMicId();
        if (builtInId) {
          this.micStream.getTracks().forEach((t) => t.stop());
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: { ...baseConstraints, deviceId: { exact: builtInId } },
          });
        }
      }
    } catch (err) {
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }
      this._setSessionType('playback');
      throw err;
    }
  }

  _releaseMic() {
    if (this._captureSource) {
      try { this._captureSource.disconnect(); } catch (e) { /* noop */ }
      this._captureSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this._setSessionType('playback');
  }

  // The capture context (plus worklet + analyser) is created once and reused
  // across takes; only the mic stream itself is per-take. Between takes it
  // sits suspended with no live input, so it doesn't hold iOS in call mode.
  async _ensureCaptureGraph() {
    if (this._captureCtx) return;
    this._captureCtx = new (window.AudioContext || window.webkitAudioContext)();
    await this._captureCtx.audioWorklet.addModule('recorder-worklet.js');
    this._captureNode = new AudioWorkletNode(this._captureCtx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this._captureNode.port.onmessage = (e) => this._onWorkletChunk(e.data);
    this._captureAnalyser = this._captureCtx.createAnalyser();
    this._captureAnalyser.fftSize = 256;
  }

  _startLevelLoop() {
    const data = new Uint8Array(128); // fftSize 256 → 128 bins
    const loop = () => {
      let peak = 0;
      if (this._captureAnalyser && this.capturing) {
        this._captureAnalyser.getByteTimeDomainData(data);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
      }
      if (this.onLevelUpdate) this.onLevelUpdate(peak);
      requestAnimationFrame(loop);
    };
    loop();
  }

  _onWorkletChunk(chunk) {
    if (!this.capturing) return;
    this.recordedChunks.push(chunk);
    this.recordedLength += chunk.length;
  }

  nextOrder() {
    if (this.tracks.length === 0) return 0;
    return Math.max(...this.tracks.map((t) => t.order)) + 1;
  }

  createTrack() {
    const track = new Track(this, { order: this.nextOrder() });
    this.tracks.push(track);
    return track;
  }

  // Generic mic capture — used for both loop recording and sample recording.
  // Returns nothing; call stopCapture() to get the recorded AudioBuffer.
  async startCapture() {
    this._ensureOutput();
    // Grab the mic only for the duration of the take — holding it open keeps
    // iOS in call-mode routing and away from the Bluetooth A2DP output.
    await this._acquireMic();
    try {
      await this._ensureCaptureGraph();
      if (this._captureCtx.state !== 'running') await this._captureCtx.resume();
    } catch (err) {
      this._releaseMic();
      throw err;
    }
    this._captureSource = this._captureCtx.createMediaStreamSource(this.micStream);
    // Mic is NOT connected to any destination: no live monitoring, so there's
    // no feedback/echo introduced by output latency while recording.
    this._captureSource.connect(this._captureAnalyser);
    this._captureSource.connect(this._captureNode);
    this.recordedChunks = [];
    this.recordedLength = 0;
    this.capturing = true;
    this._captureNode.port.postMessage('start');
    // iOS route flips when the mic opens can suspend the PLAYBACK context —
    // keep kicking it so existing loops keep playing under the overdub. If
    // resume() fails for ~1s the context is wedged: rebuild playback outright
    // (capture is a separate context and keeps recording through this), and
    // rejoin the loops at the preserved cycle phase.
    this._stallTicks = 0;
    this._recWatchdog = setInterval(async () => {
      this._ensureOutput();
      if (this.audioContext.state !== 'running') {
        this._stallTicks++;
        if (this._stallTicks >= 3 && !this._rebuilding) {
          this._rebuilding = true;
          const playing = this.tracks.filter((t) => t.sourceNode);
          try {
            await this._rebuildGraph();
            playing.forEach((t) => t.playSynced());
          } catch (e) { /* keep recording regardless */ }
          this._rebuilding = false;
          this._stallTicks = 0;
        }
      } else {
        this._stallTicks = 0;
      }
    }, 300);
  }

  async stopCapture() {
    if (this._recWatchdog) {
      clearInterval(this._recWatchdog);
      this._recWatchdog = null;
    }
    if (!this.capturing) {
      this._releaseMic();
      return null;
    }
    this._captureNode.port.postMessage('stop');
    // Give the worklet a moment to flush its final chunk over the port.
    await new Promise((r) => setTimeout(r, 150));
    this.capturing = false;
    const recSampleRate = this._captureCtx.sampleRate;
    const merged = new Float32Array(this.recordedLength);
    let offset = 0;
    for (const chunk of this.recordedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.recordedChunks = [];
    this.recordedLength = 0;

    // Release the mic and park the capture context. Playback was never
    // touched — existing loops keep running under and after the take.
    this._releaseMic();
    try { await this._captureCtx.suspend(); } catch (e) { /* noop */ }
    this._ensureOutput();

    const audioBuffer = this.audioContext.createBuffer(
      1,
      Math.max(1, merged.length),
      recSampleRate
    );
    audioBuffer.copyToChannel(merged, 0);
    return audioBuffer;
  }

  async startRecording(track) {
    this.recordingTrack = track;
    // Remember WHERE in the running cycle this take began, so the new loop
    // defaults to playing back at the position it was performed at.
    const L = this.masterLen();
    this._recStartOffset = (this.timelineStart != null && L > 0)
      ? (((this.audioContext.currentTime - this.timelineStart) % L) + L) % L
      : null;
    try {
      await this.startCapture();
    } catch (err) {
      this.recordingTrack = null;
      throw err;
    }
  }

  async stopRecording() {
    const track = this.recordingTrack;
    this.recordingTrack = null;
    const audioBuffer = await this.stopCapture();
    if (!track) return null;
    if (!audioBuffer) return track;
    const lenBefore = this.masterLen(); // cycle length set by OTHER tracks
    track.setBuffer(audioBuffer);
    // An overdub shorter than the cycle lands where it was performed; a take
    // that becomes the new longest loop defines the cycle and starts at 0.
    if (this._recStartOffset != null && lenBefore > 0 &&
        track.loopEnd - track.loopStart < lenBefore) {
      track.setOffset(this._recStartOffset);
    }
    this._recStartOffset = null;
    return track;
  }

  // Master cycle length = the longest track's loop region.
  masterLen() {
    let L = 0;
    for (const t of this.tracks) {
      if (t.buffer) L = Math.max(L, t.loopEnd - t.loopStart);
    }
    return L;
  }

  setTimeline(when) {
    this.timelineStart = when;
    this._timelineWall = Date.now() + (when - this.audioContext.currentTime) * 1000;
  }

  // Re-render every track's cycle buffer (cycle length or placement changed)
  // and re-join the playing ones at the current phase.
  resyncAll() {
    this.tracks.forEach((t) => { t._procDirty = true; });
    this.tracks.filter((t) => t.sourceNode).forEach((t) => t.playSynced());
  }

  playAll() {
    this._ensureOutput();
    this.setTimeline(this.audioContext.currentTime + 0.05);
    this.tracks.forEach((t) => t.playSynced());
  }

  playTrack(track) {
    this._ensureOutput();
    track.playSynced(); // joins the running cycle (or starts one)
  }

  playSample(sample) {
    this._ensureOutput();
    sample.play();
  }

  stopAll() {
    this.tracks.forEach((t) => t.stop());
    this.samples.forEach((s) => s.stop());
    this.timelineStart = null;
    this._timelineWall = null;
  }

  removeTrack(track) {
    track.stop();
    track.gainNode.disconnect();
    this.tracks = this.tracks.filter((t) => t !== track);
  }

  anyPlaying() {
    return this.tracks.some((t) => t.sourceNode);
  }
}

// ---------------------------------------------------------------------------
// WaveformEditor — draws a track's waveform and handles touch-drag trimming.
// ---------------------------------------------------------------------------
class WaveformEditor {
  constructor(canvas, track, onChange) {
    this.canvas = canvas;
    this.track = track;
    this.onChange = onChange;
    this.ctx = canvas.getContext('2d');
    this.dragging = null;
    this.dragStartX = 0;
    this.dragOrigStart = 0;
    this.dragOrigEnd = 0;
    this.handleWidthCss = 24; // generous touch target around each handle

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
  }

  resizeAndDraw() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.draw();
  }

  timeToX(t) {
    const dur = this.track.buffer.duration || 1;
    return (t / dur) * this.canvas.width;
  }

  xToTime(x) {
    const dur = this.track.buffer.duration || 1;
    return Math.max(0, Math.min(dur, (x / this.canvas.width) * dur));
  }

  getPointerX(e) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return (e.clientX - rect.left) * dpr;
  }

  onPointerDown(e) {
    if (!this.track.buffer) return;
    const x = this.getPointerX(e);
    const dpr = window.devicePixelRatio || 1;
    const startX = this.timeToX(this.track.loopStart);
    const endX = this.timeToX(this.track.loopEnd);
    const handlePx = this.handleWidthCss * dpr;

    if (Math.abs(x - startX) <= handlePx) {
      this.dragging = 'start';
    } else if (Math.abs(x - endX) <= handlePx) {
      this.dragging = 'end';
    } else if (x > startX && x < endX) {
      this.dragging = 'move';
      this.dragStartX = x;
      this.dragOrigStart = this.track.loopStart;
      this.dragOrigEnd = this.track.loopEnd;
    } else {
      return;
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    e.preventDefault();
  }

  onPointerMove(e) {
    if (!this.dragging || !this.track.buffer) return;
    const x = this.getPointerX(e);
    const dur = this.track.buffer.duration;

    if (this.dragging === 'start') {
      this.track.setLoopPoints(this.xToTime(x), this.track.loopEnd);
    } else if (this.dragging === 'end') {
      this.track.setLoopPoints(this.track.loopStart, this.xToTime(x));
    } else if (this.dragging === 'move') {
      const dt = this.xToTime(x) - this.xToTime(this.dragStartX);
      const len = this.dragOrigEnd - this.dragOrigStart;
      let newStart = this.dragOrigStart + dt;
      let newEnd = this.dragOrigEnd + dt;
      if (newStart < 0) { newStart = 0; newEnd = len; }
      if (newEnd > dur) { newEnd = dur; newStart = dur - len; }
      this.track.setLoopPoints(newStart, newEnd);
    }
    this.draw();
    if (this.onChange) this.onChange(false);
  }

  onPointerUp() {
    if (this.dragging) {
      this.dragging = null;
      if (this.onChange) this.onChange(true);
    }
  }

  // The static view (waveform + region + handles) is cached to an offscreen
  // canvas so the per-frame seeker redraw is just a cheap blit + line.
  _ensureCache() {
    const t = this.track;
    const key = [
      this.canvas.width,
      this.canvas.height,
      t.buffer ? t.buffer.length : 0,
      t.loopStart.toFixed(4),
      t.loopEnd.toFixed(4),
    ].join('|');
    if (this._cacheKey === key && this._cache) return;
    this._cacheKey = key;
    if (!this._cache) this._cache = document.createElement('canvas');
    this._cache.width = this.canvas.width;
    this._cache.height = this.canvas.height;
    this._renderStatic(this._cache.getContext('2d'));
  }

  _renderStatic(ctx) {
    const track = this.track;
    const w = this._cache.width;
    const h = this._cache.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);
    if (!track.buffer) return;

    const accent = track.color || '#6ee7ff';
    const data = track.buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    const mid = h / 2;
    const startX = this.timeToX(track.loopStart);
    const endX = this.timeToX(track.loopEnd);

    ctx.globalAlpha = 0.14;
    ctx.fillStyle = accent;
    ctx.fillRect(startX, 0, endX - startX, h);
    ctx.globalAlpha = 1;

    for (let x = 0; x < w; x++) {
      let min = 1;
      let max = -1;
      const idxStart = x * step;
      for (let i = 0; i < step; i++) {
        const idx = idxStart + i;
        if (idx >= data.length) break;
        const v = data[idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      const inRegion = x >= startX && x <= endX;
      ctx.strokeStyle = inRegion ? accent : '#475569';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid + min * mid * 0.92);
      ctx.lineTo(x + 0.5, mid + max * mid * 0.92);
      ctx.stroke();
    }

    // Dim everything outside the loop region so the active part pops.
    ctx.fillStyle = 'rgba(2,6,12,0.55)';
    if (startX > 0) ctx.fillRect(0, 0, startX, h);
    if (endX < w) ctx.fillRect(endX, 0, w - endX, h);

    // Chunky grab-tab handles with grip notches (easier to spot and drag
    // than thin lines).
    const dpr = window.devicePixelRatio || 1;
    const tabW = 10 * dpr;
    const drawHandle = (x) => {
      ctx.fillStyle = '#facc15';
      ctx.fillRect(x - 1.5 * dpr, 0, 3 * dpr, h);
      ctx.beginPath();
      const rx = x - tabW / 2;
      const tabH = Math.min(h * 0.55, 46 * dpr);
      const ry = (h - tabH) / 2;
      const r = 4 * dpr;
      ctx.moveTo(rx + r, ry);
      ctx.arcTo(rx + tabW, ry, rx + tabW, ry + tabH, r);
      ctx.arcTo(rx + tabW, ry + tabH, rx, ry + tabH, r);
      ctx.arcTo(rx, ry + tabH, rx, ry, r);
      ctx.arcTo(rx, ry, rx + tabW, ry, r);
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,23,42,0.85)';
      ctx.lineWidth = 1.2 * dpr;
      const gy = h / 2;
      for (let g = -1; g <= 1; g++) {
        ctx.beginPath();
        ctx.moveTo(x - 2.5 * dpr, gy + g * 5 * dpr);
        ctx.lineTo(x + 2.5 * dpr, gy + g * 5 * dpr);
        ctx.stroke();
      }
    };
    drawHandle(startX);
    drawHandle(endX);
  }

  draw() {
    this._ensureCache();
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this._cache, 0, 0);

    // Seeker: bright playhead line sweeping through the loop region.
    const pos = this.track.playheadTime();
    if (pos != null && this.track.buffer) {
      const x = this.timeToX(pos);
      ctx.fillStyle = 'rgba(248,250,252,0.95)';
      ctx.fillRect(x - 1, 0, 2, canvas.height);
      ctx.fillStyle = 'rgba(248,250,252,0.25)';
      ctx.fillRect(x - 3, 0, 6, canvas.height);
    }
  }
}

// ---------------------------------------------------------------------------
// TimelineLane — the arrange strip. Shows the full master cycle with a time
// ruler and empty space. The loop is a colored block placed at `offset`:
//   • drag the block body    → move it in the cycle (offset)
//   • drag the block's right edge → set how many times it loops (repeat),
//     dragging to the far end = fill the cycle
// All lanes share the master-cycle time scale, so they stack in alignment
// and one playhead sweeps them. Snaps to other tracks' edges + quarter marks.
// ---------------------------------------------------------------------------
class TimelineLane {
  constructor(canvas, track, app, onChange) {
    this.canvas = canvas;
    this.track = track;
    this.app = app;
    this.onChange = onChange;
    this.ctx = canvas.getContext('2d');
    this.dragging = false;
    this.mode = null;      // 'move' | 'loop'
    this.moved = false;
    this.dragStartX = 0;
    this.dragOrigOffset = 0;
    this.dragL = 0;
    this.snaps = [];
    this._snapAt = null;   // cycle-time of an active snap (for the guide line)

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  cycleLen() {
    return Math.max(this.app.engine.masterLen(), this.track.loopEnd - this.track.loopStart, 0.01);
  }

  resizeAndDraw() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this._cacheKey = null;
    this.draw();
  }

  timeToX(t) { return (t / (this.dragL || this.cycleLen())) * this.canvas.width; }
  xToTime(x) { return (x / this.canvas.width) * (this.dragL || this.cycleLen()); }

  getX(e) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return (e.clientX - rect.left) * dpr;
  }

  // Geometry shared by drawing + hit-testing.
  _layout(L) {
    const region = this.track.loopEnd - this.track.loopStart;
    if (region <= 0) return { region: 0, reps: 0, maxReps: 0, off: 0, extentEnd: 0 };
    const maxReps = Math.max(1, Math.ceil(L / region - 1e-9));
    const reps = this.track.repeat === 'fill'
      ? maxReps
      : Math.min(Math.max(1, parseInt(this.track.repeat, 10) || 1), maxReps);
    const off = ((this.track.offset % L) + L) % L;
    const extentEnd = Math.min(off + reps * region, L);
    return { region, reps, maxReps, off, extentEnd };
  }

  _ensureCache() {
    const t = this.track;
    const L = this.dragL || this.cycleLen();
    const key = [this.canvas.width, this.canvas.height, L.toFixed(3),
      t.loopStart.toFixed(3), t.loopEnd.toFixed(3), t.offset.toFixed(3),
      t.repeat, t.color].join('|');
    if (this._cacheKey === key && this._cache) return;
    this._cacheKey = key;
    if (!this._cache) this._cache = document.createElement('canvas');
    this._cache.width = this.canvas.width;
    this._cache.height = this.canvas.height;
    this._renderStatic(this._cache.getContext('2d'), L);
  }

  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _renderStatic(ctx, L) {
    const t = this.track;
    const w = this._cache.width, h = this._cache.height;
    const dpr = window.devicePixelRatio || 1;
    const rulerH = 14 * dpr;
    const bodyY = rulerH, bodyH = h - rulerH;
    ctx.clearRect(0, 0, w, h);

    // Empty timeline background (this is the visible "empty space").
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fillRect(0, bodyY, w, bodyH);

    // Ruler ticks + numbers.
    const gridStep = L > 12 ? 4 : (L > 6 ? 2 : 1);
    ctx.textBaseline = 'top';
    ctx.font = `${8.5 * dpr}px -apple-system, system-ui, sans-serif`;
    for (let s = 0; s < L - 1e-6; s += gridStep) {
      const x = this.timeToX(s);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, bodyY); ctx.lineTo(x, h); ctx.stroke();
      if (s > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.34)';
        ctx.fillText(String(s), x + 2 * dpr, 2 * dpr);
      }
    }

    if (!t.buffer) return;
    const { region, reps, off, extentEnd } = this._layout(L);
    if (region <= 0) return;
    const accent = t.color || '#6ee7ff';
    const data = t.buffer.getChannelData(0);
    const sr = t.buffer.sampleRate;
    const regS = Math.floor(t.loopStart * sr);
    const regE = Math.min(Math.floor(t.loopEnd * sr), data.length);
    const mid = bodyY + bodyH / 2;

    const drawPiece = (ca, cb, fa, fb, first, last) => {
      const x0 = this.timeToX(ca), x1 = this.timeToX(cb);
      const pw = Math.max(1, x1 - x0);
      const grad = ctx.createLinearGradient(0, bodyY, 0, h);
      grad.addColorStop(0, this._tint(accent, 0.42));
      grad.addColorStop(1, this._tint(accent, 0.24));
      ctx.fillStyle = grad;
      this._roundRect(ctx, x0 + 1, bodyY + 3, pw - 2, bodyH - 6, 6 * dpr); ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this._tint(accent, 0.9);
      this._roundRect(ctx, x0 + 1, bodyY + 3, pw - 2, bodyH - 6, 6 * dpr); ctx.stroke();

      const s0 = Math.floor(regS + fa * (regE - regS));
      const s1 = Math.floor(regS + fb * (regE - regS));
      const total = Math.max(1, s1 - s0);
      const step = Math.max(1, Math.floor(total / pw));
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let px = 0; px < pw; px++) {
        let mn = 1, mx = -1;
        const i0 = s0 + px * step;
        for (let i = 0; i < step; i++) {
          const idx = i0 + i; if (idx >= s1) break;
          const v = data[idx]; if (v < mn) mn = v; if (v > mx) mx = v;
        }
        if (mn > mx) { mn = 0; mx = 0; }
        const xx = x0 + px + 0.5;
        ctx.moveTo(xx, mid + mn * (bodyH / 2) * 0.62);
        ctx.lineTo(xx, mid + mx * (bodyH / 2) * 0.62);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    // Tiles for each repeat (wrap-aware).
    for (let k = 0; k < reps; k++) {
      const ts = (off + k * region) % L;
      if (ts + region <= L + 1e-6) {
        drawPiece(ts, Math.min(ts + region, L), 0, 1);
      } else {
        const f = (L - ts) / region;
        drawPiece(ts, L, 0, f);
        drawPiece(0, ts + region - L, f, 1);
      }
    }

    // Edge handles: left = trim from front, right = set repeats (loop).
    const drawHandle = (cx) => {
      const hx = Math.max(4 * dpr, Math.min(cx, w - 4 * dpr));
      ctx.fillStyle = '#fff';
      this._roundRect(ctx, hx - 4 * dpr, bodyY + 6, 8 * dpr, bodyH - 12, 3 * dpr);
      ctx.fill();
      ctx.strokeStyle = this._tint(accent, 0.5);
      ctx.lineWidth = 1;
      for (let g = -1; g <= 1; g++) {
        const gy = mid + g * 4 * dpr;
        ctx.beginPath();
        ctx.moveTo(hx - 1.5 * dpr, gy); ctx.lineTo(hx + 1.5 * dpr, gy); ctx.stroke();
      }
    };
    drawHandle(this.timeToX(off));         // trim-start handle
    drawHandle(this.timeToX(extentEnd));   // loop handle
  }

  // Lighten a hex color toward white by amount (0..1) → rgba string.
  _tint(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }

  draw() {
    this._ensureCache();
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this._cache, 0, 0);

    // Snap guide while dragging.
    if (this.dragging && this._snapAt != null) {
      const x = this.timeToX(this._snapAt);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x - 0.5, 0, 1, canvas.height);
    }

    // Shared cycle playhead + top triangle.
    const e = this.app.engine;
    if (e.timelineStart != null && e.audioContext && e.anyPlaying()) {
      const L = this.dragL || this.cycleLen();
      const pos = (((e.audioContext.currentTime - e.timelineStart) % L) + L) % L;
      const x = this.timeToX(pos);
      ctx.fillStyle = 'rgba(248,250,252,0.92)';
      ctx.fillRect(x - 1, 0, 2, canvas.height);
      ctx.beginPath();
      ctx.moveTo(x - 4 * dpr, 0); ctx.lineTo(x + 4 * dpr, 0); ctx.lineTo(x, 5 * dpr);
      ctx.closePath(); ctx.fill();
    }
  }

  onDown(e) {
    if (!this.track.buffer) return;
    const L = this.cycleLen();
    this.dragL = L;
    const x = this.getX(e);
    const dpr = window.devicePixelRatio || 1;
    const lay = this._layout(L);
    const rightX = this.timeToX(lay.extentEnd);
    const leftX = this.timeToX(lay.off);
    const hpx = 16 * dpr;
    const dR = Math.abs(x - rightX), dL = Math.abs(x - leftX);

    if (dR <= hpx && dR <= dL) {
      this.mode = 'loop';           // right edge → set repeats
    } else if (dL <= hpx) {
      this.mode = 'trimStart';      // left edge → trim from the front
    } else {
      const xc = this.xToTime(x);
      const rel = (((xc - lay.off) % L) + L) % L;
      if (rel < lay.reps * lay.region) this.mode = 'move';
      else { this.dragL = 0; return; } // tapped empty space
    }

    this.dragging = true;
    this.moved = false;
    this.dragStartX = x;
    this.dragOrigOffset = this.track.offset;
    this.dragOrigLoopStart = this.track.loopStart;
    this._snapAt = null;

    // Snap targets for move: other tracks' tile edges + cycle quarter marks.
    this.snaps = [0];
    for (const t of this.app.engine.tracks) {
      if (t === this.track || !t.buffer) continue;
      const region = t.loopEnd - t.loopStart;
      if (region <= 0) continue;
      const maxReps = Math.max(1, Math.ceil(L / region - 1e-9));
      const reps = t.repeat === 'fill'
        ? maxReps
        : Math.min(Math.max(1, parseInt(t.repeat, 10) || 1), maxReps);
      const off = ((t.offset % L) + L) % L;
      for (let k = 0; k < reps; k++) this.snaps.push((off + k * region) % L);
    }
    for (const f of [0.25, 0.5, 0.75]) this.snaps.push(f * L);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    e.preventDefault();
  }

  onMove(e) {
    if (!this.dragging || !this.track.buffer) return;
    const x = this.getX(e);
    if (Math.abs(x - this.dragStartX) > 2) this.moved = true;
    const L = this.dragL;
    this._snapAt = null;

    if (this.mode === 'move') {
      let off = this.dragOrigOffset + (x - this.dragStartX) / this.canvas.width * L;
      off = ((off % L) + L) % L;
      const thr = (12 * (window.devicePixelRatio || 1)) / this.canvas.width * L;
      let best = null, bd = thr;
      for (const c of this.snaps) {
        let d = Math.abs(off - c); d = Math.min(d, L - d);
        if (d < bd) { bd = d; best = c; }
      }
      if (best != null) { off = best; this._snapAt = best; }
      this.track.setOffset(off);
    } else if (this.mode === 'loop') {
      const lay = this._layout(L);
      const xc = Math.max(0, this.xToTime(x));
      let rel = xc - lay.off;
      if (rel < 0) rel += L;
      let reps = Math.max(1, Math.round(rel / lay.region));
      reps = Math.min(reps, lay.maxReps);
      this.track.setRepeat(reps >= lay.maxReps ? 'fill' : reps);
    } else if (this.mode === 'trimStart') {
      // Within the block, cycle time and buffer time share the same scale.
      let leftCycle = this.xToTime(x);
      const thr = (12 * (window.devicePixelRatio || 1)) / this.canvas.width * L;
      let best = null, bd = thr;
      for (const c of this.snaps) {
        let d = Math.abs(leftCycle - c); d = Math.min(d, L - d);
        if (d < bd) { bd = d; best = c; }
      }
      if (best != null) { leftCycle = best; this._snapAt = best; }
      const minGap = 0.03;
      let ns = this.dragOrigLoopStart + (leftCycle - this.dragOrigOffset);
      ns = Math.max(0, Math.min(ns, this.track.loopEnd - minGap));
      const applied = ns - this.dragOrigLoopStart;
      this.track.loopStart = ns;
      this.track._procDirty = true;
      let no = this.dragOrigOffset + applied;
      no = ((no % L) + L) % L;
      this.track.offset = no;
    }
    this.draw();
    if (this.onChange) this.onChange(false, this.mode);
  }

  onUp(e) {
    if (!this.dragging) return;
    const mode = this.mode;
    this.dragging = false;
    this.dragL = 0;
    this._snapAt = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
    if (this.track.sourceNode) this.track.playSynced();
    this.draw();
    if (this.onChange) this.onChange(true, mode);
  }
}

// ---------------------------------------------------------------------------
// LooperApp — wires the engine + storage to the DOM.
// ---------------------------------------------------------------------------
class LooperApp {
  constructor() {
    this.engine = new AudioEngine();
    this.trackViews = new Map();
    this.padViews = new Map();
    this.isRecording = false;
    this.recordingSample = null;
    this.started = false;
    this._importTarget = 'loop';

    this.trackListEl = document.getElementById('trackList');
    this.trackTemplate = document.getElementById('trackTemplate');

    this.bindGlobalEvents();
    this._startSeekerLoop();
  }

  // Redraws waveforms each frame while anything is playing so the seeker
  // sweeps along, drives the cycle-progress ring around the record button,
  // and keeps the play/stop button in sync with actual engine state.
  _startSeekerLoop() {
    let wasPlaying = false;
    const ringFg = document.getElementById('ringFg');
    const CIRC = 2 * Math.PI * 46; // matches the SVG circle radius
    const tick = () => {
      const e = this.engine;
      const playing = e.tracks.some((t) => t.sourceNode);
      if (playing || wasPlaying) {
        this.trackViews.forEach((v) => { v.lane.draw(); v.editor.draw(); });
        this.updatePlayStopButton();
      }
      let p = 0;
      if (playing && e.timelineStart != null && e.audioContext) {
        const L = e.masterLen();
        if (L > 0) {
          p = ((((e.audioContext.currentTime - e.timelineStart) % L) + L) % L) / L;
        }
      }
      ringFg.style.strokeDashoffset = String(CIRC * (1 - p));
      wasPlaying = playing;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  bindGlobalEvents() {
    document.getElementById('btnEnable').addEventListener('click', () => this.ensureStarted());
    document.getElementById('btnRecord').addEventListener('click', () => this.toggleRecord());

    document.getElementById('btnPlayStop').addEventListener('click', async () => {
      await this.ensureStarted();
      if (this.engine.anyPlaying()) this.engine.stopAll();
      else this.engine.playAll();
      this.updatePlayStopButton();
    });

    const menu = document.getElementById('menu');
    const closeMenu = () => menu.classList.add('hidden');
    document.getElementById('btnMenu').addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', (ev) => {
      if (!menu.classList.contains('hidden') && !menu.contains(ev.target)) closeMenu();
    });

    const fileInput = document.getElementById('fileImport');
    const openImport = (target) => async () => {
      closeMenu();
      await this.ensureStarted();
      this._importTarget = target;
      fileInput.click();
    };
    document.getElementById('menuImportLoop').addEventListener('click', openImport('loop'));
    document.getElementById('menuImportSample').addEventListener('click', openImport('sample'));
    document.getElementById('emptyImport').addEventListener('click', openImport('loop'));
    document.getElementById('menuFix').addEventListener('click', async () => {
      closeMenu();
      await this.ensureStarted();
      await this.engine.recoverAudio();
      this.flashMessage('Audio path rebuilt');
    });
    document.getElementById('menuClear').addEventListener('click', () => {
      closeMenu();
      this.clearSession();
    });

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (!files.length) return;
      if (this._importTarget === 'sample') await this.importFilesAsSamples(files);
      else await this.importFiles(files);
    });

    // Sampler: add-pad button + the sample editor sheet (bound once; the
    // sheet's WaveformEditor is reused across samples by swapping .track).
    document.getElementById('padAdd').addEventListener('click', async () => {
      await this.ensureStarted();
      if (this.engine.samples.length >= 16) { this.flashMessage('Pad bank is full'); return; }
      const s = new Sample(this.engine, { slot: this._nextPadSlot() });
      this.engine.samples.push(s);
      this.renderPadBank();
      const view = this.padViews.get(s.id);
      if (view) view.slot.scrollIntoView({ behavior: 'smooth', inline: 'end' });
    });
    this._bindSampleSheet();

    // Diagnostics are hidden by default — tap the version badge to peek.
    document.getElementById('versionBadge').addEventListener('click', () => {
      document.getElementById('diag').classList.toggle('hidden');
    });

    window.addEventListener('resize', () => {
      this.trackViews.forEach((v) => { v.editor.resizeAndDraw(); v.lane.resizeAndDraw(); });
      if (this._sheetSample) this._sheetEditor.resizeAndDraw();
    });
  }

  updatePlayStopButton() {
    const b = document.getElementById('btnPlayStop');
    const playing = this.engine.anyPlaying();
    b.textContent = playing ? '■' : '▶';
    b.classList.toggle('active', playing);
  }

  updateEmptyState() {
    document.getElementById('emptyState').classList.toggle('hidden', this.trackViews.size > 0);
  }

  async ensureStarted() {
    if (this.started) return;
    const errorEl = document.getElementById('splashError');
    const enableBtn = document.getElementById('btnEnable');
    errorEl.textContent = '';
    enableBtn.disabled = true;
    try {
      await this.engine.init();
    } catch (err) {
      errorEl.textContent = 'Audio startup failed: ' + err.message + ' — close and reopen the app, then try again.';
      enableBtn.disabled = false;
      throw err;
    }
    this.started = true;
    this.engine.onLevelUpdate = (level) => this.updateLevelMeter(level);
    document.getElementById('splash').classList.add('hidden');
    this._startDiagnostics();
    await this.restoreSession();
  }

  // Live status line (tiny, bottom of the transport): shows what iOS is
  // doing to the audio path so routing problems can be reported precisely.
  _startDiagnostics() {
    const el = document.getElementById('diag');
    if (!el || this._diagTimer) return;
    this._diagTimer = setInterval(() => {
      const e = this.engine;
      if (!e.audioContext) return;
      const sess = 'audioSession' in navigator ? navigator.audioSession.type : 'n/a';
      const rec = e.capturing ? 'REC' : 'idle';
      const err = this._lastError ? ` · err:${this._lastError}` : '';
      el.textContent =
        `out:${e.audioContext.state} · ${rec} · session:${sess} · cycle:${e.masterLen().toFixed(2)}s${err}`;
    }, 500);
  }

  async toggleRecord() {
    try {
      await this.ensureStarted();
    } catch (err) {
      return;
    }
    const btn = document.getElementById('btnRecord');

    const transport = document.getElementById('transport');
    if (!this.isRecording) {
      // The mic pipeline is shared with pad recording — one take at a time.
      if (this.engine.capturing) {
        this.flashMessage('Finish the sample recording first');
        return;
      }
      const track = this.engine.createTrack();
      this._pendingTrack = track;
      this.isRecording = true;
      btn.classList.add('recording');
      transport.classList.add('rec');
      btn.setAttribute('aria-label', 'Stop recording');
      try {
        await this.engine.startRecording(track);
      } catch (err) {
        this.isRecording = false;
        btn.classList.remove('recording');
        transport.classList.remove('rec');
        btn.setAttribute('aria-label', 'Start recording');
        this.engine.removeTrack(track);
        this._pendingTrack = null;
        this.flashMessage('Could not access microphone — check Safari mic permission');
      }
    } else {
      btn.classList.remove('recording');
      transport.classList.remove('rec');
      btn.setAttribute('aria-label', 'Start recording');
      this.isRecording = false;
      const track = await this.engine.stopRecording();
      this._pendingTrack = null;

      // Track may have been deleted (Clear/Delete) while recording ran.
      if (!track || !this.engine.tracks.includes(track)) return;
      if (!track.buffer || track.buffer.duration < 0.12) {
        this.engine.removeTrack(track);
        this.flashMessage('Recording too short — try again');
        return;
      }

      this.addTrackView(track);
      // A new longest take grows the master cycle for everyone.
      this.cycleChanged();
      // Other loops were never interrupted — the new one just joins in.
      this.engine.playTrack(track);
      this.persistTrack(track);
    }
  }

  // Decode any audio file to a mono AudioBuffer matching the recording
  // pipeline and storage format.
  async _decodeFileToMono(file) {
    const arrayBuf = await file.arrayBuffer();
    const decoded = await this.engine.audioContext.decodeAudioData(arrayBuf);
    const len = decoded.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i];
    }
    if (decoded.numberOfChannels > 1) {
      const scale = 1 / decoded.numberOfChannels;
      for (let i = 0; i < len; i++) mono[i] *= scale;
    }
    const buf = this.engine.audioContext.createBuffer(1, Math.max(1, len), decoded.sampleRate);
    buf.copyToChannel(mono, 0);
    return buf;
  }

  async importFiles(files) {
    let imported = 0;
    for (const file of files) {
      try {
        const buf = await this._decodeFileToMono(file);
        const track = this.engine.createTrack();
        track.name = file.name.replace(/\.[^.]+$/, '').slice(0, 30) || track.name;
        track.setBuffer(buf);
        this.addTrackView(track);
        this.persistTrack(track);
        imported++;
      } catch (err) {
        console.error('import failed', file.name, err);
        this.flashMessage(`Couldn't import ${file.name} — unsupported format?`);
      }
    }
    if (imported) {
      this.cycleChanged();
      this.flashMessage(`Imported ${imported} file(s) — trim the loop region, then hit play`);
    }
  }

  async importFilesAsSamples(files) {
    let imported = 0;
    for (const file of files) {
      try {
        const buf = await this._decodeFileToMono(file);
        // Reuse the first empty pad; add a new one if the bank is all filled.
        let sample = this.engine.samples.find((s) => !s.buffer);
        if (!sample) {
          if (this.engine.samples.length >= 16) { this.flashMessage('Pad bank is full'); break; }
          sample = new Sample(this.engine, { slot: this._nextPadSlot() });
          this.engine.samples.push(sample);
        }
        sample.name = file.name.replace(/\.[^.]+$/, '').slice(0, 30) || sample.name;
        sample.setBuffer(buf);
        this.persistSample(sample);
        imported++;
      } catch (err) {
        console.error('sample import failed', file.name, err);
        this.flashMessage(`Couldn't import ${file.name} — unsupported format?`);
      }
    }
    if (imported) {
      this.renderPadBank();
      this.flashMessage(`Imported ${imported} sample(s) — tap a pad to play`);
    }
  }

  // -------------------------------------------------------------------------
  // Sampler: pad bank + editor sheet
  // Pad gestures: tap empty = record · tap filled = play · hold = edit ·
  // drag a filled pad onto the track list = add to the arrangement.
  // -------------------------------------------------------------------------

  persistSample(sample) {
    if (!sample.buffer) return;
    Storage.saveSample(sample.toStorageRecord()).catch((e) => console.error('sample save failed', e));
  }

  // Slots must be unique — they're the persisted sort key for the bank.
  _nextPadSlot() {
    return this.engine.samples.reduce((m, s) => Math.max(m, s.slot + 1), 0);
  }

  renderPadBank() {
    const bank = document.getElementById('padBank');
    bank.innerHTML = '';
    this.padViews.clear();
    for (const sample of this.engine.samples) this._renderPad(bank, sample);
  }

  _updatePadUI(sample) {
    const view = this.padViews.get(sample.id);
    if (!view) return;
    const recording = this.recordingSample === sample;
    view.pad.classList.toggle('filled', !!sample.buffer && !recording);
    view.pad.classList.toggle('recording', recording);
    view.pad.textContent = recording ? '■' : sample.buffer ? '▶' : '＋';
    view.pad.style.setProperty('--pcolor', sample.color);
    view.nameEl.textContent = sample.name;
    view.nameEl.classList.toggle('set', !!sample.buffer);
  }

  _renderPad(bank, sample) {
    const slot = document.createElement('div');
    slot.className = 'pad-slot';
    const pad = document.createElement('button');
    pad.className = 'pad';
    const nameEl = document.createElement('div');
    nameEl.className = 'pad-name';
    slot.appendChild(pad);
    slot.appendChild(nameEl);
    bank.appendChild(slot);
    this.padViews.set(sample.id, { slot, pad, nameEl });
    this._updatePadUI(sample);
    this._bindPadInteractions(pad, sample);
  }

  _bindPadInteractions(pad, sample) {
    const HOLD_MS = 480;
    const DRAG_PX = 12;
    const ghost = document.getElementById('dragGhost');

    pad.addEventListener('pointerdown', (e) => {
      let holdFired = false;
      let dragMode = false;
      const startX = e.clientX;
      const startY = e.clientY;
      try { pad.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }

      // Long-press → edit sheet (filled pads only).
      const holdTimer = setTimeout(() => {
        if (dragMode || !sample.buffer) return;
        holdFired = true;
        this.openSampleSheet(sample);
      }, HOLD_MS);

      let cancelled = false;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragMode && !cancelled && Math.hypot(dx, dy) > DRAG_PX) {
          clearTimeout(holdTimer);
          if (!sample.buffer || this.recordingSample) {
            // Not draggable — this movement is a scroll/graze, never a tap.
            cancelled = true;
            return;
          }
          dragMode = true;
          ghost.textContent = `▶ ${sample.name}`;
          ghost.classList.remove('hidden');
        }
        if (dragMode) {
          ghost.style.left = `${ev.clientX + 12}px`;
          ghost.style.top = `${ev.clientY - 14}px`;
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const overTracks = !!(under && under.closest('#trackList, .track-card, #emptyState'));
          this.trackListEl.classList.toggle('drop-target', overTracks);
        }
      };

      const onUp = (ev) => {
        clearTimeout(holdTimer);
        pad.removeEventListener('pointermove', onMove);
        pad.removeEventListener('pointerup', onUp);
        pad.removeEventListener('pointercancel', onCancel);
        if (dragMode) {
          ghost.classList.add('hidden');
          const wasOver = this.trackListEl.classList.contains('drop-target');
          this.trackListEl.classList.remove('drop-target');
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          if (wasOver || (under && under.closest('#trackList, .track-card, #emptyState'))) {
            this.addSampleToArrangement(sample);
          }
          return;
        }
        if (holdFired || cancelled) return;
        // Plain tap.
        if (this.recordingSample === sample || !sample.buffer) {
          this.toggleSampleRecord(sample);
        } else {
          this.engine.playSample(sample);
          pad.classList.add('active');
          setTimeout(() => pad.classList.remove('active'), 140);
        }
      };

      const onCancel = () => {
        clearTimeout(holdTimer);
        ghost.classList.add('hidden');
        this.trackListEl.classList.remove('drop-target');
        pad.removeEventListener('pointermove', onMove);
        pad.removeEventListener('pointerup', onUp);
        pad.removeEventListener('pointercancel', onCancel);
      };

      pad.addEventListener('pointermove', onMove);
      pad.addEventListener('pointerup', onUp);
      pad.addEventListener('pointercancel', onCancel);
    });
  }

  async toggleSampleRecord(sample) {
    try {
      await this.ensureStarted();
    } catch (err) {
      return;
    }
    const transport = document.getElementById('transport');
    if (this.recordingSample === sample) {
      // Stop this pad's take.
      const buf = await this.engine.stopCapture();
      this.recordingSample = null;
      transport.classList.remove('rec');
      this._updatePadUI(sample);
      if (!buf || buf.duration < 0.05) {
        this.flashMessage('Recording too short — try again');
        return;
      }
      sample.setBuffer(buf);
      this._updatePadUI(sample);
      this.persistSample(sample);
      return;
    }
    if (this.engine.capturing || this.isRecording) {
      this.flashMessage('Already recording — stop that first');
      return;
    }
    try {
      await this.engine.startCapture();
    } catch (err) {
      this.flashMessage('Could not access microphone — check Safari mic permission');
      return;
    }
    this.recordingSample = sample;
    transport.classList.add('rec'); // shows the input level meter
    this._updatePadUI(sample);
  }

  // Turn the pad's trimmed region into a regular track in the arrangement.
  addSampleToArrangement(sample) {
    if (!sample.buffer) return;
    const { out, sr } = sample.renderRegion();
    const buf = this.engine.audioContext.createBuffer(1, out.length, sr);
    buf.copyToChannel(out, 0);
    const track = this.engine.createTrack();
    track.name = sample.name;
    track.setBuffer(buf);
    const hadCycle = this.engine.masterLen() > 0 &&
      this.engine.tracks.some((t) => t !== track && t.buffer);
    if (hadCycle) {
      // Joining an existing cycle: land as a one-shot at the live playhead
      // (or 0 when stopped) instead of tiling over everything.
      track.setRepeat(1);
      const e = this.engine;
      if (e.timelineStart != null && e.audioContext) {
        const L = e.masterLen();
        if (L > 0) {
          const pos = (((e.audioContext.currentTime - e.timelineStart) % L) + L) % L;
          track.setOffset(pos);
        }
      }
    }
    this.addTrackView(track);
    this.cycleChanged();
    this.persistTrack(track);
    if (this.engine.anyPlaying()) track.playSynced();
    this.flashMessage(`"${sample.name}" added to the arrangement`);
  }

  _bindSampleSheet() {
    const sheet = document.getElementById('sampleSheet');
    const nameInput = document.getElementById('sampleName');
    const volSlider = document.getElementById('sampleVol');
    const waveCanvas = document.getElementById('sampleWave');

    // One editor for the sheet's lifetime; .track is swapped per sample.
    // The placeholder needs the fields the editor's cache key reads.
    this._sheetEditor = new WaveformEditor(
      waveCanvas,
      { buffer: null, loopStart: 0, loopEnd: 0, playheadTime: () => null },
      (final) => { if (final && this._sheetSample) this.persistSample(this._sheetSample); }
    );

    const close = () => {
      sheet.classList.add('hidden');
      if (this._sheetSample) {
        this._sheetSample.stop();
        this._updatePadUI(this._sheetSample);
      }
      this._sheetSample = null;
    };
    document.getElementById('sampleClose').addEventListener('click', close);
    sheet.addEventListener('click', (ev) => { if (ev.target === sheet) close(); });

    document.getElementById('samplePlay').addEventListener('click', () => {
      if (this._sheetSample) this.engine.playSample(this._sheetSample);
    });

    nameInput.addEventListener('change', () => {
      const s = this._sheetSample;
      if (!s) return;
      s.name = nameInput.value || s.name;
      this._updatePadUI(s);
      this.persistSample(s);
    });

    volSlider.addEventListener('input', () => {
      if (this._sheetSample) this._sheetSample.volume = parseFloat(volSlider.value);
    });
    volSlider.addEventListener('change', () => {
      if (this._sheetSample) this.persistSample(this._sheetSample);
    });

    document.getElementById('sampleToTrack').addEventListener('click', () => {
      const s = this._sheetSample;
      if (!s) return;
      close();
      this.addSampleToArrangement(s);
    });

    document.getElementById('sampleDownload').addEventListener('click', () => {
      const s = this._sheetSample;
      if (!s || !s.buffer) return;
      const { out, sr } = s.renderRegion();
      const blob = encodeWav(out, sr);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${s.name.replace(/\s+/g, '_')}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });

    document.getElementById('sampleDelete').addEventListener('click', async () => {
      const s = this._sheetSample;
      if (!s) return;
      if (!(await this.appConfirm(`Delete sample "${s.name}"?`))) return;
      s.stop();
      s.buffer = null;
      s.loopStart = 0;
      s.loopEnd = 0;
      s.name = `Pad ${s.slot + 1}`;
      Storage.deleteSample(s.id).catch((e) => console.error(e));
      close();
      this._updatePadUI(s);
    });
  }

  openSampleSheet(sample) {
    this._sheetSample = sample;
    document.getElementById('sampleName').value = sample.name;
    document.getElementById('sampleVol').value = sample.volume;
    this._sheetEditor.track = sample;
    document.getElementById('sampleSheet').classList.remove('hidden');
    requestAnimationFrame(() => this._sheetEditor.resizeAndDraw());
  }

  updateLevelMeter(level) {
    const bar = document.getElementById('levelMeterFill');
    if (bar) bar.style.width = `${Math.min(100, Math.round(level * 130))}%`;
  }

  // Styled in-app replacement for confirm() — resolves true/false.
  appConfirm(message, okLabel = 'Delete') {
    return new Promise((resolve) => {
      const dlg = document.getElementById('confirmDlg');
      const ok = document.getElementById('confirmOk');
      const cancel = document.getElementById('confirmCancel');
      document.getElementById('confirmMsg').textContent = message;
      ok.textContent = okLabel;
      const done = (val) => {
        dlg.classList.add('hidden');
        ok.onclick = cancel.onclick = dlg.onclick = null;
        resolve(val);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      dlg.onclick = (ev) => { if (ev.target === dlg) done(false); };
      dlg.classList.remove('hidden');
    });
  }

  flashMessage(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  persistTrack(track) {
    Storage.saveTrack(track.toStorageRecord()).catch((e) => console.error('save failed', e));
  }

  formatTime(t) {
    return `${t.toFixed(2)}s`;
  }

  addTrackView(track) {
    const node = this.trackTemplate.content.firstElementChild.cloneNode(true);
    this.trackListEl.appendChild(node);

    if (!track.color) track.color = TRACK_PALETTE[track.order % TRACK_PALETTE.length];
    node.style.setProperty('--tcolor', track.color);

    const nameInput = node.querySelector('.track-name');
    const lenEl = node.querySelector('.track-len');
    const expandBtn = node.querySelector('.btn-expand');
    const muteBtn = node.querySelector('.btn-mute');
    const soloBtn = node.querySelector('.btn-solo');
    const deleteBtn = node.querySelector('.btn-delete');
    const downloadBtn = node.querySelector('.btn-download');
    const volumeSlider = node.querySelector('.track-volume');
    const canvas = node.querySelector('.track-waveform');
    const laneCanvas = node.querySelector('.track-lane');
    const infoEl = node.querySelector('.track-loop-info');
    const nudges = node.querySelectorAll('.nudge');
    const resetBtn = node.querySelector('.btn-reset-loop');
    const offsetInfo = node.querySelector('.track-offset-info');
    const fadeSlider = node.querySelector('.track-fade');
    const fadeInfo = node.querySelector('.track-fade-info');
    const repeatSel = node.querySelector('.track-repeat');

    nameInput.value = track.name;
    volumeSlider.value = track.volume;
    if (track.muted) muteBtn.classList.add('active');
    fadeSlider.value = track.fade;
    repeatSel.value = String(track.repeat);

    const updateInfo = () => {
      this.updateLoopInfo(infoEl, track);
      lenEl.textContent = `${(track.loopEnd - track.loopStart).toFixed(2)}s`;
    };
    const updateOffsetInfo = () => {
      offsetInfo.textContent = `@${track.offset.toFixed(2)}s`;
    };
    const updateFadeInfo = () => {
      fadeInfo.textContent = `${Math.round(track.fade * 1000)}ms`;
    };
    const refreshTiming = () => {
      updateOffsetInfo();
      if (lane) lane.draw();
    };
    // Re-render + re-join a playing track after its placement/blend changed.
    const resync = () => {
      if (track.sourceNode) track.playSynced();
    };
    updateFadeInfo();

    // Trim: drag the waveform edges. Live-updates the arrange lane block.
    const editor = new WaveformEditor(canvas, track, (final) => {
      updateInfo();
      lane.draw();
      if (final) {
        this.cycleChanged(); // trimming can change the master cycle length
        this.persistTrack(track);
      }
    });

    // Arrange: drag body = move, right edge = repeats, left edge = trim front.
    const lane = new TimelineLane(laneCanvas, track, this, (final, mode) => {
      updateOffsetInfo();
      repeatSel.value = String(track.repeat);
      if (mode === 'trimStart') { updateInfo(); editor.draw(); }
      if (final) {
        if (mode === 'trimStart') this.cycleChanged(); // region changed
        else refreshTiming();
        this.persistTrack(track);
      }
    });

    this.trackViews.set(track.id, { root: node, editor, lane, refreshTiming });

    refreshTiming();
    requestAnimationFrame(() => { editor.resizeAndDraw(); lane.resizeAndDraw(); });
    updateInfo();
    this.updateEmptyState();

    // One-time hint the first time a loop exists.
    if (this.trackViews.size === 1 && !this._laneHintShown) {
      this._laneHintShown = true;
      this.flashMessage('Drag the waveform edges to trim · drag the bar to move & loop');
    }

    expandBtn.addEventListener('click', () => node.classList.toggle('open'));

    // Drag the grip to reorder cards. Purely visual/order metadata — the
    // audio graph doesn't care about display order.
    const grip = node.querySelector('.track-grip');
    grip.style.touchAction = 'none';
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
      node.classList.add('dragging');

      const onMove = (ev) => {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const target = under && under.closest('.track-card');
        if (!target || target === node || target.parentElement !== this.trackListEl) return;
        const r = target.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) this.trackListEl.insertBefore(node, target);
        else this.trackListEl.insertBefore(node, target.nextSibling);
      };

      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
        node.classList.remove('dragging');
        // Commit the new visual order to track.order + storage.
        const cards = Array.from(this.trackListEl.children);
        this.trackViews.forEach((view, id) => {
          const t = this.engine.tracks.find((tr) => tr.id === id);
          if (!t) return;
          const idx = cards.indexOf(view.root);
          if (idx >= 0 && t.order !== idx) {
            t.order = idx;
            this.persistTrack(t);
          }
        });
      };

      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
    });

    nameInput.addEventListener('change', () => {
      track.name = nameInput.value || track.name;
      this.persistTrack(track);
    });

    muteBtn.addEventListener('click', () => {
      track.setMuted(!track.muted);
      muteBtn.classList.toggle('active', track.muted);
      this.persistTrack(track);
    });

    soloBtn.addEventListener('click', () => {
      track.setSolo(!track.solo);
      soloBtn.classList.toggle('active', track.solo);
    });

    deleteBtn.addEventListener('click', async () => {
      if (!(await this.appConfirm(`Delete "${track.name}"?`))) return;
      this.engine.removeTrack(track);
      this.trackViews.delete(track.id);
      node.remove();
      this.cycleChanged();
      this.updateEmptyState();
      Storage.deleteTrack(track.id).catch((e) => console.error(e));
    });

    downloadBtn.addEventListener('click', () => this.downloadTrackWav(track));

    volumeSlider.addEventListener('input', () => {
      track.setVolume(parseFloat(volumeSlider.value));
    });
    volumeSlider.addEventListener('change', () => this.persistTrack(track));

    nudges.forEach((btn) => {
      const edge = btn.dataset.edge;
      const delta = parseFloat(btn.dataset.delta);
      this.bindHold(btn, () => {
        if (edge === 'offset') {
          track.setOffset(track.offset + delta);
          updateOffsetInfo();
          lane.draw();
        } else if (edge === 'start') {
          track.setLoopPoints(track.loopStart + delta, track.loopEnd);
        } else {
          track.setLoopPoints(track.loopStart, track.loopEnd + delta);
        }
        editor.draw();
        updateInfo();
        this.scheduleResync();
        this.schedulePersist(track);
      });
    });

    repeatSel.addEventListener('change', () => {
      track.setRepeat(repeatSel.value);
      lane.draw();
      resync();
      this.persistTrack(track);
    });

    fadeSlider.addEventListener('input', () => {
      track.setFade(parseFloat(fadeSlider.value));
      updateFadeInfo();
    });
    fadeSlider.addEventListener('change', () => {
      resync();
      this.persistTrack(track);
    });

    resetBtn.addEventListener('click', () => {
      track.setLoopPoints(0, track.buffer.duration);
      track.setOffset(0);
      track.setRepeat('fill');
      repeatSel.value = 'fill';
      editor.draw();
      updateInfo();
      this.cycleChanged();
      this.persistTrack(track);
    });
  }

  // Anything that can alter the master cycle length (add/remove/trim a
  // track) re-renders all cycle buffers and refreshes every Place slider.
  cycleChanged() {
    this.engine.resyncAll();
    this.trackViews.forEach((v) => v.refreshTiming && v.refreshTiming());
  }

  // Debounced flavour for rapid-fire adjustments (held nudge buttons):
  // labels update instantly, the audio re-render lands once, 200ms after
  // the last tap — no per-click glitching.
  scheduleResync() {
    clearTimeout(this._resyncTimer);
    this._resyncTimer = setTimeout(() => this.cycleChanged(), 200);
  }

  schedulePersist(track) {
    clearTimeout(track._persistTimer);
    track._persistTimer = setTimeout(() => this.persistTrack(track), 400);
  }

  // Fire on tap, auto-repeat while held — fine 0.01s steps that still
  // allow fast coarse moves.
  bindHold(btn, fire) {
    let holdTimer = null;
    let repeatTimer = null;
    let usedPointer = false;
    btn.addEventListener('pointerdown', () => {
      usedPointer = true;
      let repeated = false;
      // Single taps fire on RELEASE (so a scroll that starts on the button
      // cancels cleanly instead of misfiring); holding fires repeatedly.
      holdTimer = setTimeout(() => {
        repeated = true;
        fire();
        repeatTimer = setInterval(fire, 110);
      }, 380);
      const cleanup = () => {
        clearTimeout(holdTimer);
        clearInterval(repeatTimer);
        btn.removeEventListener('pointerup', tap);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
      };
      const tap = () => {
        if (!repeated) fire();
        cleanup();
      };
      btn.addEventListener('pointerup', tap);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
    });
    btn.addEventListener('click', (ev) => {
      if (usedPointer) { usedPointer = false; ev.preventDefault(); return; }
      fire(); // keyboard activation
    });
  }

  updateLoopInfo(infoEl, track) {
    const len = track.loopEnd - track.loopStart;
    infoEl.textContent = `${this.formatTime(track.loopStart)} – ${this.formatTime(track.loopEnd)}  (${this.formatTime(len)} loop)`;
  }

  downloadTrackWav(track) {
    if (!track.buffer) return;
    // Export the trimmed region with its crossfade — not the whole cycle,
    // which for a sparsely placed loop would be mostly silence.
    const { out, sr } = track._renderRegion();
    const blob = encodeWav(out, sr);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${track.name.replace(/\s+/g, '_')}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async restoreSession() {
    let records = [];
    try {
      records = await Storage.loadAllTracks();
    } catch (e) {
      console.error('restore failed', e);
      return;
    }
    for (const rec of records) {
      if (!rec.channelData) continue;
      const track = new Track(this.engine, {
        id: rec.id,
        order: rec.order,
        name: rec.name,
        volume: rec.volume,
        muted: rec.muted,
        fade: rec.fade,
        offset: rec.offset,
        repeat: rec.repeat,
        color: rec.color,
      });
      const floatArr = new Float32Array(rec.channelData);
      const buf = this.engine.audioContext.createBuffer(1, Math.max(1, floatArr.length), rec.sampleRate);
      buf.copyToChannel(floatArr, 0);
      track.buffer = buf;
      track.loopStart = rec.loopStart;
      track.loopEnd = rec.loopEnd;
      track.applyGain();
      this.engine.tracks.push(track);
      this.addTrackView(track);
    }
    if (records.length) {
      this.cycleChanged();
      this.flashMessage(`Restored ${records.length} track(s)`);
    }
    await this.restoreSamples();
  }

  async restoreSamples() {
    let records = [];
    try {
      records = await Storage.loadAllSamples();
    } catch (e) {
      console.error('sample restore failed', e);
    }
    for (const rec of records) {
      if (!rec.channelData) continue;
      const sample = new Sample(this.engine, {
        id: rec.id,
        slot: rec.slot,
        name: rec.name,
        color: rec.color,
        volume: rec.volume,
      });
      const floatArr = new Float32Array(rec.channelData);
      const buf = this.engine.audioContext.createBuffer(1, Math.max(1, floatArr.length), rec.sampleRate);
      buf.copyToChannel(floatArr, 0);
      sample.buffer = buf;
      sample.loopStart = rec.loopStart;
      sample.loopEnd = rec.loopEnd;
      this.engine.samples.push(sample);
    }
    // Always show a few ready-to-record pads.
    while (this.engine.samples.length < 4) {
      this.engine.samples.push(new Sample(this.engine, { slot: this.engine.samples.length }));
    }
    this.renderPadBank();
  }

  async clearSession() {
    if (!this.engine.tracks.length && !this.engine.samples.some((s) => s.buffer)) return;
    if (!(await this.appConfirm('Delete all tracks and samples? This cannot be undone.', 'Delete all'))) return;
    this.engine.stopAll();
    for (const t of [...this.engine.tracks]) this.engine.removeTrack(t);
    this.trackListEl.innerHTML = '';
    this.trackViews.clear();
    this.engine.samples.forEach((s) => s.stop());
    this.engine.samples = [];
    while (this.engine.samples.length < 4) {
      this.engine.samples.push(new Sample(this.engine, { slot: this.engine.samples.length }));
    }
    this.renderPadBank();
    this.updateEmptyState();
    this.updatePlayStopButton();
    await Storage.clearAll();
    this.flashMessage('Session cleared');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.app-version').forEach((el) => { el.textContent = 'v' + APP_VERSION; });
  window.looperApp = new LooperApp();

  // Surface errors instead of dying silently — a short toast for the user,
  // and the full message parked in the diag line (tap the version badge).
  const reportError = (msg) => {
    const app = window.looperApp;
    if (!app) return;
    app._lastError = String(msg).slice(0, 200);
    app.flashMessage('Something went wrong — tap the version badge for details');
    console.error('[looper]', msg);
  };
  window.addEventListener('error', (ev) => reportError(ev.message || ev.error || 'Unknown error'));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason && (ev.reason.message || ev.reason) || 'Unhandled rejection'));

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    });
  }
});
