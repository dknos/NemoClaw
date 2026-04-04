"use strict";

// captcha-solver.js — hCaptcha solver for suno.com using Playwright + Gemini Vision
// Usage: node captcha-solver.js <refresh_token> <prompt>
// Outputs JSON {token, clips} to stdout on success

const { chromium } = require("playwright-core");
const http  = require("http");
const https = require("https");
const fs    = require("fs");

const GEMINI_PORT = 9340;

// ── Clerk auth ────────────────────────────────────────────────────

function httpsReq(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...(opts.headers || {}) };
    let bs = null;
    if (body !== null) { bs = JSON.stringify(body); h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(bs); }
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: opts.method || "GET", headers: h }, (res) => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject);
    if (bs) r.write(bs);
    r.end();
  });
}

async function getAccessToken(refreshToken) {
  const ck = { "Cookie": `__client=${refreshToken}`, "User-Agent": "Mozilla/5.0" };
  const r1 = await httpsReq("https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0", { headers: ck });
  const d1 = JSON.parse(r1.body);
  const sid = d1.response?.last_active_session_id;
  if (!sid) throw new Error("No active Suno session");
  const r2 = await httpsReq(`https://auth.suno.com/v1/client/sessions/${sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0`,
    { method: "POST", headers: { ...ck, "Content-Length": "2" } }, {});
  const d2 = JSON.parse(r2.body);
  if (!d2.jwt) throw new Error("Token renewal failed: " + r2.body.slice(0, 200));
  return d2.jwt;
}

// ── Vision (Gemini on port 9340) ──────────────────────────────────

