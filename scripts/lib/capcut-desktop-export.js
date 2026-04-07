// CapCut Desktop Export — copy draft from Docker container to CapCut Desktop
// project folder, trigger export, watch for output file, return path for upload.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// CapCut Desktop paths (Windows, accessed via /mnt/c/)
const CAPCUT_DESKTOP_PROJECTS = "/mnt/c/Users/rneeb/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft";
const CAPCUT_DESKTOP_EXE = "C:\\Users\\rneeb\\AppData\\Local\\CapCut\\Apps\\CapCut.exe";
const CONTAINER_NAME = "nemoclaw-capcut-mate";
const CAPCUT_DOWNLOADS_DIR = "/mnt/c/Users/rneeb/Downloads/CapCut-Drafts";

// Export output directory — CapCut exports to the same folder the draft was opened from
const CAPCUT_EXPORT_DIR = "/mnt/c/Users/rneeb/Downloads/CapCut-Drafts";
const EXPORT_POLL_MS = 3000;        // poll every 3s
const EXPORT_TIMEOUT_MS = 300000;   // 5 min max
const FILE_STABLE_CHECKS = 3;       // file size must be stable for 3 consecutive checks (9s)

/**
 * Copy a draft from the Docker container to CapCut Desktop's project folder.
 * Also copies to Downloads/CapCut-Drafts with a friendly name for easy access.
 * @param {string} draftUrl
 * @param {object} opts
 * @param {string} [opts.draftName] - friendly label e.g. "brainslop-vertical-2026-04-06_09-36"
 */
async function copyDraftToDesktop(draftUrl, opts = {}) {
  let draftId;
  try {
    const parsed = new URL(draftUrl, "http://localhost");
    draftId = parsed.searchParams.get("draft_id");
  } catch { /* not a valid URL */ }
  if (!draftId) draftId = draftUrl.split("/").filter(Boolean).pop();
  if (draftId && draftId.includes("?")) draftId = draftId.split("?")[0];
  if (!draftId) throw new Error("Could not extract draft ID from URL");

  const containerDraftPath = `/app/output/draft/${draftId}`;
  const tmpLocal = `/tmp/capcut-draft-${draftId}`;
  const desktopPath = path.join(CAPCUT_DESKTOP_PROJECTS, draftId);

  // Build friendly name: use provided label or timestamp
  const ts = new Date().toISOString().slice(0, 16).replace("T", "_").replace(/:/g, "-");
  const friendlyName = (opts.draftName || `capcut-${ts}`).replace(/[^a-zA-Z0-9_\-. ]/g, "");
  const downloadsPath = path.join(CAPCUT_DOWNLOADS_DIR, friendlyName);

  console.log(`[capcut-export] copying draft ${draftId} from container...`);

  execSync(`docker cp "${CONTAINER_NAME}:${containerDraftPath}" "${tmpLocal}"`, {
    timeout: 30000, stdio: "pipe",
  });

  if (!fs.existsSync(CAPCUT_DESKTOP_PROJECTS)) {
    throw new Error(`CapCut Desktop project folder not found: ${CAPCUT_DESKTOP_PROJECTS}`);
  }

  execSync(`cp -r "${tmpLocal}" "${desktopPath}"`, { timeout: 30000, stdio: "pipe" });
  console.log(`[capcut-export] draft copied to: ${desktopPath}`);

  // Patch draft_meta_info.json: set friendly name + correct Windows paths
  const metaPath = path.join(desktopPath, "draft_meta_info.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const winProjectsRoot = "C:\\Users\\rneeb\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft";
      meta.draft_name = friendlyName;
      meta.draft_root_path = winProjectsRoot;
      meta.draft_fold_path = `${winProjectsRoot}\\${draftId}`;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 4));
      console.log(`[capcut-export] draft_name set to: ${friendlyName}`);
    } catch (e) {
      console.warn(`[capcut-export] could not patch meta: ${e.message}`);
    }
  }

  // Also copy to Downloads for easy access
  try {
    if (!fs.existsSync(CAPCUT_DOWNLOADS_DIR)) fs.mkdirSync(CAPCUT_DOWNLOADS_DIR, { recursive: true });
    execSync(`cp -r "${desktopPath}" "${downloadsPath}"`, { timeout: 30000, stdio: "pipe" });
    console.log(`[capcut-export] draft also in Downloads: ${downloadsPath}`);
  } catch (e) {
    console.warn(`[capcut-export] Downloads copy failed: ${e.message}`);
  }

  try { fs.rmSync(tmpLocal, { recursive: true, force: true }); } catch { /* cleanup */ }

  return { desktopPath, draftId, downloadsPath, friendlyName };
}

/**
 * Rewrite media paths in draft_content.json.
 * Handles two cases:
 *   1. HTTP file-server URLs → copied to Resources/ and rewritten to Windows paths
 *   2. Docker container paths (/app/output/draft/{id}/assets/...) → assets were
 *      already docker-cp'd into desktopPath/assets/, rewrite to Windows paths in-place
 */
