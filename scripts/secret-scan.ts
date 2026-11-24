#!/usr/bin/env bun
import { statSync, existsSync, readFileSync } from 'node:fs';

type Finding = {
  line: number;
  path: string;
  rule: string;
};

type Rule = {
  id: string;
  pattern: RegExp;
};

const rules: Rule[] = [
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'age-secret-key',
    pattern: /AGE-SECRET-KEY-1[0-9A-Z]{20,}/,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'discord-token',
    pattern: /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  },
  {
    id: 'openai-api-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/,
  },
];

const secretAssignment =
  /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|WEBHOOK)[A-Z0-9_]*\s*=\s*['"]?([^'"\s#]+)['"]?/;

const placeholderPattern =
  /^(?:changeme|change-me|example|fake|placeholder|redacted|test|todo|xxx+|your[-_a-z0-9]*|<[^>]+>|\$[A-Z0-9_]+|\$\{.*|\$\(.*\)|ENC\[AES256_GCM,.*)$/i;

const ignoredPathPattern =
  /(^|\/)(?:\.git|node_modules|coverage|dist|logs|data\/events\.db|data\/generated-images|data\/generated-videos)(?:\/|$)/;

const binaryExtensionPattern =
  /\.(?:db|sqlite|sqlite3|png|jpe?g|webp|gif|mp4|webm|zip|gz|tar|xz|7z|pdf|heic|safetensors|ckpt|pt|pth)$/i;

const maxBytes = 1_000_000;

const mode = process.argv.includes('--staged') ? 'staged' : 'all';

const runGit = (args: string[]): string => {
  const result = Bun.spawnSync({
    stderr: 'pipe',
    stdout: 'pipe',
    cmd: ['git', ...args],
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.toString();
};

const splitNul = (value: string): string[] => value.split('\0').filter((path) => path.length > 0);

const getPaths = (): string[] => {
  if (mode === 'staged') {
    return splitNul(runGit(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
  }

  return splitNul(runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
};

const shouldScanPath = (path: string): boolean => {
  if (ignoredPathPattern.test(path) || binaryExtensionPattern.test(path) || !existsSync(path)) {
    return false;
  }

  const stat = statSync(path);
  return stat.isFile() && stat.size <= maxBytes;
};

const getContent = (path: string): string => {
  if (mode === 'staged') {
    const result = Bun.spawnSync({
      stderr: 'pipe',
      stdout: 'pipe',
      cmd: ['git', 'show', `:${path}`],
    });
    if (result.exitCode === 0) {
      return result.stdout.toString();
    }
  }

  return readFileSync(path, 'utf8');
};

const scanLine = ({ path, line, lineNumber }: { path: string; line: string; lineNumber: number }): Finding[] => {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(line)) {
      findings.push({ path, line: lineNumber, rule: rule.id });
    }
  }

  const assignment = secretAssignment.exec(line);
  const value = assignment?.[1];
  if (value !== undefined && value.length >= 16 && !placeholderPattern.test(value) && !line.includes('sops:')) {
    findings.push({ path, line: lineNumber, rule: 'secret-env-assignment' });
  }

  return findings;
};

const findings: Finding[] = [];
for (const path of getPaths()) {
  if (!shouldScanPath(path)) {
    continue;
  }

  const content = getContent(path);
  if (content.includes('\u0000')) {
    continue;
  }

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    findings.push(...scanLine({ path, line, lineNumber: index + 1 }));
  }
}

if (findings.length > 0) {
  console.error('Secret scan failed. Findings are redacted by design:');
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line} ${finding.rule}`);
  }
  process.exit(1);
}

console.log(`Secret scan passed (${mode}).`);
