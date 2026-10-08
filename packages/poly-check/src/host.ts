// `poly check --host <tsconfig>` (PT28.1d, PT10h, S312): host code compiled against the generated declarations. Each
// error the TypeScript compiler reports is PL6836 HOST_TYPE_ERROR at the host file's line and column. The compiler is
// loaded in this process, since a check package starts no subprocess; a host check that cannot run is listed as not
// run with its reason, never as clean.
import { dirname, relative, resolve } from 'node:path';
import { diag, type Diagnostic } from '@poly/core';

export type HostCheck = { status: 'ran'; tsconfig: string; files: number; diagnostics: Diagnostic[] } | { status: 'not-run'; tsconfig: string; reason: string };

export async function checkHost(tsconfig: string): Promise<HostCheck> {
  const path = resolve(tsconfig);
  let ts: typeof import('typescript');
  try {
    const mod = (await import('typescript')) as { default?: typeof import('typescript') } & typeof import('typescript');
    ts = mod.default ?? mod;
  } catch (e) {
    return { status: 'not-run', tsconfig: path, reason: `the typescript package is not installed beside poly (${(e as Error).message})` };
  }
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) return { status: 'not-run', tsconfig: path, reason: `the tsconfig does not read: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}` };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
  if (parsed.errors.length) return { status: 'not-run', tsconfig: path, reason: `the tsconfig does not read: ${parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}` };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const diagnostics: Diagnostic[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      const file = relative(dirname(path), d.file.fileName).split('\\').join('/');
      diagnostics.push(diag('PL6836', { module: file, line: line + 1, col: character + 1 }, `${file}:${line + 1}:${character + 1}: TS${d.code} ${text}`));
    } else diagnostics.push(diag('PL6836', {}, `TS${d.code} ${text}`));
  }
  return { status: 'ran', tsconfig: path, files: parsed.fileNames.length, diagnostics };
}
