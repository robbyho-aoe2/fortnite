// Minimal GitHub Contents API client — runs in the browser and commits new
// games / recomputed handicaps straight back to this repo. That commit
// triggers a normal GitHub Pages redeploy, so the site always reflects the
// latest data with no separate backend or database.
//
// The `config` object below carries a repo-scoped write token. See
// config.js for why that token is public and what it's actually scoped to.

const API_BASE = "https://api.github.com";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fortnite-stat-tracker",
  };
}

async function getFile(config, filePath) {
  const url = `${API_BASE}/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/contents/${filePath}?ref=${config.GITHUB_BRANCH || "main"}`;
  const res = await fetch(url, { headers: authHeaders(config.GITHUB_TOKEN) });
  if (!res.ok) {
    throw new Error(`GitHub getFile(${filePath}) failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const content = atob(json.content.replace(/\n/g, ""));
  return { content, sha: json.sha };
}

async function putFile(config, filePath, newContent, sha, message) {
  const url = `${API_BASE}/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/contents/${filePath}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(newContent))),
    sha,
    branch: config.GITHUB_BRANCH || "main",
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...authHeaders(config.GITHUB_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub putFile(${filePath}) failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export { getFile, putFile };
