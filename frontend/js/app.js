import { CONFIG } from "./config.js";
import { ensureAuthenticated, getUserInfo, logout } from "./auth.js";
import {
  fetchTasks,
  createTask,
  updateTask,
  snoozeTask,
  doneTask,
  deleteTask,
  getTaskAudioUrl,
  uploadTaskAudio,
  transcribeTaskAudio
} from "./api.js";
import { initAudioControls } from "./audio.js";

let currentView = "todo";
let allTasks = [];
let currentAudioBlob = null;
let taskModal = null;

document.addEventListener("DOMContentLoaded", async () => {
  await ensureAuthenticated();
  initUI();
  await loadTasks();
});

function initUI() {
  // User Info
  const user = getUserInfo();
  const emailEl = document.getElementById("user-email");
  if (user && user.email) {
    emailEl.textContent = user.email;
  } else {
    emailEl.textContent = "(unbekannt)";
  }

  document.getElementById("btn-logout").addEventListener("click", logout);
  document.getElementById("btn-refresh").addEventListener("click", loadTasks);
  document.getElementById("btn-add-task").addEventListener("click", () => openTaskModalForNew());

  // Footer Nav
  document.querySelectorAll(".nav-view-button").forEach(btn => {
    btn.addEventListener("click", () => {
      currentView = btn.dataset.view;
      document.querySelectorAll(".nav-view-button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("current-view-label").textContent =
        currentView === "todo" ? "ToDo" :
        currentView === "snooze" ? "Snooze" : "Done";
      renderTaskList();
    });
  });
  // Standard: ToDo
  document.querySelector('.nav-view-button[data-view="todo"]').classList.add("active");

  // Modal
  taskModal = new bootstrap.Modal(document.getElementById("taskModal"));

  const form = document.getElementById("task-form");
  form.addEventListener("submit", onSaveTask);

  document.getElementById("btn-snooze-task").addEventListener("click", onSnoozeTask);
  document.getElementById("btn-done-task").addEventListener("click", onDoneTask);
  document.getElementById("btn-delete-task").addEventListener("click", onDeleteTask);
  document.getElementById("btn-audio-transcribe").addEventListener("click", onTranscribeAudio);

  // Audio
  initAudioControls({
    recordBtn: document.getElementById("btn-audio-record"),
    stopBtn: document.getElementById("btn-audio-stop"),
    playBtn: document.getElementById("btn-audio-play"),
    timerLabel: document.getElementById("audio-timer"),
    statusLabel: document.getElementById("audio-status"),
    audioElement: document.getElementById("audio-player"),
    onNewRecording: (blob) => {
      currentAudioBlob = blob;
    }
  });

  // Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(console.error);
  }
}

async function loadTasks() {
  try {
    const list = await fetchTasks();
    allTasks = normalizeTasks(list || []);
    renderTaskList();
  } catch (e) {
    console.error(e);
    alert("Konnte Tasks nicht laden.");
  }
}

function normalizeTasks(list) {
  return list.map(t => ({
    id: t.taskId,
    title: t.title || "",
    description: t.description || "",
    status: (t.status || "TODO").toLowerCase(),
    snoozeCount: t.snoozeCount || 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    hasAudio: !!t.audioKey,
    audioKey: t.audioKey || null
  }));
}


