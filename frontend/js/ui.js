import * as API from "./api.js";
import { Recorder } from "./recorder.js";

export const UI = {
  state: {
    view: "TODO",
    tasks: [],
    currentTask: null,
    recorder: null,
    audioBlob: null
  },

  init() {
    document.querySelectorAll(".nav-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        UI.state.view = btn.dataset.view;
        UI.render();
      });
    });

    document.getElementById("btnAdd").addEventListener("click", () =>
      UI.openModal({ new: true })
    );

    document.getElementById("btnRefresh").addEventListener("click", () =>
      UI.reload()
    );
  },

  async reload() {
    UI.state.tasks = await API.fetchTasks();
    UI.render();
  },

  render() {
    const list = document.getElementById("taskList");
    list.innerHTML = "";

    const filtered = UI.state.tasks.filter(t => t.status === UI.state.view);
    filtered.sort((a, b) =>
      UI.state.view === "DONE"
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt)
    );

    for (const t of filtered) {
      const div = document.createElement("div");
      div.className = "p-3 border-bottom border-secondary";
      div.style.cursor = "pointer";

      div.innerHTML = `
        <div class="d-flex justify-content-between">
          <div>
            <strong>${t.title}</strong><br>
            <small>${t.description || ""}</small>
          </div>
          <div>
            ${t.audioKey ? "🎙️" : ""}
            ${t.snoozeCount > 0 ? `<span class="badge text-bg-warning">Snoozed ${t.snoozeCount}x</span>` : ""}
          </div>
        </div>
      `;

      div.onclick = () => UI.openModal(t);
      list.appendChild(div);
    }
  },

  async openModal(task) {
    UI.state.currentTask = task;
    UI.state.audioBlob = null;
    UI.state.recorder = null;

    document.getElementById("taskTitle").value = task.title || "";
    document.getElementById("taskDescription").value = task.description || "";

    // Snooze Counter
    const s = document.getElementById("snoozeCounter");
    if (task.snoozeCount > 0) {
      s.textContent = `Snoozed ${task.snoozeCount}x`;
      s.classList.remove("d-none");
    } else s.classList.add("d-none");

    // Audio Player
    const player = document.getElementById("audioPlayer");
    const del = document.getElementById("btnDeleteAudio");

    if (task.audioKey) {
      try {
        const { url } = await API.getTaskAudioUrl(task.taskId);
        player.src = url;
        player.classList.remove("d-none");
        del.classList.remove("d-none");
      } catch (err) {
        console.error("Audio URL fetch failed", err);
        player.classList.add("d-none");
        del.classList.add("d-none");
      }
    } else {
      player.classList.add("d-none");
      del.classList.add("d-none");
    }

    document.getElementById("btnDelete").classList.toggle("d-none", !task.taskId);

    // Recording
    const btnRecord = document.getElementById("btnRecord");
    const btnStop = document.getElementById("btnStop");

    btnRecord.onclick = async () => {
      UI.state.recorder = new Recorder();
      await UI.state.recorder.start();
      btnRecord.disabled = true;
      btnStop.disabled = false;
    };

    btnStop.onclick = async () => {
      const blob = await UI.state.recorder.stop();
      UI.state.audioBlob = blob;

      const url = URL.createObjectURL(blob);
      player.src = url;
      player.classList.remove("d-none");

      btnRecord.disabled = false;
      btnStop.disabled = true;
    };

    document.getElementById("btnSave").onclick = async () => {
      if (task.new) {
        const newTask = await API.createTask({
          title: document.getElementById("taskTitle").value,
          description: document.getElementById("taskDescription").value
        });
        if (UI.state.audioBlob) await UI.uploadAudio(newTask.taskId);
      } else {
        await API.updateTask(task.taskId, {
          title: document.getElementById("taskTitle").value,
          description: document.getElementById("taskDescription").value
        });
        if (UI.state.audioBlob) await UI.uploadAudio(task.taskId);
      }

      UI.reload();
      bootstrap.Modal.getInstance(document.getElementById("taskModal")).hide();
    };

    document.getElementById("btnSnooze").onclick = async () => {
      await API.snoozeTask(task.taskId);
      UI.reload();
      bootstrap.Modal.getInstance(document.getElementById("taskModal")).hide();
    };

    document.getElementById("btnDone").onclick = async () => {
      await API.doneTask(task.taskId);
      UI.reload();
      bootstrap.Modal.getInstance(document.getElementById("taskModal")).hide();
    };

    document.getElementById("btnDelete").onclick = async () => {
      await API.deleteTask(task.taskId);
      UI.reload();
      bootstrap.Modal.getInstance(document.getElementById("taskModal")).hide();
    };

    new bootstrap.Modal(document.getElementById("taskModal")).show();
  },

  async uploadAudio(taskId) {
    await API.uploadTaskAudio(taskId, UI.state.audioBlob);
  }
};
