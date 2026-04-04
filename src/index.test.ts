import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMetrics } from "./index.js";

describe("createMetrics", () => {
  let fetchMock: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    fetchMock = mock.fn(() =>
      Promise.resolve(new Response("", { status: 200 })),
    );
    mock.method(globalThis, "fetch", fetchMock);
  });

  describe("counter", () => {
    it("aggregates same-attribute increments", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
      });
      m.counter("req", 1, { method: "GET" });
      m.counter("req", 1, { method: "GET" });
      m.counter("req", 1, { method: "POST" });
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const sum = body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
      assert.equal(sum.aggregationTemporality, 1); // DELTA
      assert.equal(sum.isMonotonic, true);
      // Two distinct attribute sets: GET (aggregated to 2) and POST (1)
      const points = sum.dataPoints;
      assert.equal(points.length, 2);
      const getPoint = points.find((p: any) =>
        p.attributes.some(
          (a: any) => a.key === "method" && a.value.stringValue === "GET",
        ),
      );
      assert.equal(getPoint.asDouble, 2);
    });
  });

  describe("gauge", () => {
    it("last write wins for same attributes", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
      });
      m.gauge("queue_depth", 10, { queue: "main" });
      m.gauge("queue_depth", 5, { queue: "main" });
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const gauge = body.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge;
      assert.equal(gauge.dataPoints.length, 1);
      assert.equal(gauge.dataPoints[0].asDouble, 5);
    });

    it("keeps separate values for different attributes", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
      });
      m.gauge("queue_depth", 10, { queue: "a" });
      m.gauge("queue_depth", 20, { queue: "b" });
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const points =
        body.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints;
      assert.equal(points.length, 2);
    });
  });

  describe("histogram", () => {
    it("places value in correct bucket", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
        histogramBounds: [10, 50, 100],
      });
      m.histogram("duration", 42);
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const hist =
        body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram;
      const dp = hist.dataPoints[0];
      assert.equal(dp.count, 1);
      assert.equal(dp.sum, 42);
      // 42 <= 50, so bucket index 1 (bounds: [10, 50, 100] → buckets: [≤10, ≤50, ≤100, >100])
      assert.deepEqual(dp.bucketCounts, [0, 1, 0, 0]);
      assert.deepEqual(dp.explicitBounds, [10, 50, 100]);
    });

    it("places overflow in last bucket", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
        histogramBounds: [10, 50],
      });
      m.histogram("duration", 999);
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const dp =
        body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram
          .dataPoints[0];
      assert.deepEqual(dp.bucketCounts, [0, 0, 1]);
    });

    it("aggregates multiple observations", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
        histogramBounds: [10, 50, 100],
      });
      m.histogram("duration", 5);
      m.histogram("duration", 42);
      m.histogram("duration", 7);
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const dp =
        body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram
          .dataPoints[0];
      assert.equal(dp.count, 3);
      assert.equal(dp.sum, 54);
      assert.deepEqual(dp.bucketCounts, [2, 1, 0, 0]);
    });
  });

  describe("flush", () => {
    it("sends correct headers and service name", async () => {
      const m = createMetrics({
        serviceName: "my-worker",
        endpoint: "https://otlp.example.com",
        token: "secret123",
      });
      m.counter("x", 1);
      await m.flush();

      assert.equal(fetchMock.mock.callCount(), 1);
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, "https://otlp.example.com");
      assert.equal(opts.method, "POST");
      assert.equal(opts.headers["Content-Type"], "application/json");
      assert.equal(opts.headers["Authorization"], "Bearer secret123");

      const body = JSON.parse(opts.body);
      const resource = body.resourceMetrics[0].resource;
      assert.equal(resource.attributes[0].key, "service.name");
      assert.equal(resource.attributes[0].value.stringValue, "my-worker");
    });

    it("is no-op without endpoint", async () => {
      const m = createMetrics({ serviceName: "test", token: "tok" });
      m.counter("x", 1);
      await m.flush();
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it("is no-op without token", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
      });
      m.counter("x", 1);
      await m.flush();
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it("is no-op with no metrics collected", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
      });
      await m.flush();
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it("silently swallows fetch errors", async () => {
      mock.method(globalThis, "fetch", () => Promise.reject(new Error("net")));
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
      });
      m.counter("x", 1);
      await assert.doesNotReject(() => m.flush());
    });

    it("includes all metric types in one payload", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
      });
      m.counter("reqs", 1);
      m.gauge("depth", 5);
      m.histogram("latency", 42);
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
      assert.equal(metrics.length, 3);
      assert.ok(metrics.find((m: any) => m.name === "reqs" && m.sum));
      assert.ok(metrics.find((m: any) => m.name === "depth" && m.gauge));
      assert.ok(
        metrics.find((m: any) => m.name === "latency" && m.histogram),
      );
    });
  });

  describe("defaultAttributes", () => {
    it("merges into all data points", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
        defaultAttributes: { env: "prod" },
      });
      m.counter("x", 1, { method: "GET" });
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const attrs =
        body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
          .attributes;
      assert.ok(
        attrs.find(
          (a: any) => a.key === "env" && a.value.stringValue === "prod",
        ),
      );
      assert.ok(
        attrs.find(
          (a: any) => a.key === "method" && a.value.stringValue === "GET",
        ),
      );
    });

    it("per-call attributes override defaults", async () => {
      const m = createMetrics({
        serviceName: "test",
        endpoint: "https://example.com",
        token: "tok",
        defaultAttributes: { env: "prod" },
      });
      m.counter("x", 1, { env: "staging" });
      await m.flush();

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      const attrs =
        body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
          .attributes;
      const envAttr = attrs.find((a: any) => a.key === "env");
      assert.equal(envAttr.value.stringValue, "staging");
    });
  });
});
