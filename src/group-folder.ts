import path from 'path';

import { DATA_DIR, GROUPS_DIR, TENANTS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

export function resolveGroupFolderPathForTenant(
  tenantId: string,
  folder: string,
): string {
  if (tenantId === 'default') return resolveGroupFolderPath(folder);
  assertValidGroupFolder(folder);
  const tenantGroupsDir = path.resolve(TENANTS_DIR, tenantId, 'groups');
  const groupPath = path.resolve(tenantGroupsDir, folder);
  ensureWithinBase(tenantGroupsDir, groupPath);
  return groupPath;
}

export function resolveGroupIpcPathForTenant(
  tenantId: string,
  folder: string,
): string {
  if (tenantId === 'default') return resolveGroupIpcPath(folder);
  assertValidGroupFolder(folder);
  const tenantIpcDir = path.resolve(TENANTS_DIR, tenantId, 'data', 'ipc');
  const ipcPath = path.resolve(tenantIpcDir, folder);
  ensureWithinBase(tenantIpcDir, ipcPath);
  return ipcPath;
}
