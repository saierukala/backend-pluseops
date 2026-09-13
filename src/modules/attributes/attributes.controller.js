import { AttributeService } from './attributes.service.js';

const attributeService = new AttributeService();

export async function createAttribute(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const attribute = await attributeService.create(tenantId, req.body);
    res.status(201).json({
      success: true,
      data: attribute,
      message: 'Attribute created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getAttribute(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const attribute = await attributeService.getById(id, tenantId);
    res.status(200).json({
      success: true,
      data: attribute,
      message: 'Attribute retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listAttributes(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, search, dataType, sortBy, sortOrder } = req.query;

    const result = await attributeService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      search,
      dataType,
      sortBy,
      sortOrder,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Attributes retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateAttribute(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const attribute = await attributeService.update(id, tenantId, req.body);
    res.status(200).json({
      success: true,
      data: attribute,
      message: 'Attribute updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteAttribute(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    await attributeService.delete(id, tenantId);
    res.status(200).json({
      success: true,
      data: null,
      message: 'Attribute deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function createAttributeValue(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { attributeId } = req.params;
    const value = await attributeService.createValue(tenantId, attributeId, req.body);
    res.status(201).json({
      success: true,
      data: value,
      message: 'Attribute value created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getAttributeValue(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { valueId } = req.params;
    const value = await attributeService.getValueById(valueId, tenantId);
    res.status(200).json({
      success: true,
      data: value,
      message: 'Attribute value retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listAttributeValues(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { attributeId } = req.params;
    const { page, limit } = req.query;

    const result = await attributeService.listValues(attributeId, tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Attribute values retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateAttributeValue(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { valueId } = req.params;
    const value = await attributeService.updateValue(valueId, tenantId, req.body);
    res.status(200).json({
      success: true,
      data: value,
      message: 'Attribute value updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteAttributeValue(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { valueId } = req.params;
    await attributeService.deleteValue(valueId, tenantId);
    res.status(200).json({
      success: true,
      data: null,
      message: 'Attribute value deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}