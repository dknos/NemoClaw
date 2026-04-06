// CapCut Desktop Export — copy draft from Docker container to CapCut Desktop
// project folder, then automate export via PowerShell.
//
// Phase 3 implementation (stub for now — draft creation works in Phase 1).

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// CapCut Desktop paths (Windows, accessed via /mnt/c/)
const CAPCUT_DESKTOP_PROJECTS = "/mnt/c/Users/rneeb/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft";
const CAPCUT_DESKTOP_EXE = "C:\\Users\\rneeb\\AppData\\Local\\CapCut\\Apps\\CapCut.exe";
const CONTAINER_NAME = "nemoclaw-capcut-mate";

/**
 * Copy a draft from the Docker container to CapCut Desktop's project folder.
 * CapCut Desktop auto-discovers drafts in its project directory.
 *
 * @param {string} draftUrl - Draft URL from CapCut Mate API
 * @returns {{ desktopPath: string, draftId: string }}
 */
async function copyDraftToDesktop(draftUrl) {
  // Extract draft ID from URL (last path segment)
  const draftId = draftUrl.split("/").filter(Boolean).pop();
  if (!draftId) throw new Error("Could not extract draft ID from URL");

  // Docker cp from container
  const containerDraftPath = `/app/output/draft/${draftId}`;
  const tmpLocal = `/tmp/capcut-draft-${draftId}`;
  const desktopPath = path.join(CAPCUT_DESKTOP_PROJECTS, draftId);

  console.log(`[capcut-export] copying draft ${draftId} from container...`);

  // Step 1: Copy from Docker container to WSL tmp
  execSync(`docker cp "${CONTAINER_NAME}:${containerDraftPath}" "${tmpLocal}"`, {
    timeout: 30000, stdio: "pipe",
  });

  // Step 2: Copy to CapCut Desktop project folder
  if (!fs.existsSync(CAPCUT_DESKTOP_PROJECTS)) {
    throw new Error(`CapCut Desktop project folder not found: ${CAPCUT_DESKTOP_PROJECTS}`);
  }

  execSync(`cp -r "${tmpLocal}" "${desktopPath}"`, { timeout: 30000, stdio: "pipe" });
  console.log(`[capcut-export] draft copied to: ${desktopPath}`);

  // Cleanup tmp
  try { fs.rmSync(tmpLocal, { recursive: true, force: true }); } catch { /* cleanup */ }

  return { desktopPath, draftId };
}

/**
 * Rewrite media paths in draft_content.json from HTTP URLs to local Windows paths.
 * CapCut Desktop needs local file:// or absolute paths, not HTTP.
 *
 * @param {string} desktopPath - Path to the draft folder on CapCut Desktop
 * @param {string} fileServerUrl - Base URL of the ephemeral file server
 * @param {string} mediaDir - Local directory containing the media files
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

  // Find all HTTP URLs from our file server and replace with local paths
  const urlPattern = new RegExp(fileServerUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/([^\"]+)", "g");
  const replaced = new Set();

  content = content.replace(urlPattern, (match, filename) => {
    const decodedName = decodeURIComponent(filename);
    const srcPath = path.join(mediaDir, decodedName);
    const destPath = path.join(resourceDir, decodedName);

    // Copy file to Resources/ if not already done
    if (!replaced.has(decodedName) && fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      replaced.add(decodedName);
    }

    // Convert to Windows path for CapCut Desktop
    const winPath = destPath.replace(/^\/mnt\/c\//, "C:\\\\").replace(/\//g, "\\\\");
    return winPath;
  });

  fs.writeFileSync(draftJson, content);
  console.log(`[capcut-export] rewrote ${replaced.size} media paths to local`);
}

/**
 * Trigger CapCut Desktop export via PowerShell keyboard automation.
 * This is the MVP approach — sends Ctrl+E to trigger export.
 *
 * @param {object} opts - { waitMs: 15000, exportTimeoutMs: 300000 }
 * @returns {{ success: boolean, message: string }}
 */
async function triggerDesktopExport(opts = {}) {
  const { exportTimeoutMs = 300000 } = opts;

  console.log("[capcut-export] triggering CapCut Desktop export via PowerShell...");

  const psScript = `
    $capcut = Get-Process -Name 'CapCut' -ErrorAction SilentlyContinue
    if (-not $capcut) {
      Start-Process '${CAPCUT_DESKTOP_EXE}'
      Start-Sleep -Seconds 10
    }
    Add-Type -AssemblyName System.Windows.Forms
    Start-Sleep -Seconds 3
    [System.Windows.Forms.SendKeys]::SendWait('^e')
    Start-Sleep -Seconds 2
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  `.trim().replace(/\n/g, "; ");

  try {
    execSync(`powershell.exe -Command "${psScript}"`, {
      timeout: exportTimeoutMs,
      stdio: "pipe",
    });
    return { success: true, message: "Export triggered — check CapCut Desktop" };
  } catch (e) {
    return { success: false, message: `Export trigger failed: ${e.message}` };
  }
}

/**
 * Full desktop export pipeline: copy draft → rewrite paths → trigger export.
 * Phase 3 — not yet fully automated.
 */
async function exportViaDesktop(draftUrl, fileServerUrl, mediaDir) {
  const { desktopPath, draftId } = await copyDraftToDesktop(draftUrl);
  rewriteMediaPaths(desktopPath, fileServerUrl, mediaDir);
  const exportResult = await triggerDesktopExport();
  return { ...exportResult, desktopPath, draftId };
}

module.exports = {
  copyDraftToDesktop,
  rewriteMediaPaths,
  triggerDesktopExport,
  exportViaDesktop,
  CAPCUT_DESKTOP_PROJECTS,
};
