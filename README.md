# bounty-health-monitor

**Health monitoring** dashboard that tracks the AI Bounty Board API with **response time tracking**, **webhook alerts**, and **history charts**.

## Features

- **Health monitoring** — polls `/bounties`, `/stats`, and `/bounties/:id` endpoints on a configurable interval
- **Response time tracking** — tracks average, min, and max response times per endpoint with 7-day history
- **Webhook alerts** — sends POST notifications to your webhook URL when failures or slow responses (>5s) are detected
- **History charts** — 7-day Chart.js visualizations for uptime percentage, response times, and error rates
- Rate-limited alerts (max one per 5 minutes)
- REST API endpoints for programmatic access
- Persistent JSON history file

## Quick Start

```bash
bun install
bun run start
```

Open `http://localhost:3100` to see the dashboard.

## Configuration

Set via environment variables:

| Variable            | Default                           | Description                    |
|---------------------|-----------------------------------|--------------------------------|
| `API_BASE_URL`      | `https://aibountyboard.com/api`   | Bounty board API base URL      |
| `POLL_INTERVAL_MS`  | `60000`                           | Polling interval in ms         |
| `PORT`              | `3100`                            | Dashboard server port          |
| `HISTORY_FILE`      | `./health-history.json`           | Path to history storage file   |
| `ALERT_WEBHOOK_URL` | (none)                            | Webhook URL for alerts         |

## API Endpoints

| Path            | Description                        |
|-----------------|-------------------------------------|
| `GET /`         | HTML dashboard                      |
| `GET /api/status` | Current status JSON               |
| `GET /api/history` | 7-day history JSON               |
| `GET /api/health`  | Monitor service health check      |

## Alert Webhook

When failures or slow responses are detected, the monitor sends a POST request to your configured webhook URL with:

```json
{
  "text": "[Bounty Board Health] Health check failures: /bounties: HTTP 500",
  "timestamp": "2025-01-15T12:00:00.000Z"
}
```

Compatible with Slack, Discord (via adapter), and generic webhook endpoints.

## License

MIT