function renderTaskList() {
  const container = document.getElementById("task-list");
  container.innerHTML = "";

  let tasks = allTasks.filter(t => t.status === currentView);

  // Sortierung:
  if (currentView === "done") {
    // Neueste oben
    tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else {
    // Älteste oben
    tasks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "text-center text-muted py-4";
    empty.textContent =
      currentView === "todo" ? "Keine offenen ToDo-Tasks." :
      currentView === "snooze" ? "Hier ist es gerade ruhig. Keine Snooze-Tasks." :
      "Noch nichts erledigt – oder alles gelöscht 😉";
    container.appendChild(empty);
    return;
  }

  for (const t of tasks) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "list-group-item list-group-item-action d-flex justify-content-between align-items-start";

    const left = document.createElement("div");
    left.className = "me-3 flex-grow-1";

    const title = document.createElement("div");
    title.className = "fw-semibold";
    title.textContent = t.title || "(ohne Titel)";
    left.appendChild(title);

    if (t.description) {
      const desc = document.createElement("div");
      desc.className = "small text-muted text-truncate";
      desc.textContent = t.description;
      left.appendChild(desc);
    }

    const meta = document.createElement("div");
    meta.className = "small text-muted mt-1";
    const date = new Date(t.createdAt);
    meta.textContent = `angelegt: ${date.toLocaleDateString()} ${date.toLocaleTimeString().slice(0,5)}`;
    left.appendChild(meta);

    const right = document.createElement("div");
    right.className = "text-end";

    const statusBadge = document.createElement("div");
    statusBadge.className =
      "badge rounded-pill " +
      (t.status === "todo" ? "text-bg-info" :
       t.status === "snooze" ? "text-bg-warning" :
       "text-bg-success");
    statusBadge.textContent =
      t.status === "todo" ? "ToDo" :
      t.status === "snooze" ? "Snooze" : "Done";
    right.appendChild(statusBadge);

    const snoozeBadge = document.createElement("div");
    snoozeBadge.className = "small text-warning mt-1";
    snoozeBadge.textContent = `Snoozes: ${t.snoozeCount || 0}`;
    right.appendChild(snoozeBadge);

    if (t.hasAudio) {
      const audioIcon = document.createElement("div");
      audioIcon.className = "text-info small mt-1";
      audioIcon.innerHTML = `<i class="bi bi-soundwave me-1"></i>Audio`;
      right.appendChild(audioIcon);
    }

    item.appendChild(left);
    item.appendChild(right);

    item.addEventListener("click", () => openTaskModalForEdit(t));
    container.appendChild(item);
  }
}

function resetTaskModal() {
  document.getElementById("task-id").value = "";
  document.getElementById("task-title").value = "";
  document.getElementById("task-description").value = "";
  document.getElementById("task-snooze-count").textContent = "0";
  document.getElementById("task-status-badge").textContent = "ToDo";
  document.getElementById("task-status-badge").className = "badge rounded-pill text-bg-info";
  document.getElementById("task-meta").textContent = "";
  document.getElementById("btn-delete-task").classList.add("d-none");

  // Audio
  currentAudioBlob = null;
  document.getElementById("audio-player").style.display = "none";
  document.getElementById("audio-player").src = "";
  document.getElementById("btn-audio-play").disabled = true;
  document.getElementById("audio-status").textContent = "Keine Aufnahme vorhanden.";
  document.getElementById("audio-timer").textContent = "00:00";
}

function ensureTitleWithTimestamp() {
  const input = document.getElementById("task-title");
  if (input.value.trim()) return input.value.trim();

  const now = new Date();
  const fallback = `TS ${now.toLocaleDateString()} ${now.toLocaleTimeString().slice(0, 5)}`;
  input.value = fallback;
  return fallback;
}

function openTaskModalForNew() {
  resetTaskModal();
  document.getElementById("taskModalLabel").textContent = "Neuer Task";
  taskModal.show();
}

async function openTaskModalForEdit(task) {
  resetTaskModal();
  document.getElementById("taskModalLabel").textContent = "Task bearbeiten";
  document.getElementById("task-id").value = task.id;
  document.getElementById("task-title").value = task.title;
  document.getElementById("task-description").value = task.description || "";
  document.getElementById("task-snooze-count").textContent = task.snoozeCount || 0;

  const badge = document.getElementById("task-status-badge");
  badge.textContent =
    task.status === "todo" ? "ToDo" :
    task.status === "snooze" ? "Snooze" : "Done";
  badge.className =
    "badge rounded-pill " +
    (task.status === "todo" ? "text-bg-info" :
     task.status === "snooze" ? "text-bg-warning" :
     "text-bg-success");

  const created = new Date(task.createdAt);
  const updated = task.updatedAt ? new Date(task.updatedAt) : null;
  document.getElementById("task-meta").textContent =
    updated
      ? `erstellt: ${created.toLocaleDateString()} • geändert: ${updated.toLocaleDateString()}`
      : `erstellt: ${created.toLocaleDateString()}`;

  if (task.status === "done") {
    document.getElementById("btn-delete-task").classList.remove("d-none");
  }

  // Bestehendes Audio anzeigen
  if (task.audioKey) {
    const audioPlayer = document.getElementById("audio-player");
    const statusLabel = document.getElementById("audio-status");
    const playBtn = document.getElementById("btn-audio-play");

    statusLabel.textContent = "Audio wird geladen...";
    audioPlayer.style.display = "none";
    playBtn.disabled = true;

    try {
      const { url } = await getTaskAudioUrl(task.id || task.taskId);
      audioPlayer.src = url;
      audioPlayer.style.display = "block";
      playBtn.disabled = false;
      statusLabel.textContent = "Aufnahme vorhanden.";
    } catch (err) {
      console.error("Audio URL fetch failed", err);
      statusLabel.textContent = "Audio konnte nicht geladen werden.";
    }
  }

  taskModal.show();
}

