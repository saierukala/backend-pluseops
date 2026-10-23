import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { StorageService } from '../../common/storage/storage.service.js';

const IMAGE_URL_TTL_SECONDS = 3600;
const storage = new StorageService();

// Only sellable things are public: ACTIVE, not deleted, with at least one ACTIVE variant.
export const sellableVariant = (tenantId) => ({ tenantId, status: 'ACTIVE', deletedAt: null });
const sellableProduct = (tenantId) => ({ tenantId, status: 'ACTIVE', deletedAt: null, variants: { some: sellableVariant(tenantId) } });

const money = (d) => d.toFixed(2);
export const stockOf = (variant) => variant.inventory.reduce((sum, i) => sum + i.quantity, 0);

async function imageUrl(image) {
  if (!image) return null;
  return { id: image.id, url: await storage.getSignedUrl(image.storageKey, IMAGE_URL_TTL_SECONDS), altText: image.altText ?? null };
}

export function attributesOf(variant) {
  const attributes = {};
  for (const a of variant.attributes ?? []) attributes[a.attributeDefinition.code] = a.value;
  return attributes;
}

export async function listCategories(tenantId) {
  return getPrismaClient().category.findMany({
    where: { tenantId, isActive: true, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, slug: true, description: true, parentId: true },
  });
}

// Fixed ORDER BY fragments (never built from input); ties broken by id so pages are stable
const ORDER_BY = {
  newest: Prisma.sql`created_at DESC, id ASC`,
  price_asc: Prisma.sql`min_price ASC, id ASC`,
  price_desc: Prisma.sql`max_price DESC, id ASC`,
  name: Prisma.sql`name ASC, id ASC`,
};

// ILIKE treats % _ \ as wildcards/escape; a shopper's search is literal text
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Product cards. Phase 36: filtering, per-product aggregates (price range, in stock), sorting and paging all run in
 * one SQL query, so a request reads one page of products instead of the whole catalog.
 */
export async function listProducts(store, { search, category, minPrice, maxPrice, inStock, sort = 'newest', page = 1, limit = 24 }) {
  const tenantId = store.id;
  const prisma = getPrismaClient();
  const productFilters = [Prisma.sql`p.tenant_id = ${tenantId}`, Prisma.sql`p.status = 'ACTIVE'`, Prisma.sql`p.deleted_at IS NULL`];
  if (search) {
    const pattern = likePattern(search);
    productFilters.push(Prisma.sql`(p.name ILIKE ${pattern} OR p.brand ILIKE ${pattern} OR p.description ILIKE ${pattern})`);
  }
  if (category) {
    productFilters.push(Prisma.sql`EXISTS (SELECT 1 FROM product_categories pc JOIN categories c ON c.id = pc.category_id
      WHERE pc.product_id = p.id AND pc.tenant_id = ${tenantId} AND c.slug = ${category} AND c.is_active AND c.deleted_at IS NULL)`);
  }
  // Same rules as before: a product matches a price range when one of its sellable variants is in it
  const having = [];
  if (minPrice !== undefined || maxPrice !== undefined) {
    const lower = minPrice !== undefined ? Prisma.sql`v.price >= ${minPrice}::numeric` : Prisma.sql`TRUE`;
    const upper = maxPrice !== undefined ? Prisma.sql`v.price <= ${maxPrice}::numeric` : Prisma.sql`TRUE`;
    having.push(Prisma.sql`BOOL_OR(${lower} AND ${upper})`);
  }
  if (inStock) having.push(Prisma.sql`BOOL_OR(v.stock > 0)`);

  const rows = await prisma.$queryRaw`
    WITH v AS (
      SELECT pv.product_id, pv.price,
        COALESCE((SELECT SUM(i.quantity) FROM inventory i WHERE i.tenant_id = pv.tenant_id AND i.product_variant_id = pv.id), 0) AS stock
      FROM product_variants pv
      WHERE pv.tenant_id = ${tenantId} AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
    ), ranked AS (
      SELECT p.id, p.name, p.brand, p.created_at, MIN(v.price) AS min_price, MAX(v.price) AS max_price, BOOL_OR(v.stock > 0) AS in_stock
      FROM products p JOIN v ON v.product_id = p.id
      WHERE ${Prisma.join(productFilters, ' AND ')}
      GROUP BY p.id
      ${having.length ? Prisma.sql`HAVING ${Prisma.join(having, ' AND ')}` : Prisma.empty}
    )
    SELECT id, name, brand, min_price, max_price, in_stock, COUNT(*) OVER () AS total
    FROM ranked ORDER BY ${ORDER_BY[sort]} LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length && page > 1) {
    // Past the last page: the window count isn't there, so count the matches on their own
    const counted = await listProducts(store, { search, category, minPrice, maxPrice, inStock, sort, page: 1, limit: 1 });
    total = counted.meta.total;
  }

  const ids = rows.map((r) => r.id);
  const images = ids.length
    ? await prisma.productImage.findMany({ where: { tenantId, productId: { in: ids } }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], select: { id: true, productId: true, storageKey: true, altText: true } })
    : [];
  const firstImage = new Map();
  for (const img of images) if (!firstImage.has(img.productId)) firstImage.set(img.productId, img);

  const data = await Promise.all(rows.map(async (p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    priceFrom: money(Number(p.min_price)),
    priceTo: money(Number(p.max_price)),
    currency: store.currency,
    inStock: p.in_stock,
    image: await imageUrl(firstImage.get(p.id)),
  })));
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getProduct(store, productId) {
  const tenantId = store.id;
  const product = await getPrismaClient().product.findFirst({
    where: { id: productId, ...sellableProduct(tenantId) },
    include: {
      variants: {
        where: sellableVariant(tenantId),
        orderBy: { price: 'asc' },
        include: { inventory: { select: { quantity: true } }, attributes: { include: { attributeDefinition: { select: { code: true } } } } },
      },
      images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      categories: { where: { category: { isActive: true, deletedAt: null } }, include: { category: { select: { id: true, name: true, slug: true } } } },
    },
  });
  if (!product) throw new AppError('Product not found', { statusCode: 404, code: 'PRODUCT_NOT_FOUND' });
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    description: product.description,
    currency: store.currency,
    categories: product.categories.map((c) => c.category),
    images: await Promise.all(product.images.map(async (img) => ({ ...(await imageUrl(img)), variantId: img.variantId }))),
    // Availability only, never stock levels; no cost price or barcode
    variants: product.variants.map((v) => ({ id: v.id, sku: v.sku, price: money(Number(v.price)), attributes: attributesOf(v), inStock: stockOf(v) > 0 })),
  };
}
