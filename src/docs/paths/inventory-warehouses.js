const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const inventoryWarehousesPaths = {
  '/api/v1/warehouses': {
    post: {
      tags: ['Warehouses'],
      summary: 'Create warehouse',
      description: 'Requires `warehouse:create`.',
      operationId: 'createWarehouse',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'code'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 255, example: 'Main Warehouse' },
                code: { type: 'string', minLength: 1, maxLength: 50, example: 'WH-001' },
                address: { type: 'string', maxLength: 500 },
                city: { type: 'string', maxLength: 100 },
                state: { type: 'string', maxLength: 100 },
                country: { type: 'string', maxLength: 100 },
                postalCode: { type: 'string', maxLength: 20 },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Warehouse created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Warehouse' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        409: { description: 'Duplicate code', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: error500,
      },
    },
    get: {
      tags: ['Warehouses'],
      summary: 'List warehouses',
      description: 'Requires `warehouse:read`.',
      operationId: 'listWarehouses',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 255 } },
        { name: 'isActive', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
      ],
      responses: {
        200: { description: 'Warehouses retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Warehouse' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/warehouses/{id}': {
    get: {
      tags: ['Warehouses'],
      summary: 'Get warehouse by ID',
      description: 'Requires `warehouse:read`.',
      operationId: 'getWarehouse',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Warehouse retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Warehouse' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    patch: {
      tags: ['Warehouses'],
      summary: 'Update warehouse',
      description: 'Requires `warehouse:update`. `code` is not updatable. At least one field.',
      operationId: 'updateWarehouse',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 255 }, address: { type: 'string', maxLength: 500 }, city: { type: 'string', maxLength: 100 }, state: { type: 'string', maxLength: 100 }, country: { type: 'string', maxLength: 100 }, postalCode: { type: 'string', maxLength: 20 }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' } } } } },
      },
      responses: {
        200: { description: 'Warehouse updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Warehouse' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    delete: {
      tags: ['Warehouses'],
      summary: 'Delete warehouse',
      description: 'Requires `warehouse:delete`.',
      operationId: 'deleteWarehouse',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Warehouse deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/inventory': {
    get: {
      tags: ['Inventory'],
      summary: 'List inventory',
      description: 'Requires `inventory:read`. Specific paths must be matched before param routes.',
      operationId: 'listInventory',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'warehouseId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'variantId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'warehouse_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Alias for warehouseId' },
        { name: 'productVariantId', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Alias for variantId' },
        { name: 'sku', in: 'query', schema: { type: 'string', maxLength: 100 } },
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 255 } },
      ],
      responses: {
        200: { description: 'Inventory retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Inventory' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/inventory/movements': {
    get: {
      tags: ['Inventory'],
      summary: 'List inventory movements',
      description: 'Requires `inventory:read`. Must be before /inventory/variants/:variantId.',
      operationId: 'listMovements',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'variantId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'productVariantId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'warehouseId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'type', in: 'query', schema: { type: 'string', enum: ['ADJUSTMENT', 'TRANSFER', 'ORDER_RESERVATION', 'ORDER_RELEASE', 'ORDER_FULFILLMENT', 'RETURN', 'DAMAGED', 'LOST', 'COUNT'] } },
        { name: 'reason', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Movements retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/InventoryMovement' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/inventory/low-stock': {
    get: {
      tags: ['Inventory'],
      summary: 'Low stock report',
      description: 'Requires `inventory:read`.',
      operationId: 'lowStock',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'threshold', in: 'query', schema: { type: 'integer', minimum: 0, default: 10 } },
        { name: 'warehouseId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Low stock items', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Inventory' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/inventory/variants/{variantId}': {
    get: {
      tags: ['Inventory'],
      summary: 'Get inventory for variant',
      description: 'Requires `inventory:read`.',
      operationId: 'getVariantInventory',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'variantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Variant inventory', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Inventory' } } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/inventory/adjust': {
    post: {
      tags: ['Inventory'],
      summary: 'Adjust inventory',
      description: 'Requires `inventory:update`. quantityChanged !=0. Requires variantId (or productVariantId alias) and warehouseId.',
      operationId: 'adjustInventory',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['warehouseId', 'quantityChanged'],
              properties: {
                variantId: { type: 'string', format: 'uuid' },
                productVariantId: { type: 'string', format: 'uuid', description: 'Alias for variantId' },
                warehouseId: { type: 'string', format: 'uuid' },
                quantityChanged: { type: 'integer', example: 10, description: 'Positive or negative, cannot be 0' },
                quantity: { type: 'integer' },
                reason: { type: 'string', maxLength: 500 },
                referenceType: { type: 'string', maxLength: 100 },
                referenceId: { type: 'string', maxLength: 255 },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Inventory adjusted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Inventory' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/inventory/transfer': {
    post: {
      tags: ['Inventory'],
      summary: 'Transfer inventory',
      description: 'Requires `inventory:update`. Moves stock between warehouses.',
      operationId: 'transferInventory',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['sourceWarehouseId', 'destinationWarehouseId', 'quantity'],
              properties: {
                variantId: { type: 'string', format: 'uuid' },
                productVariantId: { type: 'string', format: 'uuid' },
                sourceWarehouseId: { type: 'string', format: 'uuid' },
                destinationWarehouseId: { type: 'string', format: 'uuid' },
                warehouseId: { type: 'string', format: 'uuid', description: 'Alias for sourceWarehouseId' },
                destWarehouseId: { type: 'string', format: 'uuid', description: 'Alias for destinationWarehouseId' },
                quantity: { type: 'integer', minimum: 1, example: 5 },
                reason: { type: 'string', maxLength: 500 },
                referenceType: { type: 'string', maxLength: 100 },
                referenceId: { type: 'string', maxLength: 255 },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Inventory transferred', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
};
