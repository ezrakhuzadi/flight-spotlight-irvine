#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const targets = [
  path.join(repoRoot, 'server.js'),
  path.join(repoRoot, 'views'),
  path.join(repoRoot, 'static')
];

const rules = [
  {
    name: 'No inline onclick attributes',
    pattern: /\bonclick="/
  },
  {
    name: 'No JS setAttribute("onclick", ...)',
    pattern: /setAttribute\(\s*['"]onclick['"]/
  },
  {
    name: 'No CSP script-src-attr unsafe-inline',
    pattern: /\bscript-src-attr\b/
  },
  {
    name: 'No raw JSON.stringify in EJS script context',
    pattern: /<%-\s*JSON\.stringify/
  }
];

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.js', '.ejs', '.html', '.css', '.md', '.txt', '.yml', '.yaml'].includes(ext);
}

function walk(entry) {
  const stat = fs.statSync(entry);
  if (stat.isFile()) {
    return [entry];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const out = [];
  for (const name of fs.readdirSync(entry)) {
    if (name === 'node_modules' || name === '.git' || name === 'data') continue;
    out.push(...walk(path.join(entry, name)));
  }
  return out;
}

function findMatches(content, pattern) {
  const matches = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      matches.push({ line: i + 1, text: lines[i] });
    }
  }
  return matches;
}

let failed = false;

for (const target of targets) {
  for (const filePath of walk(target)) {
    if (!isTextFile(filePath)) continue;
    const rel = path.relative(repoRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.warn(`[WARN] Unable to read ${rel}: ${err.message}`);
      continue;
    }

    for (const rule of rules) {
      const hits = findMatches(content, rule.pattern);
      if (!hits.length) continue;

      failed = true;
      for (const hit of hits) {
        process.stderr.write(
          `[FAIL] ${rule.name}: ${rel}:${hit.line}\n`
        );
      }
    }
  }
}

if (failed) {
  process.stderr.write('\nSecurity smoke checks failed.\n');
  process.exit(1);
}

process.stdout.write('Security smoke checks passed.\n');
