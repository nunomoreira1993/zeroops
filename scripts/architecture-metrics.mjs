import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const modulesRoot = path.join(root, 'packages/backend/src/modules');
const securityRoot = path.join(root, 'packages/backend/src/security');

function sourceFiles(directory, includeTests = false) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) return sourceFiles(file, includeTests);
    const isTypeScript = /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
    const isTest = /\.test\.tsx?$/.test(file);
    return isTypeScript && (includeTests || !isTest) ? [file] : [];
  });
}

function lineCount(source) {
  const lines = source.split(/\r?\n/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function hasModifier(node, kind) {
  return (
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)
  );
}

function measurePublicApi(files) {
  const result = {
    publicOperations: 0,
    documentedOperations: 0,
    exportedClasses: 0,
    documentedExportedClasses: 0,
    undocumented: [],
  };

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const document = (node, name) => {
      result.publicOperations++;
      if (node.jsDoc?.length) {
        result.documentedOperations++;
      } else {
        result.undocumented.push(
          `${path.relative(root, file)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1} ${name}`,
        );
      }
    };

    for (const statement of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        document(statement, `function ${statement.name?.text ?? '<anonymous>'}`);
      }
      if (
        !ts.isClassDeclaration(statement) ||
        !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }

      result.exportedClasses++;
      if (statement.jsDoc?.length) result.documentedExportedClasses++;
      document(statement, `class ${statement.name?.text ?? '<anonymous>'}`);

      for (const member of statement.members) {
        const isPublicMethod =
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member);
        const isPrivate =
          hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
          hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
        if (isPublicMethod && !isPrivate) {
          document(member, `${statement.name?.text}.${member.name.getText(sourceFile)}`);
        }
      }
    }
  }

  return result;
}

const applicationRoots = ['apps', 'packages'];
const productionFiles = applicationRoots.flatMap((directory) =>
  sourceFiles(path.join(root, directory)),
);
const filesByWorkspace = {};
for (const directory of applicationRoots) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = `${directory}/${entry.name}`;
    filesByWorkspace[name] = productionFiles.filter((file) =>
      file.startsWith(path.join(root, name) + path.sep),
    ).length;
  }
}

const domainNames = readdirSync(modulesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const domains = Object.fromEntries(
  domainNames.map((domain) => {
    const directory = path.join(modulesRoot, domain);
    const files = sourceFiles(directory);
    const tests = sourceFiles(directory, true).filter((file) => /\.test\.tsx?$/.test(file));
    const api = measurePublicApi(files);
    return [
      domain,
      {
        productionFiles: files.length,
        productionLines: files.reduce(
          (total, file) => total + lineCount(readFileSync(file, 'utf8')),
          0,
        ),
        colocatedUnitTestFiles: tests.length,
        publicOperations: api.publicOperations,
        documentedOperations: api.documentedOperations,
      },
    ];
  }),
);
const backendFiles = domainNames.flatMap((domain) => sourceFiles(path.join(modulesRoot, domain)));
const securityFiles = sourceFiles(securityRoot);
const api = measurePublicApi([...backendFiles, ...securityFiles]);
const domainUnitTestFiles = domainNames.flatMap((domain) =>
  sourceFiles(path.join(modulesRoot, domain), true).filter((file) => /\.test\.tsx?$/.test(file)),
).length;
const priorityServices = [
  'identity/account.service.ts',
  'identity/account-mfa.service.ts',
  'identity/account-invitations.service.ts',
  'tickets/tickets.service.ts',
  'tickets/tickets.read.service.ts',
  'workflow/workflow.service.ts',
  'workflow/domain/ticket-transition.ts',
];
const priorityServiceLines = Object.fromEntries(
  priorityServices.map((file) => {
    const absolutePath = path.join(modulesRoot, file);
    return [`packages/backend/src/modules/${file}`, lineCount(readFileSync(absolutePath, 'utf8'))];
  }),
);

console.log(
  JSON.stringify(
    {
      snapshot: new Date().toISOString().slice(0, 10),
      productionTypeScriptFiles: productionFiles.length,
      productionFilesByWorkspace: filesByWorkspace,
      backendDomains: domainNames.length,
      backendDomainProductionFiles: backendFiles.length,
      backendDomainProductionLines: backendFiles.reduce(
        (total, file) => total + lineCount(readFileSync(file, 'utf8')),
        0,
      ),
      backendDomainUnitTestFiles: domainUnitTestFiles,
      publicDocumentableOperationsIncludingSharedSecurity: api.publicOperations,
      documentedPublicOperationsIncludingSharedSecurity: api.documentedOperations,
      undocumentedPublicOperations: api.undocumented.length,
      exportedClassesIncludingSharedSecurity: api.exportedClasses,
      documentedExportedClassesIncludingSharedSecurity: api.documentedExportedClasses,
      priorityServiceLines,
      domains,
      documentationGaps: api.undocumented,
    },
    null,
    2,
  ),
);
