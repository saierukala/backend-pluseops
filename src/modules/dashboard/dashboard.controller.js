import { dashboardService } from './dashboard.service.js';

export async function getOverview(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { data, cacheHit } = await dashboardService.getOverview(tenantId);
    // Consistent response envelope: success, data, message
    // Include cache metadata via header, not breaking envelope contract
    if (cacheHit) {
      res.setHeader('x-cache', 'HIT');
    } else {
      res.setHeader('x-cache', 'MISS');
    }
    res.status(200).json({
      success: true,
      data,
      message: 'Dashboard overview retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}
