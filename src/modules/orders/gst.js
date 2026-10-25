import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { toStateCode } from '../gst/india.js';

/**
 * GST on orders.
 * Phase 37: every line taxed at the workspace rate (prices exclusive of GST), default DEFAULT_GST_RATE_PERCENT.
 * Phase 38: a product can carry its own rate and taxability; the workspace tax profile can say prices
 * include GST; tax splits into CGST+SGST inside the shop's state and IGST across states.
 */
export const DEFAULT_CURRENCY = 'INR';

/** The workspace's order defaults: GST rate, currency (INR unless chosen otherwise) and tax profile. */
export async function resolveOrderDefaults(prisma, tenantId) {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { metadata: true } });
  const rate = settings?.metadata?.gstRatePercent;
  return {
    gstRatePercent: typeof rate === 'number' && Number.isFinite(rate) ? rate : env.DEFAULT_GST_RATE_PERCENT,
    currency: settings?.metadata?.currency || DEFAULT_CURRENCY,
    taxProfile: settings?.metadata?.taxProfile ?? {},
  };
}

/** GST in minor units (paise) for a taxable amount in minor units, rounded half-up to the paisa. */
export function gstCents(taxableCents, ratePercent) {
  if (taxableCents <= 0 || ratePercent <= 0) return 0;
  // Rates allow two decimals, so scale by 100 to keep the multiplication in integers
  return Math.round((taxableCents * Math.round(ratePercent * 100)) / 10000);
}

/** GST already inside a tax-inclusive amount: gross × r / (100 + r), to the paisa. */
export function includedGstCents(grossCents, ratePercent) {
  if (grossCents <= 0 || ratePercent <= 0) return 0;
  const r = Math.round(ratePercent * 100);
  return Math.round((grossCents * r) / (10000 + r));
}

/** The rate a line is taxed at: none for nil-rated/exempt/non-GST goods, else the product's own rate or the default. */
export function lineRate(product, defaultRate) {
  if (product?.gstTaxability && product.gstTaxability !== 'TAXABLE') return 0;
  const own = product?.gstRatePercent;
  return own !== null && own !== undefined ? Number(own) : defaultRate;
}

/**
 * Taxable value and GST for one line, in paise.
 * `grossCents` is unit price × qty − discount, which already includes GST when prices are tax-inclusive.
 */
export function lineTax(grossCents, ratePercent, { inclusive = false, explicitTaxCents } = {}) {
  if (explicitTaxCents !== undefined) return { taxableCents: grossCents, taxCents: explicitTaxCents };
  if (inclusive) {
    const taxCents = includedGstCents(grossCents, ratePercent);
    return { taxableCents: grossCents - taxCents, taxCents };
  }
  return { taxableCents: grossCents, taxCents: gstCents(grossCents, ratePercent) };
}

/** Intra-state supply → CGST + SGST (halves; any odd paisa goes to SGST). Inter-state → IGST. */
export function splitTax(taxCents, intraState) {
  if (!intraState) return { cgst: 0, sgst: 0, igst: taxCents };
  const cgst = Math.floor(taxCents / 2);
  return { cgst, sgst: taxCents - cgst, igst: 0 };
}

/**
 * Where the goods go (place of supply): the shipping address state, else the billing address, else the
 * customer's own state or GSTIN; null when unknown (then the sale is treated as within the shop's state).
 */
export function placeOfSupply({ shippingAddress, billingAddress, customer }) {
  return (
    toStateCode(shippingAddress?.state) ??
    toStateCode(billingAddress?.state) ??
    customer?.stateCode ??
    (customer?.gstin ? customer.gstin.slice(0, 2) : null)
  );
}

/** Same state as the shop, or either side unknown → intra-state. */
export function isIntraState(sellerState, supplyState) {
  return !sellerState || !supplyState || sellerState === supplyState;
}

/** Invoice prefix: the profile's own, else the first letters of the slug. */
export function invoicePrefix(taxProfile, slug) {
  const own = taxProfile?.invoicePrefix;
  if (own) return own;
  return (slug || 'INV').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'INV';
}

export const formatInvoiceNumber = (prefix, fy, n) => `${prefix}/${fy}/${String(n).padStart(4, '0')}`;

const toCents = (value) => Math.round(parseFloat(value) * 100);
const money = (c) => (c / 100).toFixed(2);

/**
 * Prices order/quote lines from the catalog (Phase 40: shared by orders and quotes so they always agree).
 * `items`: { productVariantId, warehouseId?, quantity, discount, tax? }; `variantMap`: id → variant with product.
 * Returns each line (unit price, discount, tax, total, GST split) and the totals, all in paise.
 */
export function priceItems(items, variantMap, { chargesGst, gstRatePercent, inclusive, intraState }) {
  let subtotalCents = 0;
  let discountTotalCents = 0;
  let taxTotalCents = 0;
  const gstTotals = { cgst: 0, sgst: 0, igst: 0 };
  const lines = [];
  for (const item of items) {
    const variant = variantMap.get(item.productVariantId);
    const unitPriceStr = variant.price.toString();
    const unitCents = toCents(unitPriceStr);
    const qty = item.quantity;
    if (qty <= 0) throw new AppError('Quantity must be positive', { statusCode: 400, code: 'INVALID_QUANTITY' });
    const discountCents = toCents(item.discount ?? '0');
    if (discountCents < 0) throw new AppError('Discount/tax cannot be negative', { statusCode: 400, code: 'INVALID_MONEY' });
    const explicitTaxCents = item.tax !== undefined ? toCents(item.tax) : undefined;
    if (explicitTaxCents < 0) throw new AppError('Discount/tax cannot be negative', { statusCode: 400, code: 'INVALID_MONEY' });
    const grossCents = unitCents * qty - discountCents;
    if (grossCents < 0) throw new AppError('Line total cannot be negative', { statusCode: 400, code: 'INVALID_LINE_TOTAL' });
    const rate = chargesGst ? lineRate(variant.product, gstRatePercent) : 0;
    // With tax-inclusive prices the GST comes out of the price instead of being added on top
    const { taxableCents, taxCents } = lineTax(grossCents, rate, { inclusive, explicitTaxCents });
    const split = splitTax(taxCents, intraState);
    const lineTotalCents = taxableCents + taxCents;
    subtotalCents += taxableCents + discountCents;
    discountTotalCents += discountCents;
    taxTotalCents += taxCents;
    gstTotals.cgst += split.cgst;
    gstTotals.sgst += split.sgst;
    gstTotals.igst += split.igst;
    lines.push({
      productVariantId: item.productVariantId,
      warehouseId: item.warehouseId,
      quantity: qty,
      unitPriceStr,
      discountStr: money(discountCents),
      taxStr: money(taxCents),
      lineTotalStr: money(lineTotalCents),
      gst: { rate, taxable: money(taxableCents), cgst: money(split.cgst), sgst: money(split.sgst), igst: money(split.igst) },
      variant,
    });
  }
  return { lines, subtotalCents, discountTotalCents, taxTotalCents, gstTotals };
}
