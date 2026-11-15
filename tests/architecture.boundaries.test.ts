import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const backendRoot = path.join(root, 'packages/backend/src');
const modulesRoot = path.join(backendRoot, 'modules');
const securityRoot = path.join(backendRoot, 'security');
const contractsRoot = path.join(root, 'packages/contracts/src');
const webRoot = path.join(root, 'apps/web/src');

const allowedDomainDependencies: Readonly<Record<string, readonly string[]>> = {
  agents: ['identity', 'tickets'],
  capabilities: ['delivery', 'development', 'flows', 'identity', 'tickets'],
  connectors: ['identity'],
  delivery: ['development', 'identity', 'tickets'],
  development: ['agents', 'executions', 'identity', 'tickets'],
  executions: [],
  flows: ['agents', 'delivery', 'development', 'health', 'identity', 'tickets'],
  health: ['agents', 'connectors', 'identity', 'integrations', 'smtp', 'tickets'],
  identity: [],
  integrations: ['connectors', 'identity', 'smtp'],
  metrics: ['identity', 'tickets'],
  notifications: ['identity', 'integrations', 'smtp'],
  operations: ['identity'],
  smtp: [],
  tickets: ['identity'],
  workflow: ['identity', 'tickets'],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return file.endsWith('.ts') && !file.endsWith('.test.ts') ? [file] : [];
  });
}

function importedPaths(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

function exportedApiDocumentationGaps(files: string[]): string[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const gaps: string[] = [];
    const hasDoc = (node: ts.Node) =>
      (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.length;
    const exported = (node: ts.Node) =>
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const report = (node: ts.Node, name: string) => {
      if (!hasDoc(node))
        gaps.push(
          `${path.relative(root, file)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1} ${name}`,
        );
    };

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && exported(statement))
        report(statement, `function ${statement.name?.text ?? '<anonymous>'}`);
      if (!ts.isClassDeclaration(statement) || !exported(statement)) continue;
      report(statement, `class ${statement.name?.text ?? '<anonymous>'}`);
      for (const member of statement.members) {
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)) &&
          !ts
            .getModifiers(member)
            ?.some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.PrivateKeyword ||
                modifier.kind === ts.SyntaxKind.ProtectedKeyword,
            )
        )
          report(member, `${statement.name?.text}.${member.name.getText(sourceFile)}`);
      }
    }
    return gaps;
  });
}

function resolveTypeScriptImport(sourceFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(sourceFile), specifier);
  const target = resolved.endsWith('.js') ? resolved.slice(0, -3) + '.ts' : `${resolved}.ts`;
  if (existsSync(target)) return target;
  const index = path.join(resolved, 'index.ts');
  return existsSync(index) ? index : null;
}

function domainOf(file: string): string {
  return path.relative(modulesRoot, file).split(path.sep)[0]!;
}

function domainDependencies(files: string[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const sourceDomain = domainOf(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of importedPaths(source)) {
      const target = resolveTypeScriptImport(file, specifier);
      if (!target || !target.startsWith(`${modulesRoot}${path.sep}`)) continue;
      const targetDomain = domainOf(target);
      if (targetDomain === sourceDomain) continue;
      const dependencies = edges.get(sourceDomain) ?? new Set<string>();
      dependencies.add(targetDomain);
      edges.set(sourceDomain, dependencies);
    }
  }
  return edges;
}

function domainCycles(files: string[]): string[][] {
  const edges = domainDependencies(files);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];
  const visit = (domain: string, stack: string[]) => {
    if (visiting.has(domain)) {
      cycles.push([...stack.slice(stack.indexOf(domain)), domain]);
      return;
    }
    if (visited.has(domain)) return;
    visiting.add(domain);
    for (const dependency of edges.get(domain) ?? []) visit(dependency, [...stack, dependency]);
    visiting.delete(domain);
    visited.add(domain);
  };
  for (const domain of edges.keys()) visit(domain, [domain]);
  return cycles;
}

describe('architecture boundaries', () => {
  it('keeps backend modules free of dependencies on application entrypoints', () => {
    const applicationFiles = sourceFiles(backendRoot);
    const violations = applicationFiles.flatMap((file) =>
      importedPaths(readFileSync(file, 'utf8'))
        .filter((specifier) => /(?:^|\/)apps\//.test(specifier.replaceAll('\\', '/')))
        .map((specifier) => `${path.relative(root, file)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it('keeps shared contracts independent from application and backend code', () => {
    const violations = sourceFiles(contractsRoot).flatMap((file) =>
      importedPaths(readFileSync(file, 'utf8'))
        .filter((specifier) => /(?:^|\/)(?:apps|backend)\//.test(specifier.replaceAll('\\', '/')))
        .map((specifier) => `${path.relative(root, file)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it('keeps the web application independent from backend implementation details', () => {
    const violations = sourceFiles(webRoot).flatMap((file) =>
      importedPaths(readFileSync(file, 'utf8'))
        .filter((specifier) =>
          /(?:^|\/)(?:packages\/backend|backend\/src\/database)(?:\/|$)/.test(
            specifier.replaceAll('\\', '/'),
          ),
        )
        .map((specifier) => `${path.relative(root, file)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it('keeps cross-domain imports within the reviewed dependency allowlist', () => {
    const violations = [...domainDependencies(sourceFiles(modulesRoot))].flatMap(
      ([source, targets]) =>
        [...targets]
          .filter((target) => !allowedDomainDependencies[source]?.includes(target))
          .map((target) => `${source} -> ${target}`),
    );

    expect(violations).toEqual([]);
  });

  it('documents exported functions, service classes and public class methods', () => {
    expect(
      exportedApiDocumentationGaps([...sourceFiles(modulesRoot), ...sourceFiles(securityRoot)]),
    ).toEqual([]);
  });

  it('keeps backend domain dependencies acyclic', () => {
    expect(domainCycles(sourceFiles(modulesRoot))).toEqual([]);
  });
});
