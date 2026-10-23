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

const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt,
  price_asc: (a, b) => a.min - b.min,
  price_desc: (a, b) => b.max - a.max,
  name: (a, b) => a.name.localeCompare(b.name),
};

/**
 * Product cards. Filtering by search/category/price runs in the database; sorting by price and the
 * in-stock filter need per-product aggregates, so the matching set is ranked in memory and then paged.
 */
export async function listProducts(store, { search, category, minPrice, maxPrice, inStock, sort = 'newest', page = 1, limit = 24 }) {
  const tenantId = store.id;
  const variantWhere = sellableVariant(tenantId);
  const where = sellableProduct(tenantId);
  if (minPrice !== undefined || maxPrice !== undefined) {
    where.variants = { some: { ...variantWhere, price: { ...(minPrice !== undefined ? { gte: minPrice } : {}), ...(maxPrice !== undefined ? { lte: maxPrice } : {}) } } };
  }
  if (search) {
    where.OR = ['name', 'brand', 'description'].map((field) => ({ [field]: { contains: search, mode: 'insensitive' } }));
  }
  if (category) where.categories = { some: { category: { slug: category, isActive: true, deletedAt: null } } };

  const products = await getPrismaClient().product.findMany({
    where,
    select: {
      id: true, name: true, brand: true, createdAt: true,
      variants: { where: variantWhere, select: { price: true, inventory: { select: { quantity: true } } } },
      images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1, select: { id: true, storageKey: true, altText: true } },
    },
  });
  let ranked = products.map((p) => {
    const prices = p.variants.map((v) => Number(v.price));
    return { ...p, min: Math.min(...prices), max: Math.max(...prices), inStock: p.variants.some((v) => stockOf(v) > 0) };
  });
  if (inStock) ranked = ranked.filter((p) => p.inStock);
  ranked.sort((a, b) => SORTS[sort](a, b) || a.id.localeCompare(b.id));

  const total = ranked.length;
  const pageItems = ranked.slice((page - 1) * limit, page * limit);
  const data = await Promise.all(pageItems.map(async (p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    priceFrom: money(p.min),
    priceTo: money(p.max),
    currency: store.currency,
    inStock: p.inStock,
    image: await imageUrl(p.images[0]),
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
