# pi-cron

Scheduled prompts for the [pi coding agent](https://github.com/earendil-works/pi), modelled on [Hermes Agent's cron jobs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

A job is **a prompt + a schedule + the tools the run may use**. At the due time a fresh, unattended pi session runs the prompt with exactly those tools. The answer is saved as Markdown, and you can also get it as a desktop notification, a Telegram message or a webhook call.

- **Runs even when pi is closed.** A small OS service (launchd on macOS, cron on Linux) checks every minute.
- **Survives restarts.** Jobs live in `~/.pi/agent/cron/jobs.json`. Missed runs after sleep or a reboot are caught up **once**, never once per missed slot.
- **Least-privilege runs.** Each job has its own tool allowlist (`pi --tools`), plus optional skills and model.
- **Isolated sessions.** Every run is its own pi session with no memory of your chat. The full transcript is kept for debugging.

![pi-cron](screenshot.png)

## Installation

```bash
pi install npm:@patimweb/pi-cron

# or from a local checkout
pi install /path/to/pi-cron
```

Requires **Node.js 26** (the background runner executes TypeScript natively). The OS service is installed automatically when you create your first job. You can also install it yourself with `/cron install`.

## Usage

Tell the agent what you want:

> Every weekday at 8:00 check my inbox with email_fetch and send me a summary of what needs an answer today with email_send.

The agent calls `cron_create`:

```
cron_create:
  name: morning-inbox
  schedule: weekdays 8:00
  tools: ["email_fetch", "email_send"]
  prompt: Fetch the unread emails in INBOX from the last 24 hours, pick the ones that need
          an answer today, and email a short prioritised summary to me@example.com.
```

Or create the job yourself with `/cron add`.

### Schedules

All times are in the machine's local time.

| Input | Meaning |
|---|---|
| `0 8 * * 1-5` | Cron expression (minute hour day month weekday); `@hourly`, `@daily`, … also work |
| `every 15m`, `every 2 hours`, `every 1d` | Fixed interval (minimum 1 minute) |
| `daily 9:00`, `every day at 7am` | Every day |
| `weekdays 8:30`, `weekends 10:00` | Mon–Fri / Sat–Sun |
| `mon,wed,fri 18:15`, `monday at 9` | Specific weekdays |
| `in 30m`, `in 2 hours` | Once, relative |
| `2026-10-01 09:00` | Once, at a timestamp |

### Tools for the model

| Tool | Purpose |
|---|---|
| `cron_create` | Save prompt + schedule + tool allowlist (+ skills, model, cwd, delivery) |
| `cron_list` | List jobs, or show one job in full |
| `cron_update` | Change any field; `enabled: false` pauses, `true` resumes |
| `cron_delete` | Remove a job (its output history stays on disk) |
| `cron_run` | Run a job now in the background |
| `cron_results` | Recent runs and the latest output |

`tools` is the allowlist for the run. Leave it out to use pi's default tools, or pass `[]` for no tools. Tool names are checked against the tools pi knows, so a typo fails when you create the job, not at 3 am.

### /cron command

```
/cron                        list jobs
/cron add                    create a job step by step
/cron show <job>             details
/cron run <job>              run now
/cron pause <job>            pause
/cron resume <job>           resume (no backlog of missed runs)
/cron remove <job>
/cron results [job]          recent runs (+ latest output of one job)
/cron status                 service state and next run
/cron install | uninstall    background service
/cron telegram <botToken> <chatId>
/cron webhook <url>
```

When you start pi, it tells you how many new results arrived while you were away.

## Delivery

The output file is always written. A job's `deliver` list adds more channels:

| Target | What happens |
|---|---|
| `notify` | Desktop notification (macOS `osascript`, Linux `notify-send`). This is the default for new jobs. |
| `telegram` | Message from your bot. Set it up with `/cron telegram <botToken> <chatId>` |
| `webhook` | JSON `POST` with job, status and output. Set it up with `/cron webhook <url>` |

For email, give the job an email tool (for example [pi-email](https://github.com/Smotherer007/pi-email)'s `email_send`) and ask for the email in the prompt.

## How it works

```
launchd / cron ── every 60s ──> node ~/.pi/agent/cron/runtime/runner.ts tick
                                   │  lock jobs.json, find due jobs, advance nextRunAt
                                   └─> node runner.ts exec <job>   (detached, one per job)
                                          └─> pi -p --tools … --session-dir … "<prompt>"
                                                 ├─ output/<job>/<time>.md
                                                 ├─ runs/<job>/<time>.json
                                                 └─ notify / telegram / webhook
```

- The tick only decides and starts runs, so a slow job never delays the others.
- A job that is still running is not started twice. A run whose process died is marked `crashed`.
- Each run has a timeout (default 30 min). pi is stopped with SIGTERM, then SIGKILL.
- The service runs a copy of `src/core/` in `~/.pi/agent/cron/runtime/`, because Node does not strip TypeScript inside `node_modules`. The copy is refreshed automatically after package updates.
- Outputs, logs and sessions older than `keepRunsDays` (default 30) are removed.

### Files

```
~/.pi/agent/cron/
  jobs.json            job definitions and scheduling state
  config.json          pi command, PATH, env, telegram, webhook, defaults
  output/<job>/*.md    answers
  runs/<job>/*.json    run metadata
  logs/<job>/*.log     pi stderr per run
  sessions/<job>/      full pi sessions
  runtime/             runner used by the OS service
  runner.log           service log
```

### config.json

These values are written by `/cron install`. You can edit them by hand:

```json
{
  "piCommand": ["/usr/local/bin/node", "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"],
  "nodePath": "/usr/local/bin/node",
  "path": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  "env": { "ANTHROPIC_API_KEY": "…" },
  "telegram": { "botToken": "…", "chatId": "…" },
  "webhookUrl": null,
  "defaultDeliver": ["notify"],
  "keepRunsDays": 30
}
```

`env` is only needed if pi gets its API keys from shell variables. Logins made with `/login` are stored by pi itself and work as they are.

## Notes

- **macOS privacy:** if a job works in `~/Documents`, `~/Desktop` or `~/Downloads`, macOS may ask once whether `node` is allowed to access that folder. You can also grant access under *System Settings → Privacy & Security → Files and Folders*.
- The service only runs while you are logged in (LaunchAgent). Runs missed while the Mac was asleep or off are caught up after it wakes up or you log in. To skip them instead, set `catchUp: false`.
- Stop everything with `/cron uninstall`. Your jobs are kept.

## Development

```bash
npm install
npm test          # node:test, Node 26
npm run typecheck
```

## License

MIT
