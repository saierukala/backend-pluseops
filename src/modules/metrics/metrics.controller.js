import { metrics } from '../../config/metrics.js';
import { logger } from '../../config/logger.js';

export function metricsEndpoint(req, res) {
  const format = req.query.format || 'json';
  const allMetrics = metrics.getAll();

  if (format === 'prometheus') {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    let output = '';
    
    for (const [name, value] of Object.entries(allMetrics.counters)) {
      output += `# TYPE ${name} counter\n${name} ${value}\n`;
    }
    for (const [name, hist] of Object.entries(allMetrics.histograms)) {
      output += `# TYPE ${name} summary\n${name}_count ${hist.count}\n${name}_sum ${hist.sum}\n`;
    }
    for (const [name, value] of Object.entries(allMetrics.gauges)) {
      output += `# TYPE ${name} gauge\n${name} ${value}\n`;
    }
    
    res.send(output);
    return;
  }

  logger.info({ requestId: req.id, event: 'metrics_requested' }, 'Metrics endpoint accessed');
  res.json({
    success: true,
    data: allMetrics,
    message: 'Metrics snapshot',
  });
}