import { financialYear } from '../gst/india.js';
import { invoicePrefix } from './gst.js';

/**
 * Phase 40: numbers for documents other than invoices — quotes (ACME-QT/2026-27/0001) and credit notes
 * (ACME-CN/2026-27/0001). One counter per workspace, kind and Indian financial year; the upsert locks the
 * counter row, so two documents created together never share a number. Call inside the transaction that
 * creates the document.
 */
export const DOC_CODES = { QUOTE: 'QT', CREDIT_NOTE: 'CN' };

export async function nextDocumentNumber(tx, tenantId, kind, { taxProfile, slug } = {}) {
  const fy = financialYear();
  const [{ last_number: n }] = await tx.$queryRaw`INSERT INTO "document_sequences" ("tenant_id", "kind", "financial_year", "last_number", "updated_at") VALUES (${tenantId}, ${kind}, ${fy}, 1, NOW()) ON CONFLICT ("tenant_id", "kind", "financial_year") DO UPDATE SET "last_number" = "document_sequences"."last_number" + 1, "updated_at" = NOW() RETURNING "last_number"`;
  return `${invoicePrefix(taxProfile, slug)}-${DOC_CODES[kind]}/${fy}/${String(n).padStart(4, '0')}`;
}
