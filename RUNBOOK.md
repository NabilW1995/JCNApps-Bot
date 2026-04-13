# JCNApps-Bot Runbook

Quick reference for keeping the bot alive in production. Written for a
single-operator setup (Coolify + Hetzner + Cloudflare).

## At a Glance

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe used by Docker / Coolify. Cheap, sub-100ms. |
| `GET /health/deep` | Synthetic probe for DB + Slack + GitHub. ~100ms-4s. Returns 503 when any dependency is down. |
| `GET /build-info` | Confirms which build is actually running. |
| `POST /admin/refresh?repo=PassCraft&target=all` | Force-rebuild the pinned tables for a repo. Manual recovery. |

Every response carries an `x-request-id` header. Quote it when filing
bug reports — every log line for that request will include the same id.

## Feature Flags (env vars)

All flags default to **enabled**. Set the env var to `false`, `0`,
`off`, or `no` and restart the container to disable a path.

| Flag | Disables |
|---|---|
| `FF_RECONCILER` | Active-channel pinned message reconciler (Phase 1). |
| `FF_MORNING_CRON` | Daily 06:00 UTC overview digest. |
| `FF_BUG_DETAILS_MODAL` | Slack "Details" button on the bugs table. |
| `FF_GITHUB_COMMENT_SYNC` | GitHub comment -> Slack thread mirror. |
| `FF_PUSH_RECONCILE` | Push webhook -> touchIssue + reconcile pipeline. |

## Common Failures

### 1. Pinned message in #passcraft-pro-active is stale or wrong

**Symptoms**: Issues that were closed still show up, or a fresh claim
isn't visible.

**Fix**:

```
curl -X POST 'https://bot.synq.pro/admin/refresh?repo=PassCraft&target=active'
```

If that returns 200 but the message still doesn't update, the saved
pinned-message timestamp may point to a deleted Slack message. Check
the bot logs for `message_not_found` — the reconciler will recreate
the pinned message on the next call automatically.

### 2. Slack token revoked / invalid_auth in `/health/deep`

**Symptoms**: `/health/deep` returns 503 with `slack.error: "invalid_auth"`.

**Fix**:

1. Re-issue the bot token in https://api.slack.com/apps -> OAuth & Permissions.
2. Update `SLACK_BOT_TOKEN` in Coolify env config.
3. Restart the container.
4. Re-check `/health/deep` — should report `ok`.

The bot will still serve cached state during the outage but cannot
post new messages.

### 3. Database connection refused

**Symptoms**: `/health` returns `database: "disconnected"`.
`/health/deep` returns 503 with `database.error: "connection refused"`.

**Fix**:

1. Coolify -> the postgres service for the bot. Check it's running.
2. Verify `DATABASE_URL` matches the postgres internal hostname/port.
3. Restart the bot container — Drizzle reconnects on the next request.

### 4. GitHub rate limit exceeded

**Symptoms**: `/health/deep` reports `github.status: "down"` with a
4xx error. Webhook handlers log `secondary rate limit`.

**Fix**:

- If the bot has no `GITHUB_PAT` set, the public anonymous quota is
  60/hour. Add a PAT to push the limit to 5000/hour.
- If a PAT is already set, wait until the next hourly window.
- Disable the noisiest reactive paths temporarily:
  `FF_PUSH_RECONCILE=false` cuts the loudest one.

### 5. Morning digest didn't fire

**Symptoms**: No `:sunrise:` message in the overview channel after 06:00 UTC.

**Diagnosis**:

```
grep '"Morning cron' bot-logs.json
```

- `Morning cron skipped (FF_MORNING_CRON disabled)` -> a flag is off.
- `Morning cron failed` -> read the `error` field in the same log line.
- Nothing at all -> the cron timer didn't start. Likely the bot
  restarted between 05:59 and 06:01 UTC and missed the window. It
  will fire automatically tomorrow.

### 6. Webhook signature verification failures

**Symptoms**: `/webhooks/github` returns 401 in the logs.

**Fix**: GitHub re-issues the webhook secret when the webhook is
edited in the repo settings UI. Re-sync `GITHUB_WEBHOOK_SECRET` in
Coolify and restart.

## Rollback

The bot deploys via Coolify pulling the latest commit on `main`. To
roll back fast:

1. `git revert <bad-sha>` on a feature branch and push -> open PR -> merge.
2. Coolify auto-deploys main. Wait for the build to finish (~2 min).
3. `curl https://bot.synq.pro/build-info` -> verify `buildId` updated.

For a faster knockout (no rebuild), flip the relevant `FF_*` flag to
`false` in Coolify env config and restart the container only.

## Adding a New Repo

1. Add channel ids and webhook URLs to `.env` for the new repo
   (follow the `PASSCRAFT_*` naming pattern).
2. Add an entry to `src/config/channels.ts`.
3. Hit `POST /admin/refresh?repo=<NewRepo>&target=all` to seed the
   pinned messages.
4. Verify `/health/deep` is still `ok`.

## Where Logs Live

Coolify -> the bot service -> Logs tab. Logs are JSON lines so you can
pipe them to `jq` for filtering:

```
... | jq 'select(.level == "error")'
... | jq 'select(.requestId == "abc-123")'
```

The `requestId` field correlates every log line for a single inbound
HTTP request — extremely useful for debugging webhook flows.
