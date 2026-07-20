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

// Accent colors cycled across tracks (dot, waveform tint, sliders).
const TRACK_PALETTE = ['#6ee7ff', '#f0abfc', '#86efac', '#fcd34d', '#fda4af', '#a5b4fc', '#5eead4', '#fdba74'];

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
    this.recordingTrack = null;
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
      if (this._captureAnalyser && this.recordingTrack) {
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
    if (!this.recordingTrack) return;
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

  async startRecording(track) {
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
    this.recordingTrack = track;
    // Remember WHERE in the running cycle this take began, so the new loop
    // defaults to playing back at the position it was performed at.
    const L = this.masterLen();
    this._recStartOffset = (this.timelineStart != null && L > 0)
      ? (((this.audioContext.currentTime - this.timelineStart) % L) + L) % L
      : null;
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

  async stopRecording() {
    if (this._recWatchdog) {
      clearInterval(this._recWatchdog);
      this._recWatchdog = null;
    }
    if (!this.recordingTrack) {
      this._releaseMic();
      return null;
    }
    this._captureNode.port.postMessage('stop');
    // Give the worklet a moment to flush its final chunk over the port.
    await new Promise((r) => setTimeout(r, 150));

    const track = this.recordingTrack;
    this.recordingTrack = null;
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

  stopAll() {
    this.tracks.forEach((t) => t.stop());
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
    this.canvas.setPointerCapture(e.pointerId);
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
// LooperApp — wires the engine + storage to the DOM.
// ---------------------------------------------------------------------------
class LooperApp {
  constructor() {
    this.engine = new AudioEngine();
    this.trackViews = new Map();
    this.isRecording = false;
    this.started = false;

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
        this.trackViews.forEach((v) => v.editor.draw());
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
    const openImport = async () => {
      closeMenu();
      await this.ensureStarted();
      fileInput.click();
    };
    document.getElementById('menuImport').addEventListener('click', openImport);
    document.getElementById('emptyImport').addEventListener('click', openImport);
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
      if (files.length) await this.importFiles(files);
    });

    // Diagnostics are hidden by default — tap the version badge to peek.
    document.getElementById('versionBadge').addEventListener('click', () => {
      document.getElementById('diag').classList.toggle('hidden');
    });

    window.addEventListener('resize', () => {
      this.trackViews.forEach((v) => v.editor.resizeAndDraw());
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
      const rec = e.recordingTrack ? 'REC' : 'idle';
      el.textContent =
        `out:${e.audioContext.state} · ${rec} · session:${sess} · cycle:${e.masterLen().toFixed(2)}s`;
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

  async importFiles(files) {
    let imported = 0;
    for (const file of files) {
      try {
        const arrayBuf = await file.arrayBuffer();
        const decoded = await this.engine.audioContext.decodeAudioData(arrayBuf);
        // Mix down to mono to match the recording pipeline and storage format.
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

  updateLevelMeter(level) {
    const bar = document.getElementById('levelMeterFill');
    if (bar) bar.style.width = `${Math.min(100, Math.round(level * 130))}%`;
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

    track.color = TRACK_PALETTE[track.order % TRACK_PALETTE.length];
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
    const infoEl = node.querySelector('.track-loop-info');
    const nudges = node.querySelectorAll('.nudge');
    const resetBtn = node.querySelector('.btn-reset-loop');
    const offsetInfo = node.querySelector('.track-offset-info');
    const fadeSlider = node.querySelector('.track-fade');
    const fadeInfo = node.querySelector('.track-fade-info');
    const posSlider = node.querySelector('.track-pos');
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
    // Keep the Place slider spanning the current master cycle length.
    const refreshTiming = () => {
      const L = Math.max(this.engine.masterLen(), 0.01);
      posSlider.max = L.toFixed(2);
      if (!this._draggingPos) posSlider.value = Math.min(track.offset, L);
      updateOffsetInfo();
    };
    // Re-render + re-join a playing track after its placement/blend changed.
    const resync = () => {
      if (track.sourceNode) track.playSynced();
    };
    refreshTiming();
    updateFadeInfo();

    const editor = new WaveformEditor(canvas, track, (final) => {
      updateInfo();
      if (final) {
        this.cycleChanged(); // trimming can change the master cycle length
        this.persistTrack(track);
      }
    });

    this.trackViews.set(track.id, { root: node, editor, refreshTiming });

    requestAnimationFrame(() => editor.resizeAndDraw());
    updateInfo();
    this.updateEmptyState();

    expandBtn.addEventListener('click', () => node.classList.toggle('open'));

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

    deleteBtn.addEventListener('click', () => {
      if (!confirm(`Delete "${track.name}"?`)) return;
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
          refreshTiming();
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

    posSlider.addEventListener('input', () => {
      this._draggingPos = true;
      offsetInfo.textContent = `@${parseFloat(posSlider.value).toFixed(2)}s`;
    });
    posSlider.addEventListener('change', () => {
      this._draggingPos = false;
      track.setOffset(parseFloat(posSlider.value));
      refreshTiming();
      resync();
      this.persistTrack(track);
    });

    repeatSel.addEventListener('change', () => {
      track.setRepeat(repeatSel.value);
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
  }

  async clearSession() {
    if (!this.engine.tracks.length) return;
    if (!confirm('Delete all tracks? This cannot be undone.')) return;
    this.engine.stopAll();
    for (const t of [...this.engine.tracks]) this.engine.removeTrack(t);
    this.trackListEl.innerHTML = '';
    this.trackViews.clear();
    this.updateEmptyState();
    this.updatePlayStopButton();
    await Storage.clearAll();
    this.flashMessage('Session cleared');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.looperApp = new LooperApp();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    });
  }
});
