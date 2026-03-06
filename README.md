# Goldchain Rank — OpenClaw Plugin

Token usage tracker for the [Goldchain](https://goldchain.club) leaderboard.

Automatically captures LLM token usage (model, provider, token counts) from OpenClaw and reports it to the Goldchain ranking service. **No conversation content is ever collected** — only usage metadata. Code is open source for full transparency.

## Install

```bash
# Clone to OpenClaw global extensions directory
git clone https://github.com/pearl799/goldchain-rank.git ~/.openclaw/extensions/goldchain-rank

# Configure credentials
cd ~/.openclaw/extensions/goldchain-rank
cp config.example.json config.json
# Edit config.json with your user_id and secret_key from goldchain.club
chmod 600 config.json

# Restart OpenClaw to load the plugin
openclaw restart
```

## Configuration

Create `config.json` in the plugin directory:

```json
{
  "user_id": "gc_xxxxx",
  "secret_key": "sk_xxxxx",
  "api_base_url": "https://api.goldchain.club"
}
```

Get your credentials by registering at [goldchain.club](https://goldchain.club).

## Commands

| Command | Description |
|---------|-------------|
| `/goldchain status` | Show plugin status, queue length, last sync time |
| `/goldchain sync` | Force sync all pending events immediately |
| `/goldchain pause` | Pause data collection |
| `/goldchain resume` | Resume data collection |
| `/goldchain rank` | Show your current rank and stats |
| `/goldchain leaderboard` | Show top 20 leaderboard |

## What Data Is Collected

Each LLM call records **only**:

- `model` — e.g. `claude-opus-4.6`
- `provider` — e.g. `anthropic`, `openrouter`
- `usage.input` — input token count
- `usage.output` — output token count
- `usage.cache_read` — cache read token count
- `usage.total` — total token count
- `run_id` / `session_id` — for deduplication
- `timestamp`

**No prompts, responses, or any conversation content is ever read or transmitted.**

## How It Works

1. Plugin listens to OpenClaw's `llm_output` lifecycle event
2. Extracts only usage metadata (ignores `assistantTexts`)
3. Writes records to a local JSONL queue (`queue.jsonl`)
4. Batch uploads to Goldchain API with HMAC-SHA256 signed requests
5. Three-layer sync trigger: 10s debounce, 60s max staleness, 50 event batch limit

## Uninstall

```bash
rm -rf ~/.openclaw/extensions/goldchain-rank
openclaw restart
```

## License

MIT
