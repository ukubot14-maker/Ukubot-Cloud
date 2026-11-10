require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { deploy, deleteService, describeService, serviceName } = require("./deployer");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const OWNER_TOKEN = process.env.OWNER_TOKEN;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const REGION = process.env.GOOGLE_CLOUD_REGION || "us-west1";
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "projects.json");
const origins = (process.env.ALLOWED_ORIGINS || "http://localhost:8080")
  .split(",").map(value => value.trim()).filter(Boolean);

if (!OWNER_TOKEN || OWNER_TOKEN.length < 32) {
  console.error("OWNER_TOKEN must be a random secret of at least 32 characters.");
  process.exit(1);
}
if (!PROJECT_ID) {
  console.error("GOOGLE_CLOUD_PROJECT is required.");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    callback(new Error("Origin not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "64kb" }));
app.use("/api", rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(process.cwd(), "dashboard")));

const projects = new Map();
const jobs = new Map();

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const data = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    for (const project of data.projects || []) projects.set(project.name, project);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load project state:", error.message);
  }
}
let saveQueue = Promise.resolve();
function saveState() {
  const snapshot = JSON.stringify({ projects: [...projects.values()] }, null, 2);
  saveQueue = saveQueue.then(async () => {
    const temp = STATE_FILE + ".tmp";
    await fs.writeFile(temp, snapshot, { mode: 0o600 });
    await fs.rename(temp, STATE_FILE);
  }).catch(error => console.error("Could not save state:", error.message));
  return saveQueue;
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function ownerOnly(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!safeEqual(token, OWNER_TOKEN)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function validName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(value);
}
function validRepository(value) {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname);
  } catch { return false; }
}
function validateEnv(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Environment variables must be an object.");
  const entries = Object.entries(value);
  if (entries.length > 40) throw new Error("A maximum of 40 environment variables is allowed.");
  const output = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    const val = String(raw);
    if (val.length > 4000) throw new Error(`Environment variable ${key} is too long.`);
    output[key] = val;
  }
  return output;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Ukubot Cloud", region: REGION }));
app.get("/api/projects", ownerOnly, (_req, res) => {
  res.json({ projects: [...projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
});
app.get("/api/jobs/:id", ownerOnly, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.post("/api/deployments", ownerOnly, async (req, res) => {
  const { name, repository } = req.body || {};
  if (!validName(name)) return res.status(400).json({ error: "Use 3–32 lowercase letters/numbers/hyphens; start with a letter." });
  if (!validRepository(repository)) return res.status(400).json({ error: "Use a public GitHub URL: https://github.com/owner/repository" });
  if ([...jobs.values()].some(job => job.name === name && ["queued", "running"].includes(job.status))) {
    return res.status(409).json({ error: "This project already has a deployment in progress." });
  }
  let env;
  try { env = validateEnv(req.body.env); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const id = crypto.randomUUID();
  const alwaysCpu = req.body.alwaysCpu === true;
  const job = { id, name, status: "queued", output: [], createdAt: new Date().toISOString() };
  jobs.set(id, job);
  const old = projects.get(name);
  projects.set(name, {
    name, repository, service: serviceName(name),
    url: old?.url || null, status: "deploying",
    createdAt: old?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await saveState();
  res.status(202).json({ id, status: job.status });

  (async () => {
    job.status = "running";
    const append = line => {
      if (!line) return;
      job.output.push({ at: new Date().toISOString(), message: String(line).slice(0, 12000) });
      job.output = job.output.slice(-100);
    };
    try {
      const result = await deploy({ name, repository, env, alwaysCpu, onOutput: append });
      job.status = "succeeded";
      job.url = result.url;
      job.completedAt = new Date().toISOString();
      const project = projects.get(name);
      Object.assign(project, { url: result.url, status: "deployed", updatedAt: new Date().toISOString() });
      append(`Deployment successful: ${result.url}`);
    } catch (error) {
      job.status = "failed";
      job.error = String(error.message || error).slice(0, 2000);
      const project = projects.get(name);
      Object.assign(project, { status: "failed", updatedAt: new Date().toISOString() });
      append(job.error);
    }
    await saveState();
  })();
});

app.delete("/api/projects/:name", ownerOnly, async (req, res) => {
  const project = projects.get(req.params.name);
  if (!project) return res.status(404).json({ error: "Project not found." });
  try {
    await deleteService(project.name);
    projects.delete(project.name);
    await saveState();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error).slice(0, 1500) });
  }
});

app.get("/api/projects/:name/health", ownerOnly, async (req, res) => {
  const project = projects.get(req.params.name);
  if (!project) return res.status(404).json({ error: "Project not found." });
  try {
    const details = await describeService(project.name);
    res.json({
      ok: true,
      url: details.status?.url || project.url,
      conditions: details.status?.conditions || [],
      latestCreatedRevision: details.status?.latestCreatedRevisionName || null,
      latestReadyRevision: details.status?.latestReadyRevisionName || null
    });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error).slice(0, 1500) });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (String(error.message).includes("CORS")) return res.status(403).json({ error: "Origin is not allowed." });
  res.status(500).json({ error: "Internal server error." });
});

async function start() {
  await loadState();
  app.listen(PORT, "0.0.0.0", () => console.log(`Ukubot Cloud control plane listening on port ${PORT}`));
}
start();
