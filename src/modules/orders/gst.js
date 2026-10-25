import { env } from '../../config/env.js';

/**
 * Phase 37 — GST on orders. Every line is taxed at the workspace's rate on its value after discount
 * (prices are exclusive of GST). The rate comes from TenantSettings.metadata.gstRatePercent, falling back
 * to DEFAULT_GST_RATE_PERCENT (18 by default).
 */
export const DEFAULT_CURRENCY = 'INR';

/** The workspace's order defaults: GST rate and currency (INR unless the workspace chose another). */
export async function resolveOrderDefaults(prisma, tenantId) {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { metadata: true } });
  const rate = settings?.metadata?.gstRatePercent;
  return {
    gstRatePercent: typeof rate === 'number' && Number.isFinite(rate) ? rate : env.DEFAULT_GST_RATE_PERCENT,
    currency: settings?.metadata?.currency || DEFAULT_CURRENCY,
  };
}

/** GST in minor units (paise) for a taxable amount in minor units, rounded half-up to the paisa. */
export function gstCents(taxableCents, ratePercent) {
  if (taxableCents <= 0 || ratePercent <= 0) return 0;
  // Rates allow two decimals, so scale by 100 to keep the multiplication in integers
  return Math.round((taxableCents * Math.round(ratePercent * 100)) / 10000);
}
