import { CONFIG } from "./config.js";
import { ensureAuthenticated, getUserInfo, logout } from "./auth.js";
import {
  fetchTasks,
  createTask,
  updateTask,
  snoozeTask,
  doneTask,
  reactivateTask,
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

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatDateForInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().split("T")[0];
}

function isPlannedTask(task) {
  if (task.status !== "todo" || !task.dueDate) return false;
  const due = new Date(task.dueDate);
  const dueLocal = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return dueLocal > startOfToday();
}

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
  document.getElementById("btn-refresh").addEventListener("click", async () => {
    await ensureAuthenticated();
    await loadTasks();
  });
  document.getElementById("btn-add-task").addEventListener("click", async () => {
    await ensureAuthenticated();
    openTaskModalForNew();
  });

  // Footer Nav
  document.querySelectorAll(".nav-view-button").forEach(btn => {
    btn.addEventListener("click", async () => {
      await ensureAuthenticated();
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

  const dueDateInput = document.getElementById("task-due-date");
  if (dueDateInput) {
    dueDateInput.min = formatDateForInput(new Date());
  }

  document.getElementById("btn-snooze-task").addEventListener("click", onSnoozeTask);
  document.getElementById("btn-done-task").addEventListener("click", onDoneTask);
  document.getElementById("btn-reactivate-task").addEventListener("click", onReactivateTask);
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
    await ensureAuthenticated();
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
    dueDate: t.dueDate || null,
    snoozedUntil: t.snoozedUntil || null,
    doneAt: t.doneAt || null,
    archivedAt: t.archivedAt || null,
    hasAudio: !!t.audioKey,
    audioKey: t.audioKey || null
  }));
}


function createTaskListItem(task) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "list-group-item list-group-item-action d-flex justify-content-between align-items-start";

  const left = document.createElement("div");
  left.className = "me-3 flex-grow-1";

  const title = document.createElement("div");
  title.className = "fw-semibold";
  title.textContent = task.title || "(ohne Titel)";
  if (isPlannedTask(task)) {
    title.innerHTML = `<i class="bi bi-calendar-event me-1 text-info"></i>${title.textContent}`;
  }
  left.appendChild(title);

  if (task.description) {
    const desc = document.createElement("div");
    desc.className = "small text-muted text-truncate";
    desc.textContent = task.description;
    left.appendChild(desc);
  }

  const meta = document.createElement("div");
  meta.className = "small text-muted mt-1";
  const metaParts = [];
  const created = new Date(task.createdAt);
  metaParts.push(`angelegt: ${created.toLocaleDateString()} ${created.toLocaleTimeString().slice(0, 5)}`);

  if (task.dueDate) {
    const due = new Date(task.dueDate);
    const planned = due > startOfToday();
    metaParts.push(`fällig: ${due.toLocaleDateString()}${planned ? " (geplant)" : ""}`);
  }
  if (task.snoozedUntil && task.status === "snooze") {
    const until = new Date(task.snoozedUntil);
    metaParts.push(`wieder aktiv ab: ${until.toLocaleDateString()}`);
  }
  if (task.doneAt && task.status === "done") {
    const doneAt = new Date(task.doneAt);
    metaParts.push(`erledigt: ${doneAt.toLocaleDateString()}`);
  }
  if (task.archivedAt && task.status === "archived") {
    const archived = new Date(task.archivedAt);
    metaParts.push(`archiviert: ${archived.toLocaleDateString()}`);
  }
  meta.textContent = metaParts.join(" • ");
  left.appendChild(meta);

  const right = document.createElement("div");
  right.className = "text-end";

  const statusBadge = document.createElement("div");
  const planned = isPlannedTask(task);
  statusBadge.className =
    "badge rounded-pill " +
    (task.status === "todo"
      ? planned ? "text-bg-secondary" : "text-bg-info"
      : task.status === "snooze"
        ? "text-bg-warning"
        : task.status === "done"
          ? "text-bg-success"
          : "text-bg-secondary");
  statusBadge.textContent =
    task.status === "todo"
      ? planned ? "Geplant" : "ToDo"
      : task.status === "snooze"
        ? "Snooze"
        : task.status === "done"
          ? "Done"
          : "Archiviert";
  right.appendChild(statusBadge);

  const snoozeBadge = document.createElement("div");
  snoozeBadge.className = "small text-warning mt-1";
  snoozeBadge.textContent = `Snoozes: ${task.snoozeCount || 0}`;
  right.appendChild(snoozeBadge);

  if (task.hasAudio) {
    const audioIcon = document.createElement("div");
    audioIcon.className = "text-info small mt-1";
    audioIcon.innerHTML = `<i class="bi bi-soundwave me-1"></i>Audio`;
    right.appendChild(audioIcon);
  }

  item.appendChild(left);
  item.appendChild(right);

  item.addEventListener("click", () => openTaskModalForEdit(task));
  return item;
}

