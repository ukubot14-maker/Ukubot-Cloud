const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const REGION = process.env.GOOGLE_CLOUD_REGION || "us-west1";
const TIMEOUT = Number(process.env.DEPLOY_TIMEOUT_MS || 1800000);

function serviceName(name) {
  return `ubc-${name}`.slice(0, 49).replace(/-+$/, "");
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    timeout: TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
    ...options
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

async function deploy({ name, repository, env = {}, alwaysCpu = false, onOutput = () => {} }) {
  if (!PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is not configured.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ukubot-build-"));
  const service = serviceName(name);
  const envFile = path.join(dir, "runtime-env.yaml");

  try {
    onOutput("Cloning source repository…");
    await run("git", ["clone", "--depth", "1", repository, dir], { timeout: 180000 });

    onOutput("Preparing runtime environment variables…");
    await fs.writeFile(envFile, JSON.stringify(env, null, 2), { mode: 0o600 });

    onOutput("Building and deploying to Google Cloud Run. This can take several minutes…");
    const deployArgs = [
      "run", "deploy", service,
      "--source", dir,
      "--project", PROJECT,
      "--region", REGION,
      "--platform", "managed",
      "--allow-unauthenticated",
      "--port", "8080",
      "--memory", "1Gi",
      "--cpu", "1",
      "--min", "0",
      "--max", "1",
      "--concurrency", "40",
      "--env-vars-file", envFile,
      "--quiet"
    ]);
    onOutput((result.stdout + "\n" + result.stderr).trim().slice(-12000));

    const details = await run("gcloud", [
      "run", "services", "describe", service,
      "--project", PROJECT,
      "--region", REGION,
      "--format=value(status.url)"
    ], { timeout: 60000 });
    const url = details.stdout.trim();
    if (!url.startsWith("https://")) throw new Error("Deployment finished, but Cloud Run did not return an HTTPS URL.");
    return { service, url, region: REGION };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function deleteService(name) {
  if (!PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is not configured.");
  await run("gcloud", [
    "run", "services", "delete", serviceName(name),
    "--project", PROJECT, "--region", REGION, "--quiet"
  ], { timeout: 180000 });
  return true;
}

async function describeService(name) {
  if (!PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is not configured.");
  const result = await run("gcloud", [
    "run", "services", "describe", serviceName(name),
    "--project", PROJECT, "--region", REGION,
    "--format=json"
  ], { timeout: 60000 });
  return JSON.parse(result.stdout);
}

module.exports = { deploy, deleteService, describeService, serviceName };
