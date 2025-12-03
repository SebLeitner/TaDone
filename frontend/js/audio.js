let mediaRecorder = null;
let recordedChunks = [];
let timerInterval = null;
let seconds = 0;

export function initAudioControls({
  recordBtn,
  stopBtn,
  playBtn,
  timerLabel,
  statusLabel,
  audioElement,
  onNewRecording
}) {
  recordBtn.addEventListener("click", () => startRecording({
    recordBtn,
    stopBtn,
    playBtn,
    timerLabel,
    statusLabel,
    audioElement,
    onNewRecording
  }));

  stopBtn.addEventListener("click", () => stopRecording({
    recordBtn,
    stopBtn,
    playBtn,
    timerLabel,
    statusLabel
  }));

  playBtn.addEventListener("click", () => {
    if (audioElement.src) {
      audioElement.play();
    }
  });
}

function updateTimerLabel(label) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  label.textContent = `${m}:${s}`;
}

async function startRecording(ctx) {
  const { recordBtn, stopBtn, playBtn, timerLabel, statusLabel, audioElement } = ctx;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Dein Browser unterstützt keine Audioaufnahme.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      audioElement.src = url;
      audioElement.style.display = "block";
      playBtn.disabled = false;
      statusLabel.textContent = "Aufnahme vorhanden (noch nicht hochgeladen).";
      if (typeof ctx.onNewRecording === "function") {
        ctx.onNewRecording(blob);
      }
    };

    // Timer
    seconds = 0;
    updateTimerLabel(timerLabel);
    timerInterval = setInterval(() => {
      seconds++;
      if (seconds >= 10) {
        stopRecording(ctx);
      } else {
        updateTimerLabel(timerLabel);
      }
    }, 1000);

    mediaRecorder.start();
    statusLabel.textContent = "Aufnahme läuft...";
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    playBtn.disabled = true;
  } catch (e) {
    console.error(e);
    alert("Konnte Aufnahme nicht starten.");
  }
}

function stopRecording(ctx) {
  const { recordBtn, stopBtn, statusLabel } = ctx;
  if (!mediaRecorder) return;
  try {
    mediaRecorder.stop();
  } catch (_) {}
  mediaRecorder = null;
  stopBtn.disabled = true;
  recordBtn.disabled = false;
  clearInterval(timerInterval);
  timerInterval = null;
  statusLabel.textContent = "Aufnahme beendet.";
}
