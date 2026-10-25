/**
 * Demo workspace seed — drives the public API of a running server so every record goes
 * through the same validation, inventory reservation and payment flows as the frontend.
 *
 *   npm start                 # in another terminal
 *   npm run db:seed:demo      # API_URL defaults to http://localhost:3000/api/v1
 *
 * Idempotent: an existing demo tenant is reused and only an empty catalog is filled.
 * Development only — the demo admin credentials below are public test values.
 */
import { existsSync } from 'node:fs';
import { resolvePlatformAdminCredentials } from '../prisma/platform-admin-credentials.js';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  const deploymentEnvironment = { ...process.env };
  process.loadEnvFile('.env');
  Object.assign(process.env, deploymentEnvironment);
}

const API = (process.env.API_URL || 'http://localhost:3000/api/v1').replace(/\/+$/, '');
const DEMO = {
  tenant: { name: 'Acme Retail', slug: 'acme' },
  admin: { email: 'demo.admin@acme.test', password: 'DemoAdmin#2026', firstName: 'Avery', lastName: 'Admin' },
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(`${method} ${path} -> ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`);
    error.code = json.error?.code;
    throw error;
  }
  return json.data;
}

async function login(email, password, extra) {
  return (await call('POST', '/auth/login', { body: { email, password, ...extra } })).accessToken;
}

async function ensureTenant() {
  try {
    return await login(DEMO.admin.email, DEMO.admin.password, { tenantSlug: DEMO.tenant.slug });
  } catch {
    const { email, password } = resolvePlatformAdminCredentials(process.env);
    const platformToken = await login(email, password, { scope: 'platform' });
    await call('POST', '/platform/tenants', {
      token: platformToken,
      body: { ...DEMO.tenant, status: 'ACTIVE', plan: 'pro', admin: DEMO.admin },
    });
    console.log(`Created tenant "${DEMO.tenant.slug}"`);
    return login(DEMO.admin.email, DEMO.admin.password, { tenantSlug: DEMO.tenant.slug });
  }
}

const CATALOG = [
  { category: 'Apparel', products: [
    { name: 'Everyday Hoodie', brand: 'Northwind', price: '2499.00', skus: ['HOOD-S', 'HOOD-M', 'HOOD-L'] },
    { name: 'Merino Crew Tee', brand: 'Northwind', price: '1299.00', skus: ['TEE-M', 'TEE-L'] },
  ] },
  { category: 'Electronics', products: [
    { name: 'Wireless Earbuds Pro', brand: 'Sonic', price: '4999.00', skus: ['EAR-BLK', 'EAR-WHT'] },
    { name: 'USB-C Charging Dock', brand: 'Voltix', price: '2799.00', skus: ['DOCK-1'] },
  ] },
  { category: 'Home', products: [
    { name: 'Ceramic Pour-Over Set', brand: 'Kinto', price: '1599.00', skus: ['POUR-WHT'] },
    { name: 'Linen Throw Blanket', brand: 'Hearth', price: '3299.00', skus: ['THROW-SND', 'THROW-SLT'] },
  ] },
];

const CUSTOMERS = [
  ['olivia.chen@example.com', 'Olivia', 'Chen'],
  ['marcus.reid@example.com', 'Marcus', 'Reid'],
  ['priya.nair@example.com', 'Priya', 'Nair'],
  ['diego.alvarez@example.com', 'Diego', 'Alvarez'],
  ['hannah.kim@example.com', 'Hannah', 'Kim'],
];

// Order lifecycle targets, cycled across seeded orders
const PATHS = [
  ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'],
  ['CONFIRMED', 'PROCESSING'],
  ['CONFIRMED'],
  [],
  ['CONFIRMED', 'PROCESSING', 'SHIPPED'],
  'CANCEL',
];

async function main() {
  const token = await ensureTenant();
  const existing = await call('GET', '/products?limit=1', { token });
  if (existing.length) {
    console.log('Demo tenant already has products — nothing to seed.');
    return printLogin();
  }

  const warehouses = [];
  for (const [name, code, city, isDefault] of [['Main Warehouse', 'MAIN', 'Bengaluru', true], ['West Fulfillment', 'WEST', 'Mumbai', false]]) {
    warehouses.push(await call('POST', '/warehouses', { token, body: { name, code, city, country: 'IN', isDefault } }));
  }

  const variants = [];
  for (const group of CATALOG) {
    const slug = group.category.toLowerCase();
    const category = await call('POST', '/categories', { token, body: { name: group.category, slug } });
    for (const p of group.products) {
      const product = await call('POST', '/products', {
        token,
        body: { name: p.name, brand: p.brand, status: 'ACTIVE', basePrice: p.price, categories: [category.id], primaryCategoryId: category.id, description: `${p.name} by ${p.brand}.` },
      });
      for (const sku of p.skus) {
        const variant = await call('POST', `/products/${product.id}/variants`, { token, body: { sku, price: p.price, status: 'ACTIVE' } });
        variants.push(variant);
        for (const [i, warehouse] of warehouses.entries()) {
          // Leave a few variants low on stock so the low-stock views have content
          const quantity = variants.length % 4 === 0 ? 6 - i * 3 : 40 + variants.length * 3 - i * 15;
          if (quantity > 0) {
            await call('POST', '/inventory/adjust', { token, body: { variantId: variant.id, warehouseId: warehouse.id, quantityChanged: quantity, reason: 'Initial stock' } });
          }
        }
      }
    }
  }

  const customers = [];
  for (const [email, firstName, lastName] of CUSTOMERS) {
    customers.push(await call('POST', '/customers', { token, body: { email, firstName, lastName } }));
  }

  for (let i = 0; i < 12; i++) {
    const items = [variants[i % variants.length], variants[(i * 3 + 1) % variants.length]]
      .filter((v, idx, all) => all.findIndex((x) => x.id === v.id) === idx)
      .map((v, idx) => ({ productVariantId: v.id, warehouseId: warehouses[0].id, quantity: 1 + ((i + idx) % 3) }));
    const order = await call('POST', '/orders', { token, body: { customerId: customers[i % customers.length].id, items, shippingTotal: '99.00' } });

    const path = PATHS[i % PATHS.length];
    if (path === 'CANCEL') {
      await call('POST', `/orders/${order.id}/cancel`, { token, body: { reason: 'Customer changed their mind' } });
      continue;
    }
    if (path.length) {
      const payment = await call('POST', '/payments/create', { token, body: { orderId: order.id, provider: 'stripe' } });
      await call('POST', '/payments/confirm', { token, body: { paymentId: payment.id } });
    }
    for (const status of path) {
      await call('PATCH', `/orders/${order.id}/status`, { token, body: { status } });
    }
  }

  console.log(`Seeded ${warehouses.length} warehouses, ${variants.length} variants, ${customers.length} customers and 12 orders.`);
  printLogin();
}

function printLogin() {
  console.log(`Sign in at the frontend with workspace "${DEMO.tenant.slug}" and the demo admin from scripts/seed-demo.js.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
