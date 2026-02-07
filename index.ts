/**
 * AI Bounty Board API Health Monitor
 *
 * Self-contained Bun server that tracks API health including uptime,
 * response times, error rates, and payment processing status.
 * Includes a web dashboard with 7-day history charts via Chart.js.
 *
 * Run: bun run index.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// --- Configuration ---
const API_BASE = process.env.API_BASE_URL || "https://bounty.owockibot.xyz";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 60_000; // 1 minute
const PORT = Number(process.env.PORT) || 3100;
const HISTORY_FILE = process.env.HISTORY_FILE || "./health-history.json";
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const MAX_HISTORY_DAYS = 7;

// --- Types ---
interface HealthCheck {
  timestamp: string;
  endpoint: string;
  status: number;
  responseTimeMs: number;
  success: boolean;
  error?: string;
}

interface DailyStats {
  date: string;
  totalChecks: number;
  successfulChecks: number;
  avgResponseTimeMs: number;
  maxResponseTimeMs: number;
  minResponseTimeMs: number;
  errorRate: number;
  endpoints: Record<string, EndpointStats>;
}

interface EndpointStats {
  checks: number;
  successes: number;
  avgResponseTimeMs: number;
  maxResponseTimeMs: number;
  errors: number;
}

interface HistoryData {
  checks: HealthCheck[];
  dailyStats: DailyStats[];
  lastAlert: string | null;
}

// --- State ---
let history: HistoryData = {
  checks: [],
  dailyStats: [],
  lastAlert: null,
};

// Endpoints to monitor
const ENDPOINTS = [
  { name: "List Bounties", path: "/bounties" },
  { name: "Stats", path: "/stats" },
  { name: "Single Bounty", path: "/bounties/1" },
];

// --- Persistence ---
function loadHistory(): void {
  if (existsSync(HISTORY_FILE)) {
    try {
      const raw = readFileSync(HISTORY_FILE, "utf-8");
      history = JSON.parse(raw);
    } catch {
      console.error("Failed to load history, starting fresh");
      history = { checks: [], dailyStats: [], lastAlert: null };
    }
  }
}

function saveHistory(): void {
  // Prune checks older than 7 days
  const cutoff = new Date(Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  history.checks = history.checks.filter((c) => c.timestamp >= cutoff);

  const cutoffDate = cutoff.slice(0, 10);
  history.dailyStats = history.dailyStats.filter((d) => d.date >= cutoffDate);

  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// --- Health Checking ---
async function checkEndpoint(path: string): Promise<HealthCheck> {
  const url = `${API_BASE}${path}`;
  const start = performance.now();
  let status = 0;
  let success = false;
  let error: string | undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    status = res.status;
    success = res.ok;

    if (!res.ok) {
      error = `HTTP ${res.status}: ${res.statusText}`;
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "Unknown error";
    success = false;
  }

  const responseTimeMs = Math.round(performance.now() - start);

  return {
    timestamp: new Date().toISOString(),
    endpoint: path,
    status,
    responseTimeMs,
    success,
    error,
  };
}

async function runHealthChecks(): Promise<void> {
  const checks: HealthCheck[] = [];

  for (const ep of ENDPOINTS) {
    const check = await checkEndpoint(ep.path);
    checks.push(check);
    history.checks.push(check);
  }

  // Update daily stats
  updateDailyStats();

  // Check for issues and alert
  const failures = checks.filter((c) => !c.success);
  if (failures.length > 0) {
    const message = failures
      .map((f) => `${f.endpoint}: ${f.error || "failed"}`)
      .join("; ");
    await sendAlert(`Health check failures: ${message}`);
  }

  // Check for slow responses (> 5s)
  const slowChecks = checks.filter((c) => c.responseTimeMs > 5000);
  if (slowChecks.length > 0) {
    const message = slowChecks
      .map((c) => `${c.endpoint}: ${c.responseTimeMs}ms`)
      .join("; ");
    await sendAlert(`Slow responses detected: ${message}`);
  }

  saveHistory();
}

function updateDailyStats(): void {
  const today = new Date().toISOString().slice(0, 10);
  const todayChecks = history.checks.filter((c) => c.timestamp.startsWith(today));

  if (todayChecks.length === 0) return;

  const responseTimes = todayChecks.map((c) => c.responseTimeMs);
  const successes = todayChecks.filter((c) => c.success).length;

  // Build per-endpoint stats
  const endpoints: Record<string, EndpointStats> = {};
  for (const ep of ENDPOINTS) {
    const epChecks = todayChecks.filter((c) => c.endpoint === ep.path);
    if (epChecks.length === 0) continue;
    const epTimes = epChecks.map((c) => c.responseTimeMs);
    endpoints[ep.path] = {
      checks: epChecks.length,
      successes: epChecks.filter((c) => c.success).length,
      avgResponseTimeMs: Math.round(epTimes.reduce((a, b) => a + b, 0) / epTimes.length),
      maxResponseTimeMs: Math.max(...epTimes),
      errors: epChecks.filter((c) => !c.success).length,
    };
  }

  const dailyStat: DailyStats = {
    date: today,
    totalChecks: todayChecks.length,
    successfulChecks: successes,
    avgResponseTimeMs: Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
    maxResponseTimeMs: Math.max(...responseTimes),
    minResponseTimeMs: Math.min(...responseTimes),
    errorRate: Number(((1 - successes / todayChecks.length) * 100).toFixed(2)),
    endpoints,
  };

  // Replace today's entry if it exists, otherwise add it
  const idx = history.dailyStats.findIndex((d) => d.date === today);
  if (idx >= 0) {
    history.dailyStats[idx] = dailyStat;
  } else {
    history.dailyStats.push(dailyStat);
  }
}

// --- Alerting ---
async function sendAlert(message: string): Promise<void> {
  console.warn(`[ALERT] ${message}`);

  // Rate limit: no more than one alert per 5 minutes
  if (history.lastAlert) {
    const last = new Date(history.lastAlert).getTime();
    if (Date.now() - last < 5 * 60 * 1000) return;
  }

  history.lastAlert = new Date().toISOString();

  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `[Bounty Board Health] ${message}`,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error("Failed to send alert webhook:", err);
  }
}

// --- Current Status ---
function getCurrentStatus() {
  const recentChecks = history.checks.slice(-ENDPOINTS.length * 10);
  const last24h = history.checks.filter(
    (c) => new Date(c.timestamp).getTime() > Date.now() - 24 * 60 * 60 * 1000
  );

  const totalLast24 = last24h.length || 1;
  const successLast24 = last24h.filter((c) => c.success).length;
  const avgResponseTime =
    last24h.length > 0
      ? Math.round(last24h.reduce((a, c) => a + c.responseTimeMs, 0) / last24h.length)
      : 0;

  const latestByEndpoint: Record<string, HealthCheck> = {};
  for (const check of recentChecks) {
    latestByEndpoint[check.endpoint] = check;
  }

  return {
    uptime: ((successLast24 / totalLast24) * 100).toFixed(2),
    avgResponseTimeMs: avgResponseTime,
    errorRate: (((totalLast24 - successLast24) / totalLast24) * 100).toFixed(2),
    totalChecksLast24h: totalLast24,
    endpoints: latestByEndpoint,
    lastCheck: history.checks.length > 0 ? history.checks[history.checks.length - 1].timestamp : null,
  };
}

// --- HTML Dashboard ---
function renderDashboard(): string {
  const status = getCurrentStatus();
  const dailyLabels = history.dailyStats.map((d) => d.date);
  const dailyUptime = history.dailyStats.map(
    (d) => ((d.successfulChecks / (d.totalChecks || 1)) * 100).toFixed(1)
  );
  const dailyAvgResponse = history.dailyStats.map((d) => d.avgResponseTimeMs);
  const dailyErrorRates = history.dailyStats.map((d) => d.errorRate);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bounty Board API Health Monitor</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
    h1 { font-size: 1.8rem; margin-bottom: 8px; }
    .subtitle { color: #8b949e; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
    .card .label { color: #8b949e; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 2rem; font-weight: 700; margin-top: 4px; }
    .card .value.good { color: #3fb950; }
    .card .value.warn { color: #d29922; }
    .card .value.bad { color: #f85149; }
    .chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .chart-container h2 { font-size: 1.1rem; margin-bottom: 16px; }
    .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .endpoint-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .endpoint-table th, .endpoint-table td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #30363d; }
    .endpoint-table th { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; }
    .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
    .status-dot.up { background: #3fb950; }
    .status-dot.down { background: #f85149; }
    canvas { max-height: 250px; }
    @media (max-width: 768px) { .chart-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Bounty Board API Health Monitor</h1>
  <p class="subtitle">Monitoring ${API_BASE} &mdash; Last check: ${status.lastCheck || "never"}</p>

  <div class="grid">
    <div class="card">
      <div class="label">Uptime (24h)</div>
      <div class="value ${Number(status.uptime) >= 99 ? "good" : Number(status.uptime) >= 95 ? "warn" : "bad"}">${status.uptime}%</div>
    </div>
    <div class="card">
      <div class="label">Avg Response Time</div>
      <div class="value ${status.avgResponseTimeMs < 1000 ? "good" : status.avgResponseTimeMs < 3000 ? "warn" : "bad"}">${status.avgResponseTimeMs}ms</div>
    </div>
    <div class="card">
      <div class="label">Error Rate (24h)</div>
      <div class="value ${Number(status.errorRate) === 0 ? "good" : Number(status.errorRate) < 5 ? "warn" : "bad"}">${status.errorRate}%</div>
    </div>
    <div class="card">
      <div class="label">Checks (24h)</div>
      <div class="value good">${status.totalChecksLast24h}</div>
    </div>
  </div>

  <div class="chart-container">
    <h2>Endpoint Status</h2>
    <table class="endpoint-table">
      <thead>
        <tr><th>Endpoint</th><th>Status</th><th>Response Time</th><th>Last Checked</th></tr>
      </thead>
      <tbody>
        ${Object.entries(status.endpoints)
          .map(
            ([ep, check]) => `
        <tr>
          <td><span class="status-dot ${check.success ? "up" : "down"}"></span>${ep}</td>
          <td>${check.success ? "OK" : check.error || "Error"}</td>
          <td>${check.responseTimeMs}ms</td>
          <td>${new Date(check.timestamp).toLocaleString()}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>

  <div class="chart-row">
    <div class="chart-container">
      <h2>7-Day Uptime</h2>
      <canvas id="uptimeChart"></canvas>
    </div>
    <div class="chart-container">
      <h2>7-Day Response Times</h2>
      <canvas id="responseChart"></canvas>
    </div>
  </div>
  <div class="chart-row">
    <div class="chart-container">
      <h2>7-Day Error Rate</h2>
      <canvas id="errorChart"></canvas>
    </div>
    <div class="chart-container">
      <h2>Recent Checks</h2>
      <div style="max-height: 250px; overflow-y: auto; font-size: 0.85rem;">
        ${history.checks
          .slice(-30)
          .reverse()
          .map(
            (c) =>
              `<div style="padding: 4px 0; border-bottom: 1px solid #30363d;"><span class="status-dot ${c.success ? "up" : "down"}"></span>${c.endpoint} - ${c.responseTimeMs}ms - ${new Date(c.timestamp).toLocaleTimeString()}</div>`
          )
          .join("")}
      </div>
    </div>
  </div>

  <script>
    const labels = ${JSON.stringify(dailyLabels)};
    const chartDefaults = {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#30363d' }, ticks: { color: '#8b949e' } },
        y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e' } }
      }
    };

    new Chart(document.getElementById('uptimeChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{ data: ${JSON.stringify(dailyUptime)}, borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,0.1)', fill: true, tension: 0.3 }]
      },
      options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0, max: 100 } } }
    });

    new Chart(document.getElementById('responseChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [{ data: ${JSON.stringify(dailyAvgResponse)}, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', fill: true, tension: 0.3 }]
      },
      options: chartDefaults
    });

    new Chart(document.getElementById('errorChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data: ${JSON.stringify(dailyErrorRates)}, backgroundColor: '#f85149', borderRadius: 4 }]
      },
      options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0 } } }
    });

    // Auto-refresh every 60 seconds
    setTimeout(() => location.reload(), 60000);
  </script>
</body>
</html>`;
}

// --- HTTP Server ---
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return new Response(renderDashboard(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/api/status") {
      return Response.json(getCurrentStatus());
    }

    if (url.pathname === "/api/history") {
      return Response.json({
        dailyStats: history.dailyStats,
        recentChecks: history.checks.slice(-100),
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", monitoring: API_BASE });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// --- Start ---
loadHistory();
console.log(`Health Monitor running on http://localhost:${PORT}`);
console.log(`Monitoring: ${API_BASE}`);
console.log(`Polling every ${POLL_INTERVAL / 1000}s`);
console.log(`Alert webhook: ${WEBHOOK_URL || "(not configured)"}`);

// Initial check
runHealthChecks();

// Schedule periodic checks
setInterval(runHealthChecks, POLL_INTERVAL);