function renderSection(container, title, tasks) {
  if (title) {
    const header = document.createElement("div");
    header.className = "text-uppercase text-secondary small px-2 py-1";
    header.textContent = title;
    container.appendChild(header);
  }

  for (const task of tasks) {
    container.appendChild(createTaskListItem(task));
  }
}

function renderTaskList() {
  const container = document.getElementById("task-list");
  container.innerHTML = "";

  if (currentView === "todo") {
    const todos = allTasks.filter(t => t.status === "todo");
    const planned = todos
      .filter(isPlannedTask)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const active = todos
      .filter(t => !isPlannedTask(t))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (!planned.length && !active.length) {
      const empty = document.createElement("div");
      empty.className = "text-center text-muted py-4";
      empty.textContent = "Keine offenen ToDo-Tasks.";
      container.appendChild(empty);
      return;
    }

    if (active.length) {
      renderSection(container, planned.length ? "Aktiv" : "", active);
    }
    if (planned.length) {
      const hint = document.createElement("div");
      hint.className = "text-center text-info small py-2 border-top border-secondary";
      hint.textContent = "Geplante Aufgaben rutschen am Fälligkeitstag automatisch nach oben.";
      container.appendChild(hint);
      renderSection(container, "Geplant", planned);
    }
    return;
  }

  if (currentView === "snooze") {
    const tasks = allTasks
      .filter(t => t.status === "snooze")
      .sort((a, b) => new Date(a.snoozedUntil || a.createdAt) - new Date(b.snoozedUntil || b.createdAt));

    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "text-center text-muted py-4";
      empty.textContent = "Hier ist es gerade ruhig. Keine Snooze-Tasks.";
      container.appendChild(empty);
      return;
    }

    renderSection(container, "", tasks);
    return;
  }

  const doneTasks = allTasks
    .filter(t => t.status === "done")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const archivedTasks = allTasks
    .filter(t => t.status === "archived")
    .sort((a, b) => new Date(b.archivedAt || b.updatedAt || b.createdAt) - new Date(a.archivedAt || a.updatedAt || a.createdAt));

    item.addEventListener("click", async () => {
      await ensureAuthenticated();
      openTaskModalForEdit(t);
    });
    container.appendChild(item);
  }
}

