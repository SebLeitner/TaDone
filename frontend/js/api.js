import { CONFIG } from "./config.js";
import { getAccessToken } from "./auth.js";

const API_BASE = CONFIG.apiBaseUrl;

// Hilfsfunktion für API-Calls
async function api(path, options = {}) {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const headers = options.headers || {};
  headers["Authorization"] = "Bearer " + token;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("API error", res.status, text);
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

export async function fetchTasks() {
  // Erwartet vom Backend: Liste von Tasks
  return api("/tasks", { method: "GET" });
}

export async function createTask(task) {
  return api("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task)
  });
}

export async function updateTask(taskId, updates) {
  return api(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
}

export async function snoozeTask(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}/snooze`, {
    method: "POST"
  });
}

export async function doneTask(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}/done`, {
    method: "POST"
  });
}

export async function deleteTask(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
}

// Audio Upload: erwartet ein FormData im Backend
export async function uploadTaskAudio(taskId, blob) {
  const token = getAccessToken();
  const formData = new FormData();
  formData.append("file", blob, "note.webm");
  formData.append("taskId", taskId);

  const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/audio`, {
    method: "POST",
    headers: {
      "Authorization": token
    },
    body: formData
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Audio upload failed: ${text}`);
  }

  return res.json();
}

export const API = {
  fetchTasks,
  createTask,
  updateTask,
  snoozeTask,
  doneTask,
  deleteTask,
  uploadTaskAudio
};
