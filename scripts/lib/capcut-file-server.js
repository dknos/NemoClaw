// Ephemeral HTTP file server — serves local media to Docker CapCut Mate container.
// The container can't access WSL file:// paths, so we spin up a temporary HTTP server
// on 0.0.0.0 and build URLs using the Docker gateway IP.

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME_MAP = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
};

/**
 * Start an ephemeral HTTP server serving files from a directory.
 * Docker container accesses files via http://{gatewayIp}:{port}/{filename}
 *
 * @param {string} dir - Directory containing files to serve
 * @param {object} opts - { port: 0 (auto), gatewayIp: auto-detect, timeout: 300000 }
 * @returns {{ url: string, port: number, close: () => void }}
 */
function startFileServer(dir, opts = {}) {
  const { port = 0, gatewayIp = null, timeout = 300000 } = opts;

  const server = http.createServer((req, res) => {
    const filename = decodeURIComponent(req.url.replace(/^\//, "").split("?")[0]);
    const filePath = path.join(dir, path.basename(filename));

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext] || "application/octet-stream";
    const stat = fs.statSync(filePath);

    // Support range requests for video seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      const actualPort = server.address().port;
      const ip = gatewayIp || detectDockerGateway();
      const baseUrl = `http://${ip}:${actualPort}`;

      // Auto-shutdown after timeout
      const timer = setTimeout(() => {
        console.log(`[capcut-file-server] auto-closing after ${timeout / 1000}s`);
        server.close();
      }, timeout);

      console.log(`[capcut-file-server] serving ${dir} at ${baseUrl}`);

      resolve({
        url: baseUrl,
        port: actualPort,
        close: () => {
          clearTimeout(timer);
          server.close();
          console.log("[capcut-file-server] closed");
        },
      });
    });

    server.on("error", reject);
  });
}

/**
 * Detect Docker gateway IP (how containers reach the host).
 */
function detectDockerGateway() {
  try {
    const { execSync } = require("child_process");
    const out = execSync(
      "docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'",
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch { /* docker inspect may fail */ }
  // Fallback: common Docker gateway
  return "172.17.0.1";
}

/**
 * Write buffers to a temp directory and return filenames.
 * @param {Buffer[]} buffers
 * @param {string} prefix - e.g. "img", "vid", "aud"
 * @param {string} ext - e.g. ".png", ".mp4", ".mp3"
 * @param {string} dir - target directory
 * @returns {string[]} filenames (not full paths)
 */
function writeMediaFiles(buffers, prefix, ext, dir) {
  const names = [];
  for (let i = 0; i < buffers.length; i++) {
    const name = `${prefix}_${i}${ext}`;
    fs.writeFileSync(path.join(dir, name), buffers[i]);
    names.push(name);
  }
  return names;
}

module.exports = { startFileServer, detectDockerGateway, writeMediaFiles };
