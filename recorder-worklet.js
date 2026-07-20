// AudioWorkletProcessor that buffers raw mic PCM and posts chunks to the
// main thread so we can build a sample-accurate AudioBuffer for looping.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.recording = true;
        this.writeIndex = 0;
      } else if (event.data === 'stop') {
        this.recording = false;
        this.flush();
      }
    };
  }

  flush() {
    if (this.writeIndex > 0) {
      const chunk = this.buffer.slice(0, this.writeIndex);
      this.port.postMessage(chunk, [chunk.buffer]);
      this.writeIndex = 0;
    }
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.writeIndex++] = channel[i];
        if (this.writeIndex >= this.bufferSize) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
