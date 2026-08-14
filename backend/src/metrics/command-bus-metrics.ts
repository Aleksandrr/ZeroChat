import { Counter, Histogram, Gauge, register as defaultRegistry } from 'prom-client';

// FIX: previously we used a private `new Registry()` and registered all
// metrics there. But `server.ts` exposes `promClient.register.metrics()`
// (the *default* registry) at /metrics, so the custom registry was
// invisible. Use the default registry instead so the /metrics endpoint
// actually serves these counters.
const registry = defaultRegistry;

// Command metrics
export const commandTotal = new Counter({
  name: 'command_bus_commands_total',
  help: 'Total number of commands processed',
  labelNames: ['type', 'status'],
});

export const commandLatency = new Histogram({
  name: 'command_bus_latency_seconds',
  help: 'Command processing latency in seconds',
  labelNames: ['type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const commandErrors = new Counter({
  name: 'command_bus_errors_total',
  help: 'Total number of command errors',
  labelNames: ['type', 'error'],
});

// Security metrics
export const replayAttacks = new Counter({
  name: 'command_bus_replay_attacks_total',
  help: 'Total number of replay attack attempts',
});

export const rateLimited = new Counter({
  name: 'command_bus_rate_limited_total',
  help: 'Total number of rate-limited commands',
  labelNames: ['userId', 'commandType'],
});

// System metrics
export const activeConnections = new Gauge({
  name: 'command_bus_active_connections',
  help: 'Number of active WebSocket connections',
});

export const pendingCommands = new Gauge({
  name: 'command_bus_pending_commands',
  help: 'Number of pending commands waiting for ack',
});

// Collect default metrics (process/cpu/gc) into the default registry.
import { collectDefaultMetrics } from 'prom-client';
collectDefaultMetrics();

export { registry };
