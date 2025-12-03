import { CONFIG } from "./config.js";

const TOKEN_KEY_ID = "tadone_id_token";
const TOKEN_KEY_ACCESS = "tadone_access_token";
const USER_INFO_KEY = "tadone_user";

// PKCE + state nur für die aktuelle Browser-Session
const PKCE_VERIFIER_KEY = "tadone_pkce_verifier";
const OAUTH_STATE_KEY = "tadone_oauth_state";

function getCognitoBaseUrl() {
  const { region, domainPrefix } = CONFIG.cognito;
  if (!domainPrefix) {
    console.warn("⚠️ CONFIG.cognito.domainPrefix ist nicht gesetzt!");
  }
  return `https://${domainPrefix}.auth.${region}.amazoncognito.com`;
}

/* ------------------ Token / User Helpers ------------------ */

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY_ACCESS);
}

export function getIdToken() {
  return localStorage.getItem(TOKEN_KEY_ID);
}

export function getUserInfo() {
  const raw = localStorage.getItem(USER_INFO_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY_ID);
  localStorage.removeItem(TOKEN_KEY_ACCESS);
  localStorage.removeItem(USER_INFO_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);

  const base = getCognitoBaseUrl();
  const { clientId } = CONFIG.cognito;
  const redirect = `${CONFIG.frontendDomain}/`;

  const url =
    `${base}/logout?client_id=${encodeURIComponent(clientId)}` +
    `&logout_uri=${encodeURIComponent(redirect)}`;

  window.location.href = url;
}

/* ------------------ PKCE + state ------------------ */

function randomString(length = 43) {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(x => charset[x % charset.length]).join("");
}

function base64UrlEncode(buffer) {
  let binary = "";
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

function savePkce(verifier, state) {
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OAUTH_STATE_KEY, state);
}

function loadPkce() {
  return {
    verifier: sessionStorage.getItem(PKCE_VERIFIER_KEY),
    state: sessionStorage.getItem(OAUTH_STATE_KEY)
  };
}

function clearPkce() {
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
}

/* ------------------ Login Flow ------------------ */

function redirectToLogin() {
  const base = getCognitoBaseUrl();
  const { clientId } = CONFIG.cognito;
  const redirect = `${CONFIG.frontendDomain}/`;
  const scope = encodeURIComponent("openid email profile");

  const verifier = randomString(64);
  const state = randomString(32);
  savePkce(verifier, state);

  sha256(verifier).then(codeChallenge => {
    const url =
      `${base}/oauth2/authorize?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&state=${encodeURIComponent(state)}` +
      `&code_challenge_method=S256` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}`;

    window.location.href = url;
  }).catch(err => {
    console.error("PKCE error", err);
    alert("Login konnte nicht gestartet werden (PKCE Fehler).");
  });
}

async function exchangeCodeForTokens(code, returnedState) {
  const { verifier, state: storedState } = loadPkce();

  if (!storedState || !verifier || storedState !== returnedState) {
    console.error("State mismatch", { storedState, returnedState });
    alert("Ungültige Login-Antwort (state mismatch). Bitte erneut einloggen.");
    clearPkce();
    logout();
    return;
  }

  clearPkce();

  const base = getCognitoBaseUrl();
  const { clientId } = CONFIG.cognito;
  const redirect = `${CONFIG.frontendDomain}/`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirect,
    code_verifier: verifier
  });

  const res = await fetch(`${base}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Token exchange failed", res.status, text);
    alert("Login fehlgeschlagen. Bitte erneut versuchen.");
    throw new Error("Token exchange failed");
  }

  const data = await res.json();

  localStorage.setItem(TOKEN_KEY_ID, data.id_token);
  localStorage.setItem(TOKEN_KEY_ACCESS, data.access_token);

  // Userinfo aus JWT payload holen
  try {
    const parts = data.id_token.split(".");
    if (parts.length === 3) {
      const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(payloadJson);
      const user = {
        email: payload.email,
        sub: payload.sub,
        exp: payload.exp
      };
      localStorage.setItem(USER_INFO_KEY, JSON.stringify(user));
    }
  } catch (e) {
    console.warn("JWT decode failed", e);
  }

  // URL von ?code=&state= befreien
  window.history.replaceState({}, document.title, "/");
}

/* ------------------ Token-Gültigkeit (einfach) ------------------ */

function isTokenValid() {
  const raw = localStorage.getItem(USER_INFO_KEY);
  if (!raw) return false;
  try {
    const user = JSON.parse(raw);
    if (!user.exp) return false;
    const now = Math.floor(Date.now() / 1000);
    // 60 Sekunden Puffer
    return user.exp > now + 60;
  } catch {
    return false;
  }
}

/* ------------------ Public API ------------------ */

export async function ensureAuthenticated() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const returnedState = params.get("state");

  if (code) {
    await exchangeCodeForTokens(code, returnedState);
    return;
  }

  const accessToken = getAccessToken();
  if (!accessToken || !isTokenValid()) {
    redirectToLogin();
  }
}