function askVision(imageBase64, question) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gemini-3.1-flash-lite-preview",
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
        { type: "text", text: question },
      ]}],
      max_tokens: 400,
    });
    const req = http.request({
      hostname: "localhost", port: GEMINI_PORT, path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => {
        try { resolve(JSON.parse(b).choices?.[0]?.message?.content || ""); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main solver ───────────────────────────────────────────────────

async function solve(refreshToken, prompt) {
  const accessToken = await getAccessToken(refreshToken);
  console.error(`[captcha-solver] got access token`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  await ctx.addCookies([
    { name: "__client",  value: refreshToken,  domain: ".suno.com", path: "/", httpOnly: true, secure: true },
    { name: "__session", value: accessToken,   domain: ".suno.com", path: "/", httpOnly: true, secure: true },
    { name: "has_logged_in_before", value: "true", domain: ".suno.com", path: "/" },
  ]);

  const page = await ctx.newPage();
  let captchaToken = null;
  let capturedClips = null;

  // Log ALL requests to studio-api for debugging + intercept generate
  page.on("request", req => {
    if (req.url().includes("studio-api") || req.url().includes("generate")) {
      console.error(`[captcha-solver] >> ${req.method()} ${req.url().replace(/https:\/\/[^/]+/,"")}`);
    }
  });
  page.on("response", async resp => {
    const url = resp.url();
    if (url.includes("generate/v2") || url.includes("generate/v3") || url.includes("generate/v2-web")) {
      // Log request body to understand payload format
      try {
        const reqBody = resp.request().postData() || "";
        console.error(`[captcha-solver] >> body: ${reqBody.slice(0, 400)}`);
      } catch {}
      const body = await resp.text().catch(() => "");
      console.error(`[captcha-solver] << ${resp.status()} ${url.replace(/https:\/\/[^/]+/,"")} ${body.slice(0,200)}`);
      try {
        const data = JSON.parse(body);
        if (data.clips?.length) {
          capturedClips = data.clips;
          console.error(`[captcha-solver] captured ${capturedClips.length} clips from response`);
        }
      } catch {}
    }
    // Log + capture ALL hCaptcha-related responses
    if (url.includes("hcaptcha") || url.includes("suno.com/captcha")) {
      const body = await resp.text().catch(() => "");
      const snippet = body.slice(0, 150);
      console.error(`[captcha-solver] hcaptcha ${resp.status()} ${url.replace(/https?:\/\//,"").slice(0,70)} | ${snippet}`);
      try {
        const data = JSON.parse(body);
        if (data.generated_pass_UUID) {
          captchaToken = data.generated_pass_UUID;
          console.error(`[captcha-solver] captured hCaptcha pass UUID`);
        }
      } catch {}
    }
  });

  // Also intercept to grab captcha token from request body
  await page.route("**/*generate*", async (route) => {
    const url = route.request().url();
    if (url.includes("generate/v2") || url.includes("generate/v3") || url.includes("generate/v2-web")) {
      try {
        const raw = route.request().postData() || "";
        console.error(`[captcha-solver] generate request body: ${raw.slice(0, 400)}`);
        try {
          const body = JSON.parse(raw);
          const token = body?.token || body?.params?.token;
          if (token) { captchaToken = token; console.error(`[captcha-solver] captured captcha token`); }
        } catch {}
      } catch {}
    }
    await route.continue();
  });

  console.error("[captcha-solver] navigating to suno.com/create...");
  await page.goto("https://suno.com/create", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Dismiss cookie banner if present
  try { await page.locator('button:has-text("Reject All"), button:has-text("Accept All")').first().click({ timeout: 2000 }); } catch {}

  // Fill in the prompt — target the visible description textarea (not the lyrics one)
  try {
    const textarea = page.locator("textarea:visible").first();
    await textarea.click({ timeout: 5000 });
    await textarea.fill(prompt);
    console.error(`[captcha-solver] filled prompt: "${prompt.slice(0,50)}"`);
  } catch (e) {
    console.error(`[captcha-solver] textarea error: ${e.message}`);
  }

  // Wait for c/check to complete and button to become enabled
  await page.waitForTimeout(2000);

  // Find and click Create button — try multiple selectors
  let clicked = false;
  for (const sel of ['[aria-label="Create song"]', 'button:has-text("Create"):not([disabled])', 'button[type="button"]:has-text("Create")']) {
    try {
      const btn = page.locator(sel).last();
      const enabled = await btn.isEnabled().catch(() => false);
      const visible = await btn.isVisible().catch(() => false);
      console.error(`[captcha-solver] btn "${sel}": visible=${visible} enabled=${enabled}`);
      if (visible) {
        await btn.click({ timeout: 5000, force: true });
        console.error(`[captcha-solver] clicked Create via "${sel}"`);
        clicked = true;
        break;
      }
    } catch (e) {
      console.error(`[captcha-solver] btn "${sel}" error: ${e.message.slice(0,80)}`);
    }
  }
  if (!clicked) {
    // Last resort: screenshot to see state
    await page.screenshot({ path: "/tmp/suno-pre-click.png" });
    console.error("[captcha-solver] saved pre-click screenshot");
  }

  // Wait up to 25s for hCaptcha images OR a direct generate response (no captcha path)
  console.error("[captcha-solver] waiting for captcha or generate request...");
  let hcaptchaVisible = false;
  try {
    const triggerResp = await page.waitForResponse(
      resp => {
        const u = resp.url();
        return u.includes("getcaptcha") || u.includes("hcaptcha-imgs") ||
               u.includes("generate/v2") || u.includes("generate/v3") || u.includes("generate/v2-web");
      },
      { timeout: 25000 }
    );
    const triggerUrl = triggerResp.url();
    if (triggerUrl.includes("generate")) {
      console.error("[captcha-solver] generate fired directly (no captcha required)");
      await page.waitForTimeout(500); // let response handler finish
    } else {
      hcaptchaVisible = true;
      console.error("[captcha-solver] hCaptcha images detected — challenge rendering");
      await page.waitForTimeout(2500); // let iframe fully paint
    }
  } catch {
    console.error("[captcha-solver] no hCaptcha/generate response after 25s — checking clips...");
    await page.waitForTimeout(2000);
  }

  if (hcaptchaVisible) {
    // Give challenge a moment to fully render
    await page.waitForTimeout(2000);

    // Checkbox is already triggered by Suno auto-verify; challenge likely already open.
    // Try anyway in case widget needs manual click.
    try {
      const allFrames = page.frames();
      console.error(`[captcha-solver] frames: ${allFrames.length}`);
      allFrames.forEach(f => console.error(`  frame: ${f.url().slice(0, 80)}`));
      const widgetFrame = page.frameLocator('iframe[src*="hcaptcha"]:not([title])').first();
      await widgetFrame.locator("#checkbox").click({ timeout: 2000 });
      console.error("[captcha-solver] clicked widget checkbox");
      await page.waitForTimeout(2000);
    } catch { /* challenge may already be showing */ }

    // Solve challenge (may already be open or just opened)
    for (let attempt = 0; attempt < 6; attempt++) {
      if (capturedClips) break; // already got clips, done

      // Detect challenge by presence of hcaptcha-assets iframe with a visible submit button
      let hasChal = false;
      for (const f of page.frames()) {
        if (!f.url().includes("hcaptcha-assets")) continue;
        const vis = await f.locator(".button-submit").isVisible().catch(() => false);
        if (vis) { hasChal = true; break; }
      }
      // Also accept the old title-based selector as fallback
      if (!hasChal) {
        hasChal = await page.locator('iframe[title="hCaptcha challenge"]').isVisible().catch(() => false);
      }

      if (!hasChal) {
        console.error(`[captcha-solver] no challenge on attempt ${attempt+1}, waiting...`);
        await page.waitForTimeout(2000);
        continue;
      }

      console.error(`[captcha-solver] solving with vision (attempt ${attempt+1})...`);
      try {
        // Screenshot just the challenge iframe for better tile resolution
        const chalIframeLocators = await page.locator('iframe[src*="hcaptcha-assets"]').all();
        const chalLocator = chalIframeLocators[chalIframeLocators.length - 1]; // last = challenge, first = widget
        const bbox = await chalLocator.boundingBox().catch(() => null);

        let b64, coordOffset = { x: 0, y: 0 };
        if (bbox && bbox.width > 100) {
          // Crop screenshot to challenge iframe — tiles fill the whole image
          const chalShot = await chalLocator.screenshot({ type: "png" });
          b64 = chalShot.toString("base64");
          coordOffset = { x: bbox.x, y: bbox.y };
          console.error(`[captcha-solver] challenge bbox: ${Math.round(bbox.x)},${Math.round(bbox.y)} ${Math.round(bbox.width)}x${Math.round(bbox.height)}`);
        } else {
          // Fallback to full page
          const shot = await page.screenshot({ type: "png" });
          b64 = shot.toString("base64");
          console.error(`[captcha-solver] bbox unavailable, using full screenshot`);
        }

        const answer = await askVision(b64,
          "This is an hCaptcha challenge. At the top is instruction text describing what to find. " +
          "Below is a grid of image tiles. " +
          "Return ONLY a JSON array [{\"x\":N,\"y\":N}] with the pixel coordinates of the CENTER " +
          "of each tile that matches the instruction. Coordinates are relative to the TOP-LEFT of " +
          "THIS image (0,0). Do not include tiles that do not match. No explanation, just the JSON array."
        );
        console.error(`[captcha-solver] vision: ${answer.slice(0,150)}`);

        let coords = [];
        try { coords = JSON.parse(answer.trim().replace(/```json?|```/g, "").trim()); } catch(e) {
          console.error("[captcha-solver] parse error:", e.message, "raw:", answer.slice(0,100));
        }

        // Map iframe-relative coords back to page coords and click
        for (const { x, y } of coords) {
          const px = coordOffset.x + x;
          const py = coordOffset.y + y;
          await page.mouse.move(px, py, { steps: 8 });
          await page.waitForTimeout(150 + Math.random() * 200);
          await page.mouse.click(px, py);
          await page.waitForTimeout(200 + Math.random() * 150);
        }

        // Submit — iterate all hcaptcha frames, use force:true to bypass interactability checks
        let submitClicked = false;
        for (const f of page.frames()) {
          if (!f.url().includes("hcaptcha-assets")) continue;
          try {
            const btn = f.locator(".button-submit");
            const vis = await btn.isVisible().catch(() => false);
            if (vis) {
              await btn.click({ timeout: 3000, force: true });
              submitClicked = true;
              console.error(`[captcha-solver] submit clicked in frame ${f.url().slice(0,60)}`);
              break;
            }
          } catch (e) {
            console.error(`[captcha-solver] submit click error: ${e.message.slice(0,60)}`);
          }
        }
        if (!submitClicked) console.error("[captcha-solver] WARNING: could not find submit button");
        await page.waitForTimeout(4000); // wait longer for checkcaptcha response

        // Check if challenge closed — re-check for submit button visibility
        let stillVisible = false;
        for (const f of page.frames()) {
          if (!f.url().includes("hcaptcha-assets")) continue;
          const vis = await f.locator(".button-submit").isVisible().catch(() => false);
          if (vis) { stillVisible = true; break; }
        }
        if (!stillVisible) {
          console.error("[captcha-solver] challenge solved!");
          // Try to extract token from DOM (hCaptcha puts it in a hidden textarea)
          await page.waitForTimeout(500);
          try {
            const domToken = await page.evaluate(() => {
              const el = document.querySelector('textarea[name="h-captcha-response"]') ||
                         document.querySelector('[name="h-captcha-response"]');
              return el?.value || null;
            });
            if (domToken && domToken.length > 20) {
              captchaToken = domToken;
              console.error(`[captcha-solver] extracted DOM captcha token (${domToken.length} chars)`);
            }
          } catch (e) {
            console.error(`[captcha-solver] DOM token extract failed: ${e.message}`);
          }
          break;
        }
        console.error(`[captcha-solver] challenge still open, retrying...`);
      } catch (e) {
        console.error(`[captcha-solver] vision error: ${e.message}`);
      }
    }

    // If we already have a DOM token, we're done — suno.js will call generate directly.
    // Otherwise wait for the browser to fire generate automatically (up to 15s).
    if (!captchaToken && !capturedClips) {
      console.error("[captcha-solver] no DOM token — waiting for auto-generate (15s)...");
      try {
        await page.waitForResponse(
          resp => resp.url().includes("generate/v2") || resp.url().includes("generate/v3"),
          { timeout: 15000 }
        );
        await page.waitForTimeout(1000);
        console.error("[captcha-solver] generate request fired automatically");
      } catch {
        console.error("[captcha-solver] no auto-generate — trying Create re-click...");
        try {
          for (const sel of ['[aria-label="Create song"]', 'button:has-text("Create"):not([disabled])']) {
            const btn = page.locator(sel).last();
            if (await btn.isVisible().catch(() => false)) {
              await btn.click({ timeout: 3000, force: true });
              console.error(`[captcha-solver] re-clicked Create via "${sel}"`);
              break;
            }
          }
          await page.waitForResponse(
            resp => resp.url().includes("generate/v2") || resp.url().includes("generate/v3"),
            { timeout: 15000 }
          );
          await page.waitForTimeout(1000);
          console.error("[captcha-solver] generate request fired after re-click");
        } catch (e) {
          console.error(`[captcha-solver] second attempt failed: ${e.message}`);
        }
      }
    } else {
      console.error("[captcha-solver] have token/clips, skipping generate wait");
    }
  }

  await browser.close();

  // Return captured clips (full generation) or just the captcha token
  if (capturedClips) {
    process.stdout.write(JSON.stringify({ clips: capturedClips }));
    process.exit(0);
  }
  if (captchaToken) {
    process.stdout.write(JSON.stringify({ token: captchaToken }));
    process.exit(0);
  }
  throw new Error("Could not extract captcha token or clips");
}

const [,, refreshToken, prompt] = process.argv;
if (!refreshToken) { console.error("Usage: node captcha-solver.js <refresh_token> <prompt>"); process.exit(1); }

solve(refreshToken, prompt || "upbeat pop song")
  .catch(e => { console.error("[captcha-solver] fatal:", e.message); process.exit(1); });