function rewriteMediaPaths(desktopPath, fileServerUrl, mediaDir) {
  const draftJson = path.join(desktopPath, "draft_content.json");
  if (!fs.existsSync(draftJson)) {
    console.warn("[capcut-export] draft_content.json not found, skipping path rewrite");
    return;
  }

  let content = fs.readFileSync(draftJson, "utf8");
  const resourceDir = path.join(desktopPath, "Resources");
  if (!fs.existsSync(resourceDir)) fs.mkdirSync(resourceDir, { recursive: true });

  // 1. Rewrite HTTP file-server URLs (copy file to Resources/)
  let httpReplaced = 0;
  if (fileServerUrl) {
    const urlPattern = new RegExp(fileServerUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/([^\"]+)", "g");
    const replaced = new Set();
    content = content.replace(urlPattern, (match, filename) => {
      const decodedName = decodeURIComponent(filename);
      const srcPath = path.join(mediaDir, decodedName);
      const destPath = path.join(resourceDir, decodedName);
      if (!replaced.has(decodedName) && fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        replaced.add(decodedName);
      }
      httpReplaced++;
      return destPath.replace(/^\/mnt\/c\//, "C:\\\\").replace(/\//g, "\\\\");
    });
  }

  // 2. Rewrite Docker container paths (/app/output/draft/{draftId}/...)
  // Assets were already copied by docker cp into desktopPath — just fix the path prefix.
  const draftId = path.basename(desktopPath);
  const dockerPrefix = `/app/output/draft/${draftId}/`;
  const winDesktopPath = desktopPath.replace(/^\/mnt\/c\//, "C:\\").replace(/\//g, "\\");
  let dockerReplaced = 0;
  content = content.replace(/"path"\s*:\s*"([^"]+)"/g, (match, pathVal) => {
    // Unescape any existing JSON backslashes to plain string
    const plain = pathVal.replace(/\\\\/g, "/").replace(/\\/g, "/");
    if (!plain.startsWith("/app/output/draft/")) return match;
    // Replace docker prefix with Windows desktop path, normalize all slashes
    const relative = plain.slice(dockerPrefix.length);
    const winPath = (winDesktopPath + "\\" + relative).replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
    dockerReplaced++;
    // Re-escape for JSON
    return `"path": "${winPath.replace(/\\/g, "\\\\")}"`;
  });

  fs.writeFileSync(draftJson, content);

  // Walk ALL files in the draft folder (Timelines/, .bak, .tmp, etc.) and fix Docker paths
  let totalDockerFixed = dockerReplaced;
  function walkAndFix(dir) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) { walkAndFix(full); continue; }
      if (!/\.(json|tmp|bak)$/.test(f)) continue;
      if (full === draftJson) continue; // already done above
      let fc;
      try { fc = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (!fc.includes("/app/output/draft/")) continue;
      let fixed = 0;
      const newFc = fc.replace(/"path"\s*:\s*"([^"]+)"/g, (match, pathVal) => {
        const plain = pathVal.replace(/\\\\/g, "/").replace(/\\/g, "/");
        if (!plain.startsWith("/app/output/draft/")) return match;
        const relative = plain.slice(dockerPrefix.length).replace(/\//g, "\\");
        fixed++;
        return `"path": "${(winDesktopPath + "\\" + relative).replace(/\\/g, "\\\\")}"`;
      });
      if (fixed > 0) { fs.writeFileSync(full, newFc); totalDockerFixed += fixed; }
    }
  }
  walkAndFix(desktopPath);

  console.log(`[capcut-export] rewrote ${httpReplaced} HTTP + ${totalDockerFixed} Docker paths to local Windows`);
}

/**
 * Snapshot all existing .mp4 files in the export directory.
 * Called BEFORE triggering export so we can detect new files.
 */
function snapshotExistingFiles() {
  if (!fs.existsSync(CAPCUT_EXPORT_DIR)) return new Set();
  return new Set(
    fs.readdirSync(CAPCUT_EXPORT_DIR)
      .filter(f => f.endsWith(".mp4"))
      .map(f => path.join(CAPCUT_EXPORT_DIR, f))
  );
}

/**
 * Poll the export directory for a new .mp4 file, wait for it to finish writing.
 * @param {Set<string>} existingFiles - snapshot from before export trigger
 * @param {number} timeoutMs - max wait time
 * @returns {string} absolute path to the new .mp4 file
 */
