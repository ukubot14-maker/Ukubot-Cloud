const $ = id => document.getElementById(id);
const dialog = $("settingsDialog");
const settings = {
  get api() { return (sessionStorage.getItem("ubc_api") || "").replace(/\/+$/, ""); },
  get token() { return sessionStorage.getItem("ubc_token") || ""; }
};
function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3200);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
async function request(path, options = {}) {
  if (!settings.api || !settings.token) throw new Error("Open Settings and connect the control API first.");
  const response = await fetch(settings.api + path, {
    ...options,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.token}`, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
$("settings").onclick = () => {
  $("apiUrl").value = settings.api; $("token").value = settings.token; dialog.showModal();
};
$("save").onclick = async () => {
  const api = $("apiUrl").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  if (!/^https:\/\//.test(api) || !token) return toast("Enter a valid HTTPS URL and owner token.");
  sessionStorage.setItem("ubc_api", api); sessionStorage.setItem("ubc_token", token);
  dialog.close(); await refresh();
};
$("refresh").onclick = refresh;
function parseEnv() {
  const result = {};
  for (const line of $("env").value.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const index = text.indexOf("=");
    if (index < 1) throw new Error("Environment lines must use KEY=value.");
    const key = text.slice(0, index).trim();
    let value = text.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate environment variable: ${key}`);
    result[key] = value;
  }
  return result;
}
$("deployForm").onsubmit = async event => {
  event.preventDefault();
  const button = $("deployButton");
  button.disabled = true; button.textContent = "Starting deployment…";
  try {
    const env = parseEnv();
    const result = await request("/api/deployments", {
      method: "POST",
      body: JSON.stringify({ name: $("name").value.trim(), repository: $("repo").value.trim(), env, alwaysCpu: $("alwaysCpu").checked })
    });
    toast("Deployment started. You can watch its progress below.");
    watchJob(result.id);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.innerHTML = 'Deploy backend <span>↗</span>'; }
};
async function watchJob(id) {
  for (let attempt = 0; attempt < 180; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const job = await request(`/api/jobs/${encodeURIComponent(id)}`);
      if (job.status === "succeeded") { toast(`Deployed: ${job.url}`); await refresh(); return; }
      if (job.status === "failed") { toast(job.error || "Deployment failed."); await refresh(); return; }
    } catch (error) { toast(error.message); return; }
  }
  toast("Still deploying. Refresh the projects list shortly.");
}
async function deleteProject(name) {
  if (!confirm(`Delete the Cloud Run service for "${name}"? This cannot be undone.`)) return;
  try { await request(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" }); toast("Backend service deleted."); await refresh(); }
  catch (error) { toast(error.message); }
}
async function checkHealth(name) {
  try {
    const result = await request(`/api/projects/${encodeURIComponent(name)}/health`);
    toast(result.ok ? "Cloud Run service is responding." : "Health check failed.");
  } catch (error) { toast(error.message); }
}
function renderProjects(projects) {
  $("count").textContent = projects.length;
  const root = $("projectList");
  if (!projects.length) {
    root.className = "empty"; root.innerHTML = "<b>No backends deployed yet</b><p>Deploy a GitHub repository to get started.</p>"; return;
  }
  root.className = "";
  root.innerHTML = projects.map(project => `
    <div class="project-row">
      <div><b>${escapeHtml(project.name)}</b><small>${escapeHtml(project.repository)} · ${escapeHtml(project.status)}</small></div>
      <div class="project-actions">
        ${project.url ? `<a href="${escapeHtml(project.url)}" target="_blank" rel="noreferrer">Open API ↗</a>` : ""}
        <button data-health="${escapeHtml(project.name)}">Health</button>
        <button data-delete="${escapeHtml(project.name)}">Delete</button>
      </div>
    </div>`).join("");
  root.querySelectorAll("[data-health]").forEach(button => button.onclick = () => checkHealth(button.dataset.health));
  root.querySelectorAll("[data-delete]").forEach(button => button.onclick = () => deleteProject(button.dataset.delete));
}
async function refresh() {
  $("connection").textContent = "Connecting…";
  if (!settings.api || !settings.token) {
    $("connection").textContent = "Not connected"; $("connectionHint").textContent = "Configure API settings";
    $("count").textContent = "—"; return;
  }
  try {
    const health = await fetch(settings.api + "/api/health").then(r => r.json());
    const data = await request("/api/projects");
    $("connection").textContent = "Connected"; $("connectionHint").textContent = health.region || "Control API online";
    $("region").textContent = health.region || "Cloud Run";
    renderProjects(data.projects || []);
  } catch (error) {
    $("connection").textContent = "Connection error"; $("connectionHint").textContent = error.message; toast(error.message);
  }
}
refresh();
