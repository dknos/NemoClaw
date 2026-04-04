# Build & Incident Log

## 2026-04-01 — Pipes (discord-bridge) Syntax Error

### Incident
- **Time:** ~14:30 UTC
- **Agent:** mrbigpipes_ai (discord-bridge.js)
- **Issue:** Process crashed on startup with `SyntaxError: Missing catch or finally after try`
- **Cause:** Incomplete edit to disable auto-posting feature left orphaned closing braces

### Root Cause
When disabling the auto-post-to-Instagram feature, I commented out the `if` statement but left dangling error handling code:
```javascript
// DISABLED: No auto-posting...
// const userWantsPost = /post.*(instagram|ig|insta)...
// if (userWantsPost && !bufferMatch && ...) {
    await msg.reply(`Auto-post failed: ${e.message.slice(0, 200)}`);  // ← orphaned
  }  // ← orphaned closing brace
}
```

### Fix
Removed all orphaned code:
```javascript
// DISABLED: No auto-posting to Instagram without explicit user request
// User must explicitly run /post command or ask the agent to post
```

### Prevention
- **Linting:** ESLint will catch this. Run before deploy:
  ```bash
  npm run lint:cli  # Type-checks and lints bin/ and scripts/
  ```
- **Git hook:** `pre-push` already runs type-checking, but syntax errors bypass tsc
- **Manual check:** Always validate modified code paths:
  ```bash
  node -c scripts/discord-bridge.js  # Check syntax only
  ```

### Related Changes
This incident was part of fixing the auto-posting vulnerability:
- **Disabled:** Auto-post to Instagram when image is mentioned (security issue)
- **Updated:** Candy's Graph API Instagram/Facebook posting (wrong endpoints)
- **Updated:** Pipes' `/post` command to use correct Graph API flow

---

## Checklist for Future Edits

Before restarting any agent:
- [ ] Run `npm run lint:cli` (catches syntax errors, type issues)
- [ ] Run `node -c scripts/[agent].js` (quick syntax validation)
- [ ] Check logs after restart: `pm2 logs [agent] --lines 10`
- [ ] Verify agent has reconnected: `pm2 list`

## Files Modified This Session

| File | Changes | Status |
|------|---------|--------|
| `discord-bridge.js` | Disabled auto-post, fixed model detection | ✅ |
| `social-media-tools.js` | Fixed Image generation, Graph API Instagram/FB | ✅ |
| `candy.js` | Image generation to Discord, team awareness | ✅ |