function resetTaskModal() {
  document.getElementById("task-id").value = "";
  document.getElementById("task-title").value = "";
  document.getElementById("task-description").value = "";
  document.getElementById("task-title").disabled = false;
  document.getElementById("task-description").disabled = false;
  document.getElementById("task-due-date").value = "";
  document.getElementById("task-due-date").disabled = false;
  document.getElementById("task-snooze-count").textContent = "0";
  document.getElementById("task-status-badge").textContent = "ToDo";
  document.getElementById("task-status-badge").className = "badge rounded-pill text-bg-info";
  document.getElementById("task-meta").textContent = "";
  document.getElementById("btn-delete-task").classList.add("d-none");
  document.getElementById("btn-reactivate-task").classList.add("d-none");
  document.getElementById("btn-snooze-task").disabled = false;
  document.getElementById("btn-done-task").disabled = false;
  document.getElementById("btn-reactivate-task").disabled = false;
  document.getElementById("btn-audio-transcribe").disabled = false;
  document.getElementById("btn-audio-record").disabled = false;
  document.getElementById("btn-audio-stop").disabled = true;
  document.getElementById("btn-audio-play").disabled = true;

  // Audio
  currentAudioBlob = null;
  document.getElementById("audio-player").style.display = "none";
  document.getElementById("audio-player").src = "";
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
  const dueDateInput = document.getElementById("task-due-date");
  if (task.dueDate) {
    dueDateInput.value = formatDateForInput(task.dueDate);
  }
  dueDateInput.disabled = true;

  const badge = document.getElementById("task-status-badge");
  badge.textContent =
    task.status === "todo" ? (isPlannedTask(task) ? "Geplant" : "ToDo") :
    task.status === "snooze" ? "Snooze" :
    task.status === "done" ? "Done" :
    "Archiviert";
  badge.className =
    "badge rounded-pill " +
    (task.status === "todo" ? (isPlannedTask(task) ? "text-bg-secondary" : "text-bg-info") :
     task.status === "snooze" ? "text-bg-warning" :
     task.status === "done" ? "text-bg-success" :
     "text-bg-secondary");

  const created = new Date(task.createdAt);
  const updated = task.updatedAt ? new Date(task.updatedAt) : null;
  const metaParts = [
    `erstellt: ${created.toLocaleDateString()}`
  ];
  if (updated) {
    metaParts.push(`geändert: ${updated.toLocaleDateString()}`);
  }
  if (task.dueDate) {
    const due = new Date(task.dueDate);
    metaParts.push(`fällig: ${due.toLocaleDateString()}`);
  }
  if (task.doneAt) {
    const doneAt = new Date(task.doneAt);
    metaParts.push(`done: ${doneAt.toLocaleDateString()}`);
  }
  if (task.archivedAt) {
    const archived = new Date(task.archivedAt);
    metaParts.push(`archiviert: ${archived.toLocaleDateString()}`);
  }
  document.getElementById("task-meta").textContent = metaParts.join(" • ");

  if (task.status === "done") {
    document.getElementById("btn-delete-task").classList.remove("d-none");
  }

  const reactivationBtn = document.getElementById("btn-reactivate-task");
  reactivationBtn.classList.toggle("d-none", !(task.status === "snooze" || task.status === "done"));
  const snoozeBtn = document.getElementById("btn-snooze-task");
  snoozeBtn.disabled = isPlannedTask(task);

  const isArchived = task.status === "archived";
  if (isArchived) {
    document.getElementById("task-title").disabled = true;
    document.getElementById("task-description").disabled = true;
    snoozeBtn.disabled = true;
    document.getElementById("btn-done-task").disabled = true;
    reactivationBtn.classList.add("d-none");
    document.getElementById("btn-audio-transcribe").disabled = true;
    document.getElementById("btn-audio-record").disabled = true;
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
  const dueDateValue = document.getElementById("task-due-date").value;

  if (!title) {
    alert("Titel ist erforderlich.");
    return;
  }

  try {
    let savedTask;
    if (!id) {
      const payload = { title, description };
      if (dueDateValue) {
        payload.dueDate = dueDateValue;
      }
      savedTask = await createTask(payload);
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
  const dueDateValue = document.getElementById("task-due-date").value;

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
      const payload = { title, description };
      if (dueDateValue) {
        payload.dueDate = dueDateValue;
      }
      const created = await createTask(payload);
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
  const task = allTasks.find(t => t.id === id);
  if (task && isPlannedTask(task)) {
    alert("Geplante Aufgaben können erst am Fälligkeitstag gesnoozed werden.");
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

async function onReactivateTask() {
  const id = document.getElementById("task-id").value;
  if (!id) {
    alert("Task muss erst gespeichert werden, bevor er reaktiviert werden kann.");
    return;
  }
  try {
    await reactivateTask(id);
    taskModal.hide();
    await loadTasks();
  } catch (e) {
    console.error(e);
    alert("Konnte Task nicht reaktivieren.");
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
