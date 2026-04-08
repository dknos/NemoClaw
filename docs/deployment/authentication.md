---
title:
  page: "Authentication Configuration"
  nav: "Authentication"
description:
  main: "Configure device authentication for the OpenClaw gateway, including the NEMOCLAW_DISABLE_DEVICE_AUTH build argument."
  agent: "Documents the NEMOCLAW_DISABLE_DEVICE_AUTH build argument and device authentication configuration. Use when configuring gateway authentication, disabling device auth, or reviewing auth security implications."
keywords: ["nemoclaw authentication", "device auth disable build arg"]
topics: ["generative_ai", "ai_agents"]
tags: ["nemoclaw", "security", "authentication", "deployment"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "engineer", "security_engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Authentication Configuration

This page documents the device authentication settings for the OpenClaw gateway, including the `NEMOCLAW_DISABLE_DEVICE_AUTH` build argument and related security controls.

## `NEMOCLAW_DISABLE_DEVICE_AUTH`

**Location**: Dockerfile build argument (line 59), propagated to `openclaw.json` as `dangerouslyDisableDeviceAuth`.
**Default**: `0` (device auth enabled — secure by default).

### What It Does

When set to `1`, the OpenClaw gateway skips the OAuth 2.0 Device Authorization Grant flow.
Users are not prompted to authenticate via browser-based device code approval before accessing the gateway API.

The setting is baked into `openclaw.json` at image build time and verified by a SHA256 integrity hash at container startup.
It cannot be changed at runtime.

### When to Disable (Set to `1`)

Disable device auth only when:

- The sandbox runs locally with no network exposure (single-user, localhost only).
- The environment is headless with no browser available to complete the device auth flow.
- The NemoClaw Docker sandbox is the only consumer (the default `nemoclaw onboard` flow handles this automatically).

```console
$ docker build --build-arg NEMOCLAW_DISABLE_DEVICE_AUTH=1 -t nemoclaw-sandbox .
```

### When to Keep Enabled (Default `0`)

Keep device auth enabled when:

- The gateway is network-accessible beyond localhost.
- Multiple users or external clients connect to the same instance.
- The sandbox is exposed via a tunnel (for example, cloudflared) or LAN binding.
- You need per-device audit trails.

### Security Implications

| Setting | Risk | Use Case |
|---------|------|----------|
| `0` (enabled, default) | Requires browser-based approval; gateway generates per-device tokens | Multi-user, external access, production |
| `1` (disabled) | Anyone with network access to the gateway can use it without authentication | Single-user local/Docker, headless development |

:::{warning}
Disabling device auth on a network-accessible gateway creates an unauthenticated endpoint.
Combined with a cloudflared tunnel or LAN-bind changes in remote deployments, this results in a publicly reachable, unauthenticated dashboard.
:::

### Related Settings

`allowInsecureAuth`
: Derived automatically from the `CHAT_UI_URL` scheme at build time.
  When the URL uses `http://` (local development), insecure auth is allowed.
  When it uses `https://`, insecure auth is blocked.
  See [Security Best Practices](../security/best-practices.md) for details.

`auth.token`
: A gateway bearer token generated at build time using `secrets.token_hex(32)`.
  Unique per image build.

`trustedProxies`
: IPs allowed to set `X-Forwarded-For` headers.
  Defaults to `127.0.0.1` and `::1`.

## Next Steps

- [Security Best Practices](../security/best-practices.md) for the full gateway authentication controls reference.
- [Sandbox Hardening](sandbox-hardening.md) for container-level security measures.
- [Deploy to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment considerations.
