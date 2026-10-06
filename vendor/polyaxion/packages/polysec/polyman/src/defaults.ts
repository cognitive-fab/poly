// Paths to polyman's SHIPPED default policy (the pre-proven lethal-trifecta),
// resolved relative to the package so a standalone install finds them. Zero-
// config `createPolyman()` uses these; the design-time proof is shipped WITH the
// package (run `polyman verify` to re-check it against the machine).
import { fileURLToPath } from 'node:url';

export function defaultPolicyMachine(): string {
  return fileURLToPath(new URL('../policy/lethal-trifecta.cjs', import.meta.url));
}

export function defaultSecurityPath(): string {
  return fileURLToPath(new URL('../policy/lethal-trifecta.security.json', import.meta.url));
}

export function defaultContractPath(): string {
  return fileURLToPath(new URL('../policy/lethal-trifecta.contract.json', import.meta.url));
}