async function onSaveTask(e) {
  e.preventDefault();

  const id = document.getElementById("task-id").value || null;
  const title = document.getElementById("task-title").value.trim();
  const description = document.getElementById("task-description").value.trim();

  if (!title) {
    alert("Titel ist erforderlich.");
    return;
  }

  try {
    let savedTask;
    if (!id) {
      savedTask = await createTask({ title, description });
    } else {
      savedTask = await updateTask(id, { title, description });
    }

    // Audio optional hochladen
    if (currentAudioBlob && savedTask && (savedTask.id || savedTask.taskId)) {
      const tid = savedTask.id || savedTask.taskId;
      try {
        await uploadTaskAudio(tid, currentAudioBlob);
      } catch (err) {
        console.error("Audio upload failed", err);
        alert("Audio konnte nicht hochgeladen werden.");
      }
    }

    taskModal.hide();
    await loadTasks();
  } catch (err) {
    console.error(err);
    alert("Konnte Task nicht speichern.");
  }
}

async function onTranscribeAudio() {
  const transcribeBtn = document.getElementById("btn-audio-transcribe");
  const statusLabel = document.getElementById("audio-status");
  const audioPlayer = document.getElementById("audio-player");
  const descriptionInput = document.getElementById("task-description");
  const taskIdInput = document.getElementById("task-id");

  const hasAudio = currentAudioBlob || audioPlayer.src;
  if (!hasAudio) {
    alert("Keine Audioaufnahme vorhanden.");
    return;
  }

  const originalBtnHtml = transcribeBtn.innerHTML;
  transcribeBtn.disabled = true;
  transcribeBtn.innerHTML =
    '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Transkribiere...';
  statusLabel.textContent = "Audio wird zur Spracherkennung gesendet...";

  try {
    const title = ensureTitleWithTimestamp();
    let description = descriptionInput.value.trim();
    let taskId = taskIdInput.value;

    if (!taskId) {
      const created = await createTask({ title, description });
      taskId = created.id || created.taskId;
      taskIdInput.value = taskId;
    } else {
      await updateTask(taskId, { title, description });
    }

    if (currentAudioBlob) {
      await uploadTaskAudio(taskId, currentAudioBlob);
      currentAudioBlob = null;
    }

    const { transcript } = await transcribeTaskAudio(taskId);
    if (!transcript) {
      throw new Error("Keine Transkription erhalten.");
    }

    const updatedDescription = description
      ? `${description}\n===> ${transcript} <===`
      : `===> ${transcript} <===`;

    descriptionInput.value = updatedDescription;
    await updateTask(taskId, { title: document.getElementById("task-title").value.trim(), description: updatedDescription });

    statusLabel.textContent = "Transkription hinzugefügt.";
    await loadTasks();
  } catch (err) {
    console.error(err);
    statusLabel.textContent = "Transkription fehlgeschlagen.";
    alert("Konnte Audio nicht transkribieren: " + err.message);
  } finally {
    transcribeBtn.disabled = false;
    transcribeBtn.innerHTML = originalBtnHtml;
  }
}

async function onSnoozeTask() {
  const id = document.getElementById("task-id").value;
  if (!id) {
    alert("Task muss erst gespeichert werden, bevor er gesnoozed werden kann.");
    return;
  }
  if (!confirm("Task bis morgen snoozen?")) return;
  try {
    await snoozeTask(id);
    taskModal.hide();
    await loadTasks();
  } catch (e) {
    console.error(e);
    alert("Konnte Task nicht snoozen.");
  }
}

async function onDoneTask() {
  const id = document.getElementById("task-id").value;
  if (!id) {
    alert("Task muss erst gespeichert werden, bevor er auf Done gesetzt werden kann.");
    return;
  }
  try {
    await doneTask(id);
    taskModal.hide();
    await loadTasks();
  } catch (e) {
    console.error(e);
    alert("Konnte Task nicht auf Done setzen.");
  }
}

async function onDeleteTask() {
  const id = document.getElementById("task-id").value;
  if (!id) return;
  if (!confirm("Task wirklich endgültig löschen?")) return;

  try {
    await deleteTask(id);
    taskModal.hide();
    await loadTasks();
  } catch (e) {
    console.error(e);
    alert("Konnte Task nicht löschen.");
  }
}
