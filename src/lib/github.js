// Minimal GitHub Contents API client — used to durably persist new games and
// recomputed handicaps by committing straight back to the repo. That commit
// triggers a normal Cloudflare Pages redeploy, so the site always reflects
// the latest data with no separate database to manage.

const API_BASE = "https://api.github.com";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fortnite-stat-tracker",
  };
}

async function getFile(env, filePath) {
  const url = `${API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}?ref=${env.GITHUB_BRANCH || "main"}`;
  const res = await fetch(url, { headers: authHeaders(env.GITHUB_TOKEN) });
  if (!res.ok) {
    throw new Error(`GitHub getFile(${filePath}) failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const content = atob(json.content.replace(/\n/g, ""));
  return { content, sha: json.sha };
}

async function putFile(env, filePath, newContent, sha, message) {
  const url = `${API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(newContent))),
    sha,
    branch: env.GITHUB_BRANCH || "main",
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...authHeaders(env.GITHUB_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub putFile(${filePath}) failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export { getFile, putFile };
