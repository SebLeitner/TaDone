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

  // Einige Endpunkte (z. B. erfolgreiche Updates) antworten mit 204 No Content.
  // In diesem Fall schlägt das Parsen fehl, daher liefern wir explizit null zurück.
  if (res.status === 204) {
    return null;
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

export async function createTask(task, { snoozeEdit = false } = {}) {
  const suffix = snoozeEdit ? "?snoozeEdit=1" : "";
  const headers = { "Content-Type": "application/json" };
  if (snoozeEdit) {
    headers["X-Snooze-Edit"] = "1";
  }
  return api(`/tasks${suffix}`, {
    method: "POST",
    headers,
    body: JSON.stringify(task)
  });
}

export async function updateTask(taskId, updates, { snoozeEdit = false } = {}) {
  const suffix = snoozeEdit ? "?snoozeEdit=1" : "";
  const headers = { "Content-Type": "application/json" };
  if (snoozeEdit) {
    headers["X-Snooze-Edit"] = "1";
  }
  return api(`/tasks/${encodeURIComponent(taskId)}${suffix}`, {
    method: "PUT",
    headers,
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

export async function reactivateTask(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}/reactivate`, {
    method: "POST"
  });
}

export async function deleteTask(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
}

export async function getTaskAudioUrl(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}/audio`, {
    method: "GET"
  });
}

export async function uploadTaskAudio(taskId, blob) {
  // Blob → Base64 konvertieren
  const reader = new FileReader();
  const base64 = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  return api(`/tasks/${encodeURIComponent(taskId)}/audio`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64 })
  });
}

export async function transcribeTaskAudio(taskId) {
  return api(`/tasks/${encodeURIComponent(taskId)}/transcribe`, {
    method: "POST"
  });
}


export const API = {
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
};
