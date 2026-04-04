/**
 * cf-worker-otel — Lightweight OTLP metrics client for Cloudflare Workers
 *
 * Pushes counters and histograms to any OTLP-compatible receiver (Prometheus,
 * Grafana Cloud, etc.) using the OTLP/HTTP JSON protocol. Designed for the
 * Workers runtime: zero dependencies, uses fetch(), safe to call in waitUntil().
 */

// ─── Public types ────────────────────────────────────────────────

export interface MetricsConfig {
  /** Service name — appears as the service.name resource attribute in OTLP. */
  serviceName: string;
  /**
   * OTLP HTTP endpoint URL (e.g. "https://otlp.example.com").
   * If omitted, flush() is a silent no-op — safe to always instrument.
   */
  endpoint?: string;
  /** Bearer token sent in the Authorization header. Required if endpoint is set. */
  token?: string;
  /** Extra attributes merged into every data point. */
  defaultAttributes?: Record<string, string>;
  /** Histogram bucket boundaries in ascending order. Defaults to HTTP latency buckets (ms). */
  histogramBounds?: number[];
}

export interface Metrics {
  /** Increment a monotonic counter. */
  counter(name: string, value: number, attributes?: Record<string, string>): void;
  /** Set a gauge to a current value (last write wins per attribute set). */
  gauge(name: string, value: number, attributes?: Record<string, string>): void;
  /** Record a single histogram observation. */
  histogram(name: string, value: number, attributes?: Record<string, string>): void;
  /** Serialize and POST all collected metrics. Pass to ctx.waitUntil(). */
  flush(): Promise<void>;
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ─── Internal bookkeeping ────────────────────────────────────────

interface CounterPoint {
  value: number;
  attributes: Record<string, string>;
}

interface GaugePoint {
  value: number;
  attributes: Record<string, string>;
}

interface HistogramPoint {
  count: number;
  sum: number;
  bucketCounts: number[];
  attributes: Record<string, string>;
}

// ─── OTLP/HTTP JSON serialization ────────────────────────────────

function msToNanos(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

function toOtlpAttrs(attrs: Record<string, string>) {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function buildPayload(
  serviceName: string,
  startMs: number,
  endMs: number,
  counters: Map<string, CounterPoint[]>,
  gauges: Map<string, GaugePoint[]>,
  histograms: Map<string, HistogramPoint[]>,
  bounds: number[],
) {
  const startNano = msToNanos(startMs);
  const endNano = msToNanos(endMs);
  const metrics: unknown[] = [];

  for (const [name, points] of counters) {
    metrics.push({
      name,
      sum: {
        dataPoints: points.map((p) => ({
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          asDouble: p.value,
          attributes: toOtlpAttrs(p.attributes),
        })),
        aggregationTemporality: 1, // DELTA
        isMonotonic: true,
      },
    });
  }

  for (const [name, points] of gauges) {
    metrics.push({
      name,
      gauge: {
        dataPoints: points.map((p) => ({
          timeUnixNano: endNano,
          asDouble: p.value,
          attributes: toOtlpAttrs(p.attributes),
        })),
      },
    });
  }

  for (const [name, points] of histograms) {
    metrics.push({
      name,
      histogram: {
        dataPoints: points.map((p) => ({
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          count: p.count,
          sum: p.sum,
          bucketCounts: p.bucketCounts,
          explicitBounds: bounds,
          attributes: toOtlpAttrs(p.attributes),
        })),
        aggregationTemporality: 1, // DELTA
      },
    });
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: toOtlpAttrs({ "service.name": serviceName }) },
        scopeMetrics: [
          {
            scope: { name: "cf-worker-otel" },
            metrics,
          },
        ],
      },
    ],
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Create a per-request metrics collector.
 *
 * Call counter() / histogram() during request handling, then pass flush()
 * to ctx.waitUntil() so the POST happens after the response is sent.
 *
 * If endpoint or token is missing, flush() silently does nothing — safe to
 * instrument unconditionally regardless of environment.
 */
export function createMetrics(config: MetricsConfig): Metrics {
  const counters = new Map<string, CounterPoint[]>();
  const gauges = new Map<string, GaugePoint[]>();
  const histograms = new Map<string, HistogramPoint[]>();
  const bounds = config.histogramBounds ?? DEFAULT_BOUNDS;
  const startMs = Date.now();

  function merge(attrs?: Record<string, string>): Record<string, string> {
    if (!config.defaultAttributes) return attrs ?? {};
    return { ...config.defaultAttributes, ...attrs };
  }

  function attrKey(attrs: Record<string, string>): string {
    return Object.entries(attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\x00");
  }

  return {
    counter(name, value, attributes) {
      const merged = merge(attributes);
      const key = attrKey(merged);
      const points = counters.get(name) ?? [];
      const existing = points.find((p) => attrKey(p.attributes) === key);
      if (existing) {
        existing.value += value;
      } else {
        points.push({ value, attributes: merged });
      }
      counters.set(name, points);
    },

    gauge(name, value, attributes) {
      const merged = merge(attributes);
      const key = attrKey(merged);
      const points = gauges.get(name) ?? [];
      const existing = points.find((p) => attrKey(p.attributes) === key);
      if (existing) {
        existing.value = value; // last write wins
      } else {
        points.push({ value, attributes: merged });
      }
      gauges.set(name, points);
    },

    histogram(name, value, attributes) {
      const merged = merge(attributes);
      const key = attrKey(merged);
      const points = histograms.get(name) ?? [];

      const bucketCounts = new Array<number>(bounds.length + 1).fill(0);
      let placed = false;
      for (let i = 0; i < bounds.length; i++) {
        if (value <= bounds[i]) {
          bucketCounts[i] = 1;
          placed = true;
          break;
        }
      }
      if (!placed) bucketCounts[bounds.length] = 1;

      const existing = points.find((p) => attrKey(p.attributes) === key);
      if (existing) {
        existing.count += 1;
        existing.sum += value;
        for (let i = 0; i < bucketCounts.length; i++) {
          existing.bucketCounts[i] += bucketCounts[i];
        }
      } else {
        points.push({ count: 1, sum: value, bucketCounts, attributes: merged });
      }
      histograms.set(name, points);
    },

    async flush() {
      if (!config.endpoint || !config.token) return;
      if (counters.size === 0 && gauges.size === 0 && histograms.size === 0)
        return;

      const payload = buildPayload(
        config.serviceName,
        startMs,
        Date.now(),
        counters,
        gauges,
        histograms,
        bounds,
      );

      try {
        await fetch(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(payload),
        });
      } catch {
        // Silently swallow — metrics must never break the worker
      }
    },
  };
}