async function waitForExportedFile(existingFiles, timeoutMs = EXPORT_TIMEOUT_MS) {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let candidatePath = null;
  let lastSize = -1;
  let stableCount = 0;

  console.log(`[capcut-export] watching ${CAPCUT_EXPORT_DIR} for new .mp4 (timeout ${timeoutMs / 1000}s)...`);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, EXPORT_POLL_MS));

    if (!fs.existsSync(CAPCUT_EXPORT_DIR)) continue;

    const currentFiles = fs.readdirSync(CAPCUT_EXPORT_DIR)
      .filter(f => f.endsWith(".mp4"))
      .map(f => path.join(CAPCUT_EXPORT_DIR, f));

    const newFiles = currentFiles.filter(f => !existingFiles.has(f));

    if (newFiles.length > 0) {
      // Pick the most recently modified new file
      candidatePath = newFiles.sort((a, b) =>
        fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      )[0];

      const stat = fs.statSync(candidatePath);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

      if (stat.size === lastSize && stat.size > 0) {
        stableCount++;
        if (stableCount >= FILE_STABLE_CHECKS) {
          console.log(`[capcut-export] export complete: ${path.basename(candidatePath)} (${sizeMB}MB, ${elapsed}s)`);
          return candidatePath;
        }
        console.log(`[capcut-export] file stable check ${stableCount}/${FILE_STABLE_CHECKS} (${sizeMB}MB, ${elapsed}s)`);
      } else {
        stableCount = 0;
        lastSize = stat.size;
        console.log(`[capcut-export] exporting... ${sizeMB}MB (${elapsed}s)`);
      }
    }
  }

  throw new Error(
    candidatePath
      ? `Export file appeared but never stabilized: ${path.basename(candidatePath)}`
      : `No new .mp4 appeared in ${CAPCUT_EXPORT_DIR} within ${timeoutMs / 1000}s`
  );
}

/**
 * Trigger CapCut Desktop export via PowerShell, then watch for output file.
 * @returns {{ success: boolean, message: string, filePath: string|null }}
 */
async function triggerDesktopExport(opts = {}) {
  const { exportTimeoutMs = EXPORT_TIMEOUT_MS } = opts;

  // Step 1: Snapshot existing files BEFORE triggering
  const existingFiles = snapshotExistingFiles();
  console.log(`[capcut-export] ${existingFiles.size} existing .mp4 files in Videos/`);

  // Step 2: Write and fire PowerShell script
  const psPath = "/tmp/capcut-export.ps1";
  const psScript = [
    "$capcut = Get-Process -Name 'CapCut' -ErrorAction SilentlyContinue",
    "if (-not $capcut) {",
    `  Start-Process '${CAPCUT_DESKTOP_EXE}'`,
    "  Start-Sleep -Seconds 10",
    "}",
    "Add-Type -AssemblyName System.Windows.Forms",
    "# Bring CapCut to foreground",
    "$wshell = New-Object -ComObject WScript.Shell",
    "$wshell.AppActivate('CapCut')",
    "Start-Sleep -Seconds 2",
    "[System.Windows.Forms.SendKeys]::SendWait('^e')",
    "Start-Sleep -Seconds 2",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
  ].join("\n");
  fs.writeFileSync(psPath, psScript);

  console.log("[capcut-export] sending export keystrokes via PowerShell...");
  try {
    execSync(`powershell.exe -ExecutionPolicy Bypass -File "${psPath}"`, {
      timeout: 30000, stdio: "pipe",
    });
    console.log("[capcut-export] keystrokes sent, waiting for export file...");
  } catch (e) {
    console.warn(`[capcut-export] PowerShell warning: ${e.message.slice(0, 200)}`);
    // Don't fail yet — CapCut may still be exporting even if PS had issues
  } finally {
    try { fs.unlinkSync(psPath); } catch { /* cleanup */ }
  }

  // Step 3: Wait for new .mp4 to appear and finish writing
  try {
    const filePath = await waitForExportedFile(existingFiles, exportTimeoutMs);
    return { success: true, message: "Export complete", filePath };
  } catch (e) {
    return { success: false, message: e.message, filePath: null };
  }
}

/**
 * Full desktop export pipeline: copy draft → rewrite paths → trigger export → wait for file.
 * @returns {{ success: boolean, message: string, filePath: string|null, desktopPath: string, draftId: string }}
 */
async function exportViaDesktop(draftUrl, fileServerUrl, mediaDir, opts = {}) {
  const { desktopPath, draftId, downloadsPath, friendlyName } = await copyDraftToDesktop(draftUrl, opts);
  rewriteMediaPaths(desktopPath, fileServerUrl, mediaDir);

  // Give CapCut Desktop a moment to detect the new draft
  await new Promise(r => setTimeout(r, 3000));

  const exportResult = await triggerDesktopExport(opts);
  return { ...exportResult, desktopPath, draftId, downloadsPath, friendlyName };
}

module.exports = {
  copyDraftToDesktop,
  rewriteMediaPaths,
  triggerDesktopExport,
  exportViaDesktop,
  snapshotExistingFiles,
  waitForExportedFile,
  CAPCUT_DESKTOP_PROJECTS,
  CAPCUT_EXPORT_DIR,
  CAPCUT_DOWNLOADS_DIR,
};
