export class Recorder {
  constructor() {
    this.mediaRecorder = null;
    this.chunks = [];
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mediaRecorder = new MediaRecorder(stream);

    this.chunks = [];
    this.mediaRecorder.ondataavailable = e => this.chunks.push(e.data);

    return new Promise(res => {
      this.mediaRecorder.onstart = () => res();
      this.mediaRecorder.start();
    });
  }

  stop() {
    return new Promise(res => {
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: "audio/webm" });
        res(blob);
      };
      this.mediaRecorder.stop();
    });
  }
}
