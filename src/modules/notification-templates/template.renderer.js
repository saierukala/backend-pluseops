// {{ name }} placeholders only — no expressions, loops or code, so a tenant-written template can't run anything.
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function placeholders(text) {
  return [...new Set([...(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/** Fills placeholders from `variables`; missing ones become empty and are reported. */
export function render(text, variables = {}) {
  const missing = new Set();
  const output = (text ?? '').replace(PLACEHOLDER, (_, name) => {
    const value = variables[name];
    if (value === undefined || value === null) {
      missing.add(name);
      return '';
    }
    return String(value);
  });
  return { output, missing: [...missing] };
}

export function renderTemplate(template, variables = {}) {
  const subject = template.subject == null ? { output: null, missing: [] } : render(template.subject, variables);
  const body = render(template.body, variables);
  return { subject: subject.output, body: body.output, missingVariables: [...new Set([...subject.missing, ...body.missing])] };
}

/** The active template a job asked for, or null (callers then use the job's own title/message). */
export async function findActiveTemplate(prisma, tenantId, name, channel) {
  if (!name) return null;
  return prisma.notificationTemplate.findFirst({ where: { tenantId, name, channel, isActive: true } });
}
