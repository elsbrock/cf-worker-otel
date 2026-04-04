# cf-worker-otel

Push metrics from Cloudflare Workers to Prometheus, Grafana Cloud, or any OTLP-compatible backend — without pulling in the full OpenTelemetry SDK.

- ~200 lines, zero runtime dependencies
- Counters, gauges, and histograms
- OTLP/HTTP JSON with delta temporality
- Built for `waitUntil()` — never blocks your response
- No-ops silently without config — safe to always instrument

## Install

```bash
npm install @else42/cf-worker-otel
```

## Usage

### Cloudflare Worker

```typescript
import { createMetrics } from "@else42/cf-worker-otel";

export default {
  async fetch(request, env, ctx) {
    const metrics = createMetrics({
      serviceName: "my-worker",
      endpoint: env.OTLP_ENDPOINT,
      token: env.OTLP_AUTH_TOKEN,
    });
    const start = Date.now();

    const response = await handleRequest(request);

    metrics.counter("http_requests_total", 1, {
      method: request.method,
      status: String(response.status),
    });
    metrics.histogram("http_request_duration_ms", Date.now() - start);

    ctx.waitUntil(metrics.flush());
    return response;
  },
};
```

### SvelteKit on Cloudflare

```typescript
import { createMetrics } from "@else42/cf-worker-otel";
import { sequence } from "@sveltejs/kit/hooks";
import type { Handle } from "@sveltejs/kit";

const metricsHandle: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  const metrics = createMetrics({
    serviceName: "my-app",
    endpoint: env?.OTLP_ENDPOINT,
    token: env?.OTLP_AUTH_TOKEN,
  });
  const start = Date.now();
  let status = "500";
  try {
    const response = await resolve(event);
    status = String(response.status);
    return response;
  } finally {
    metrics.counter("http_requests_total", 1, {
      method: event.request.method,
      status,
      route: event.route.id ?? "unknown",
    });
    metrics.histogram("http_request_duration_ms", Date.now() - start);
    event.platform?.context?.waitUntil(metrics.flush());
  }
};

export const handle = sequence(metricsHandle, yourAppHandle);
```

## API

### `createMetrics(config)`

Creates a per-request metrics collector. Call once per invocation, flush at the end.

| Option              | Type                       | Required | Description                                    |
| ------------------- | -------------------------- | -------- | ---------------------------------------------- |
| `serviceName`       | `string`                   | yes      | Maps to `service.name` in OTLP                 |
| `endpoint`          | `string`                   | no       | OTLP HTTP endpoint URL                         |
| `token`             | `string`                   | no       | Bearer token for the `Authorization` header    |
| `defaultAttributes` | `Record<string, string>`   | no       | Merged into every data point                   |
| `histogramBounds`   | `number[]`                 | no       | Custom bucket boundaries (default: HTTP ms)    |

If `endpoint` or `token` is missing, `flush()` does nothing — safe to instrument unconditionally.

### Metric types

**`counter(name, value, attributes?)`** — Monotonic counter. Same name + attributes are aggregated within the request.

**`gauge(name, value, attributes?)`** — Point-in-time value. Last write wins per attribute set.

**`histogram(name, value, attributes?)`** — Single observation placed into a bucket.  
Default bounds: `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` ms.

**`flush()`** — Serializes to OTLP JSON, POSTs via `fetch()`. Pass to `ctx.waitUntil()`.

## Prometheus setup

Enable the OTLP receiver (v2.47+):

```
--web.enable-otlp-receiver
```

For delta temporality (v3+):

```
--enable-feature=otlp-deltatocumulative
```

The receiver listens at `POST /api/v1/otlp/v1/metrics` on the Prometheus port.

## How it works

Each `createMetrics()` call creates an isolated collector. Metrics accumulate in memory during request handling, then serialize to a single OTLP/HTTP JSON payload and POST in `waitUntil()`. One fetch per worker invocation — no batching across requests, no persistent state.

Delta temporality means each push contains only what happened during this request. Prometheus converts deltas to cumulative counters server-side.

## License

[MIT](LICENSE)
