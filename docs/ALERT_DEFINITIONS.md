# Phase 24 - Alert Definitions

This document defines operational alert conditions for PulseOps production monitoring.

## Alert Severity Levels

- **Critical (P1)**: Immediate response required, pages on-call
- **Warning (P2)**: Response within 15 minutes during business hours
- **Info (P3)**: Logged for trend analysis, no immediate response

## API Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| HighAPIErrorRate | `rate(http_requests_total{statusClass="5xx"}[5m]) > 0.05` | Critical | >5% 5xx error rate over 5 minutes |
| HighAPILatencyP95 | `histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m])) > 2000` | Warning | p95 latency > 2 seconds |
| HighAPILatencyP99 | `histogram_quantile(0.99, rate(http_request_duration_ms_bucket[5m])) > 5000` | Critical | p99 latency > 5 seconds |
| High4xxRate | `rate(http_requests_total{statusClass="4xx"}[5m]) > 0.20` | Warning | >20% 4xx error rate (potential abuse) |

## Database Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| DatabaseDown | `databaseHealth == 0` | Critical | Database health check failing |
| DatabaseHighLatency | `histogram_quantile(0.95, rate(db_operation_duration_ms_bucket[5m])) > 1000` | Warning | p95 DB query latency > 1 second |
| DatabaseConnectionPoolExhausted | `db_pool_used / db_pool_max > 0.85` | Critical | Connection pool >85% utilized |
| DatabaseErrorRate | `rate(db_errors_total[5m]) > 0.01` | Warning | >1% DB error rate |

## Redis Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| RedisDown | `redisHealth == 0` | Critical | Redis health check failing |
| RedisHighLatency | `histogram_quantile(0.95, rate(redis_command_duration_ms_bucket[5m])) > 200` | Warning | p95 Redis command latency > 200ms |
| RedisErrorRate | `rate(redis_errors_total[5m]) > 0.01` | Warning | >1% Redis error rate |
| RedisMemoryHigh | `redis_memory_used_bytes / redis_memory_max_bytes > 0.90` | Critical | Redis memory >90% |

## Queue/Worker Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| QueueBacklogHigh | `queue_operations_total{operation="enqueue",success="true"} - queue_operations_total{operation="process",success="true"} > 1000` | Warning | Queue backlog >1000 jobs |
| QueueBacklogCritical | `queue_operations_total{operation="enqueue",success="true"} - queue_operations_total{operation="process",success="true"} > 10000` | Critical | Queue backlog >10000 jobs |
| WorkerFailureRate | `rate(queue_errors_total{errorType="permanent"}[5m]) > 0.05` | Critical | >5% permanent worker failures |
| WorkerRetryRate | `rate(queue_errors_total{errorType="retryable"}[5m]) > 0.20` | Warning | >20% retryable worker failures |
| WorkerStalled | `increase(queue_stalled_total[10m]) > 5` | Warning | >5 stalled jobs in 10 minutes |
| BullMQDown | `bullmqHealth == 0` | Critical | BullMQ Redis connection down |

## External Integration Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| PaymentProviderDown | `rate(external_errors_total{provider="payment"}[5m]) > 0.10` | Critical | >10% payment provider errors |
| EmailProviderDown | `rate(external_errors_total{provider="email"}[5m]) > 0.20` | Warning | >20% email provider errors |
| ShippingProviderDown | `rate(external_errors_total{provider="shipping"}[5m]) > 0.20` | Warning | >20% shipping provider errors |
| ExternalTimeoutRate | `rate(external_errors_total{errorType="timeout"}[5m]) > 0.05` | Warning | >5% external timeout rate |
| ExternalRetryRate | `rate(external_retries_total[5m]) > 10` | Warning | >10 external retries per minute |

## Storage Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| StorageUploadFailure | `rate(storage_errors_total{operation="upload"}[5m]) > 0.05` | Critical | >5% storage upload failures |
| StorageDeleteFailure | `rate(storage_errors_total{operation="delete"}[5m]) > 0.05` | Warning | >5% storage delete failures |
| StorageHighLatency | `histogram_quantile(0.95, rate(storage_operation_duration_ms_bucket{operation="upload"}[5m])) > 5000` | Warning | p95 upload latency > 5 seconds |

## Authentication & Security Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| AuthFailureSpike | `rate(http_requests_total{route="/api/v1/auth/login",statusClass="4xx"}[5m]) > 50` | Warning | >50 auth failures per minute |
| AuthBruteForce | `rate(http_requests_total{route="/api/v1/auth/login",statusClass="4xx"}[1m]) > 20` | Critical | >20 auth failures per minute from single IP |
| TenantIsolationViolation | `audit_logs{event="tenant_isolation_violation"} > 0` | Critical | Any tenant isolation violation detected |

## Infrastructure Alerts

| Alert | Condition | Severity | Description |
|-------|-----------|----------|-------------|
| HighMemoryUsage | `process_memory_bytes / process_memory_limit > 0.85` | Warning | Process memory >85% |
| HighCPUUsage | `rate(process_cpu_seconds_total[5m]) > 0.80` | Warning | CPU >80% for 5 minutes |
| DiskSpaceLow | `disk_free_bytes / disk_total_bytes < 0.10` | Critical | Disk space <10% free |
| CertificateExpiry | `ssl_certificate_expiry_days < 30` | Warning | TLS cert expires in <30 days |

## Implementation Notes

1. **Metrics Source**: All metrics are exposed via `/metrics` endpoint in Prometheus format
2. **Alerting Platform**: Integrate with Prometheus Alertmanager, Grafana Alerting, or equivalent
3. **Notification Channels**: PagerDuty, Opsgenie, Slack, Email
4. **Runbooks**: Each alert should link to a runbook with investigation steps
5. **Tuning**: Thresholds may need adjustment based on production baseline
6. **Cardinality**: Labels are bounded (method, route, statusClass, queue, provider, operation) - no high-cardinality labels

## Example Prometheus Rules

```yaml
groups:
  - name: pulseops-api
    rules:
      - alert: HighAPIErrorRate
        expr: rate(http_requests_total{statusClass="5xx"}[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High API error rate (5xx)"
          description: "5xx error rate is {{ $value | humanizePercentage }} over 5 minutes"
          runbook_url: "https://wiki.pulseops.example.com/runbooks/high-api-error-rate"

      - alert: DatabaseDown
        expr: databaseHealth == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database unavailable"
          description: "Database health check has been failing for 1 minute"
          runbook_url: "https://wiki.pulseops.example.com/runbooks/database-down"
```

## Testing Alerts

1. Simulate conditions in staging
2. Verify alert fires and notification delivered
3. Verify runbook links work
4. Test alert resolution when condition clears
5. Document any threshold adjustments