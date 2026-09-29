class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(4096); this.offset = 0; this.total = 0; this.finished = false;
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (!this.offset) return;
    const samples = this.buffer.slice(0, this.offset); this.offset = 0;
    this.port.postMessage({ samples }, [samples.buffer]);
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input && !this.finished) for (const value of input) {
      if (this.total >= sampleRate*60) { this.finished = true; this.flush(); this.port.postMessage({ limit: true }); break; }
      this.buffer[this.offset++] = value; this.total++;
      if (this.offset === this.buffer.length) this.flush();
    }
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}
registerProcessor('muse-pcm-capture', PcmCapture);
