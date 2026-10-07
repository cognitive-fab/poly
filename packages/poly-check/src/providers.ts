// PT10e (M9 step 5, S203): the provider profiles a program's credentials name, read from
// <std>/credentials/providers/<p>.json. The checker and the lowering are given them as data, with the digest of each
// file's bytes, which the credential's descriptor records; poly-ref reads the same files on its own.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module, ProviderEntry } from '@poly/core';
import { STD } from './uses.js';

/** A provider name that is a plain file name; any other (a path, a dot segment) has no profile. */
const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;

/** The profile of each provider the modules' credentials name, where its file exists; a missing one is PL1001 at check. */
export function resolveProviders(modules: readonly Module[], std: string = STD): Record<string, ProviderEntry> {
  const out: Record<string, ProviderEntry> = {};
  for (const m of modules) {
    for (const d of m.decls) {
      if (d.kind !== 'Credential' || d.provider in out || !PROVIDER.test(d.provider)) continue;
      const file = join(std, 'credentials', 'providers', `${d.provider}.json`);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      let profile: unknown = null;
      try { profile = JSON.parse(bytes.toString('utf8')); } catch { profile = null; }
      out[d.provider] = { profile, file, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
    }
  }
  return out;
}
