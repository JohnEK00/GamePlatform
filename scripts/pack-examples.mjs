#!/usr/bin/env node
// Packs every examples/<name>/ (containing game.json) into examples/dist/<name>.zip,
// with game.json at the zip root, validating it against docs/GAME_FORMAT.md first.
// Usage (from the repo root):  node scripts/pack-examples.mjs [name ...]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(root, 'examples');
const outDir = join(examplesDir, 'dist');

const ALLOWED = new Set(['.json', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.txt', '.wav', '.mp3', '.ogg', '.css', '.woff2', '.ttf']);
const MAX_FILES = 2000;
const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_COMPRESSED = 50 * 1024 * 1024;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue; // skip dotfiles (.DS_Store etc.)
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const ACH_ID = /^[a-z0-9_-]{1,32}$/;
const MAX_ACHIEVEMENTS = 50;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

/** game.json "achievements" (optional) — docs/GAME_FORMAT.md "v2 additions". Returns error strings. */
function validateAchievements(list, files) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['"achievements" must be an array'];
  const errs = [];
  if (list.length > MAX_ACHIEVEMENTS) errs.push(`"achievements" has ${list.length} entries (max ${MAX_ACHIEVEMENTS})`);
  const seen = new Set();
  list.forEach((a, i) => {
    const at = `achievements[${i}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return void errs.push(`${at} must be an object`);
    if (typeof a.id !== 'string' || !ACH_ID.test(a.id)) errs.push(`${at}.id must match ${ACH_ID}`);
    else if (seen.has(a.id)) errs.push(`${at}.id "${a.id}" is duplicated`);
    else seen.add(a.id);
    if (typeof a.name !== 'string' || a.name.length < 1 || a.name.length > 60) errs.push(`${at}.name must be a string of 1–60 chars`);
    if (a.description !== undefined && (typeof a.description !== 'string' || a.description.length > 200))
      errs.push(`${at}.description must be a string of at most 200 chars`);
    if (a.icon !== undefined) {
      if (typeof a.icon !== 'string' || a.icon.startsWith('/') || a.icon.split(/[\\/]/).includes('..'))
        errs.push(`${at}.icon must be a bundle-relative path`);
      else if (!IMAGE_EXT.has(extname(a.icon).toLowerCase())) errs.push(`${at}.icon "${a.icon}" is not an image`);
      else if (!files.includes(a.icon.replace(/^\.\//, ''))) errs.push(`${at}.icon "${a.icon}" not found in bundle`);
    }
  });
  return errs;
}

function validateMeta(meta, files, name) {
  const errs = [];
  if (!meta || typeof meta !== 'object') errs.push('game.json must be an object');
  if (typeof meta.name !== 'string' || !meta.name.trim()) errs.push('"name" is required');
  if (typeof meta.entry !== 'string' || !/\.js$/.test(meta.entry) || meta.entry.startsWith('/') || meta.entry.split(/[\\/]/).includes('..'))
    errs.push('"entry" must be a relative .js path');
  else if (!files.includes(meta.entry)) errs.push(`entry "${meta.entry}" not found in bundle`);
  for (const k of ['width', 'height'])
    if (!Number.isInteger(meta[k]) || meta[k] < 64 || meta[k] > 4096) errs.push(`"${k}" must be an integer 64–4096`);
  errs.push(...validateAchievements(meta.achievements, files));
  if (errs.length) throw new Error(`${name}: invalid game.json:\n  - ${errs.join('\n  - ')}`);
}

async function pack(name) {
  const dir = join(examplesDir, name);
  const files = walk(dir).map((f) => relative(dir, f).split(sep).join('/'));
  if (!files.includes('game.json')) return null;
  const meta = JSON.parse(readFileSync(join(dir, 'game.json'), 'utf8'));
  validateMeta(meta, files, name);
  if (files.length > MAX_FILES) throw new Error(`${name}: too many files (${files.length})`);

  const zip = new JSZip();
  let total = 0;
  for (const rel of files.sort()) {
    const ext = extname(rel).toLowerCase();
    if (!ALLOWED.has(ext)) {
      console.warn(`  skipping ${name}/${rel} (extension ${ext || '(none)'} not allowed)`);
      continue;
    }
    const data = readFileSync(join(dir, rel));
    total += data.length;
    zip.file(rel, data, { date: new Date('2024-01-01T00:00:00Z') });
  }
  if (total > MAX_UNCOMPRESSED) throw new Error(`${name}: bundle too large uncompressed`);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  if (buf.length > MAX_COMPRESSED) throw new Error(`${name}: zip too large`);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${name}.zip`);
  writeFileSync(out, buf);
  return { out, files: files.length, size: buf.length, title: meta.name, achievements: meta.achievements?.length ?? 0 };
}

const only = process.argv.slice(2);
const names = readdirSync(examplesDir).filter(
  (n) => n !== 'dist' && !n.startsWith('.') && statSync(join(examplesDir, n)).isDirectory() && (only.length === 0 || only.includes(n)),
);
let count = 0;
let failed = false;
for (const n of names) {
  try {
    const r = await pack(n);
    if (!r) continue;
    count++;
    console.log(`packed ${r.title.padEnd(16)} → ${relative(root, r.out).split(sep).join('/')}  (${r.files} files, ${(r.size / 1024).toFixed(1)} KB, ${r.achievements} achievements)`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${e.message}`);
  }
}
if (count === 0 && !failed) console.warn('No examples found (expected examples/<name>/game.json).');
process.exit(failed ? 1 : 0);
