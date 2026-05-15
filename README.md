# pi-ext-loki-logger

Pi extension for session logging.

## Behavior
- Local JSONL per session
- Loki gets 50-char summary only
- Session retention keeps 50 newest files
- Commands: `/loki-setup`, `/loki-status`
- Auth: Basic (`username` + token)

## Install
```bash
pi install git:github.com/archsinit/pi-ext-loki-logger
```

## Setup
Run `/loki-setup` inside pi, then paste:
- Loki push URL
- Username / tenant id
- Auth token

## Local paths
- Config: `~/.pi/agent/loki-logger.json`
- Logs: `~/.pi/logs/loki-sessions/<session_id>.jsonl`
