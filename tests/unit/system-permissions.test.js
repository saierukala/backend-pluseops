import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PERMISSIONS, MANAGER_EXCLUDED_PERMISSIONS } from '../../src/modules/permissions/system-permissions.js';

const MODULES_DIR = join(process.cwd(), 'src', 'modules');

function permissionsRequiredByRoutes() {
  const required = new Set();
  for (const mod of readdirSync(MODULES_DIR)) {
    const file = join(MODULES_DIR, mod, `${mod}.routes.js`);
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of source.matchAll(/\bauthorize\('([a-z_]+:[a-z_]+)'\)/g)) required.add(match[1]);
  }
  return required;
}

describe('System permission catalog', () => {
  const catalog = new Set(SYSTEM_PERMISSIONS.map((p) => p.name));

  it('covers every permission a tenant route requires', () => {
    const missing = [...permissionsRequiredByRoutes()].filter((p) => !catalog.has(p));
    expect(missing).toEqual([]);
  });

  it('has unique resource:action names matching their parts', () => {
    expect(catalog.size).toBe(SYSTEM_PERMISSIONS.length);
    for (const p of SYSTEM_PERMISSIONS) expect(p.name).toBe(`${p.resource}:${p.action}`);
  });

  it('only excludes catalogued permissions from the manager role', () => {
    for (const p of MANAGER_EXCLUDED_PERMISSIONS) expect(catalog.has(p)).toBe(true);
  });
});
