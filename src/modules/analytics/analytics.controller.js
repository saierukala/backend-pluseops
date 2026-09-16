import { analyticsService } from './analytics.service.js';

function setCacheHeader(res, cacheHit) {
  res.setHeader('x-cache', cacheHit ? 'HIT' : 'MISS');
}

export async function getOverview(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const params = req.query;
    const { data, cacheHit } = await analyticsService.getOverview(tenantId, params);
    setCacheHeader(res, cacheHit);
    res.status(200).json({ success: true, data, message: 'Analytics overview retrieved successfully' });
  } catch (error) {
    next(error);
  }
}

export async function getSales(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const params = req.query;
    const { data, cacheHit } = await analyticsService.getSales(tenantId, params);
    setCacheHeader(res, cacheHit);
    // Sales returns paginated buckets: data.data, meta, summary
    res.status(200).json({
      success: true,
      data: data.data,
      meta: data.meta,
      summary: data.summary,
      pagination: data.meta,
      message: 'Sales analytics retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getOrders(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const params = req.query;
    const { data, cacheHit } = await analyticsService.getOrders(tenantId, params);
    setCacheHeader(res, cacheHit);
    res.status(200).json({
      success: true,
      data: data.data,
      meta: data.meta,
      summary: data.summary,
      pagination: data.meta,
      message: 'Order analytics retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getInventory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const params = req.query;
    const { data, cacheHit } = await analyticsService.getInventory(tenantId, params);
    setCacheHeader(res, cacheHit);
    res.status(200).json({
      success: true,
      data: data.data,
      summary: data.summary,
      byWarehouse: data.byWarehouse,
      pagination: data.meta,
      meta: data.meta,
      message: 'Inventory analytics retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getCustomers(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const params = req.query;
    const { data, cacheHit } = await analyticsService.getCustomers(tenantId, params);
    setCacheHeader(res, cacheHit);
    res.status(200).json({
      success: true,
      data: data.topCustomers,
      summary: data.summary,
      buckets: data.buckets,
      bucketMeta: data.bucketMeta,
      pagination: data.meta,
      meta: data.meta,
      message: 'Customer analytics retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getRevenue(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const params = req.query;
    const { data, cacheHit } = await analyticsService.getRevenue(tenantId, params);
    setCacheHeader(res, cacheHit);
    res.status(200).json({
      success: true,
      data: data.data,
      summary: data.summary,
      pagination: data.meta,
      meta: data.meta,
      message: 'Revenue analytics retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}
