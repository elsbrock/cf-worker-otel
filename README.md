# cf-worker-otel

Lightweight OTLP metrics client for Cloudflare Workers. Pushes counters and histograms to any OTLP-compatible receiver (Prometheus, Grafana Cloud, etc.) via the OTLP/HTTP JSON protocol.

- Zero runtime dependencies
- ~150 lines, uses native `fetch()`
- Delta temporality (Prometheus converts to cumulative)
- Safe to always instrument — silently no-ops without config

## Install

```bash
npm install cf-worker-otel
```

## Usage

### Cloudflare Worker

```typescript
import { createMetrics } from 'cf-worker-otel';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const metrics = createMetrics({
      serviceName: 'my-worker',
      endpoint: env.OTLP_ENDPOINT,
      token: env.OTLP_AUTH_TOKEN,
    });
    const start = Date.now();

    const response = await handleRequest(request);

    metrics.counter('http_requests_total', 1, {
      method: request.method,
      status: String(response.status),
    });
    metrics.histogram('http_request_duration_ms', Date.now() - start);

    ctx.waitUntil(metrics.flush());
    return response;
  },
};
```

### SvelteKit on Cloudflare

```typescript
// src/hooks.server.ts
import { createMetrics } from 'cf-worker-otel';
import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';

const metricsHandle: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  const metrics = createMetrics({
    serviceName: 'my-app',
    endpoint: env?.OTLP_ENDPOINT,
    token: env?.OTLP_AUTH_TOKEN,
  });
  const start = Date.now();
  let status = '500';
  try {
    const response = await resolve(event);
    status = String(response.status);
    return response;
  } finally {
    metrics.counter('http_requests_total', 1, {
      method: event.request.method,
      status,
    });
    metrics.histogram('http_request_duration_ms', Date.now() - start);
    event.platform?.context?.waitUntil(metrics.flush());
  }
};

export const handle = sequence(metricsHandle, yourExistingHandle);
```

## API

### `createMetrics(config): Metrics`

Creates a per-request metrics collector.

**Config:**

| Field | Type | Required | Description |
|---|---|---|---|
| `serviceName` | `string` | Yes | OTLP `service.name` resource attribute |
| `endpoint` | `string` | No | OTLP HTTP endpoint URL |
| `token` | `string` | No | Bearer token for Authorization header |
| `defaultAttributes` | `Record<string, string>` | No | Attributes merged into every data point |
| `histogramBounds` | `number[]` | No | Custom bucket boundaries (default: HTTP latency in ms) |

If `endpoint` or `token` is missing, `flush()` silently does nothing.

### `metrics.counter(name, value, attributes?)`

Increment a monotonic counter. Same-name + same-attributes calls within a request are aggregated.

### `metrics.histogram(name, value, attributes?)`

Record a single histogram observation. Default buckets: `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` (ms).

### `metrics.flush(): Promise<void>`

Serialize and POST all collected metrics. Pass to `ctx.waitUntil()` so it runs after the response is sent.

## Prometheus Setup

Enable the OTLP receiver on Prometheus 2.47+:

```
--web.enable-otlp-receiver
```

This exposes `POST /api/v1/otlp/v1/metrics`. Put a reverse proxy in front for auth.

## License

MIT
