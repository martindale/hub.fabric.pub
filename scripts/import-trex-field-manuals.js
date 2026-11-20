#!/usr/bin/env node
'use strict';

/**
 * Mirror the Markdown edition of the T.REX ARMS Field Manual Vault
 * (https://www.trex-arms.com/field-manual-vault/download) to a local store,
 * then publish each manual to a Hub as a `text/markdown` Document.
 *
 *   node scripts/import-trex-field-manuals.js [all | download | extract | publish | status]
 *     --store <dir>          local store (default stores/trex-field-manuals)
 *     --release <YYYY-MM>    vault release (default 2026-11)
 *     --hub <origin>         Hub HTTP origin (default http://127.0.0.1:8080)
 *     --token-file <path>    admin token (default ~/.fabric/hub-admin-token; optional on loopback)
 *     --limit <n>            only publish the first n manuals (testing)
 *     --keep-zips            keep the downloaded and inner zips after extraction
 *     --no-publish-list      create documents without listing them in the Hub catalog
 *
 * Release files come from files.trex-arms.com/vault/<release>/ (no site scraping):
 *   index.csv                    one row per publication, incl. md_path and sha256_md
 *   SHA256SUMS                   sha256 of index.csv and of every MD/<category>/<group>.zip
 *   FieldManualVault_MD_<r>.zip  every publication as Markdown (zips of zips)
 *
 * Every step is resumable and idempotent; rerun after an interruption.
 *   download  index.csv + SHA256SUMS + the MD zip, each via a `.part` file resumed
 *             with HTTP Range and checked against Content-Length.
 *   extract   checks index.csv and each inner zip against SHA256SUMS, unpacks the
 *             .md files to <store>/md/<category>/<group>/, and keeps only those
 *             whose sha256 matches a row's sha256_md (recorded in manifest.json).
 *   publish   CreateDocument (sha256 = document id) + PublishDocument over
 *             POST /services/rpc. Files over the Hub's 8 MiB limit are skipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FILES = 'https://files.trex-arms.com/vault';
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // services/hub.js MAX_DOCUMENT_BYTES
const UA = 'FabricHub-FieldManualMirror/2.0 (+https://github.com/FabricLabs/hub.fabric.pub)';

function parseArgs (argv) {
  const o = {
    command: 'all',
    store: path.resolve('stores/trex-field-manuals'),
    release: '2026-11',
    hub: 'http://127.0.0.1:8080',
    tokenFile: path.join(os.homedir(), '.fabric', 'hub-admin-token'),
    limit: Infinity,
    keepZips: false,
    publishList: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--store') o.store = path.resolve(next());
    else if (a === '--release') o.release = next();
    else if (a === '--hub') o.hub = next().replace(/\/$/, '');
    else if (a === '--token-file') o.tokenFile = path.resolve(next());
    else if (a === '--limit') o.limit = Math.max(1, Number(next()) || 1);
    else if (a === '--keep-zips') o.keepZips = true;
    else if (a === '--no-publish-list') o.publishList = false;
    else if (a === '--help' || a === '-h') o.command = 'help';
    else if (!a.startsWith('--')) o.command = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (!/^\d{4}-\d{2}$/.test(o.release)) throw new Error('--release must look like 2026-11');
  o.releaseDir = path.join(o.store, 'release', o.release);
  o.mdDir = path.join(o.store, 'md');
  o.zipName = `FieldManualVault_MD_${o.release}.zip`;
  return o;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function withRetry (label, fn, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err && err.permanent) break;
      const wait = Math.min(60000, 1000 * 2 ** i) + Math.floor(Math.random() * 500);
      console.warn(`[TREX] ${label}: ${err.message} (retry in ${wait}ms)`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function httpError (res, url) {
  const err = new Error(`HTTP ${res.status} for ${url}`);
  err.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  return err;
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function run (cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------- download

async function downloadFile (url, dest) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return withRetry(`download ${url}`, async () => {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const headers = { 'user-agent': UA };
    if (have > 0) headers.range = `bytes=${have}-`;
    const res = await fetch(url, { headers });
    if (res.status === 416) {
      fs.rmSync(part, { force: true });
      throw new Error('range not satisfiable; restarting');
    }
    if (!res.ok) throw httpError(res, url);
    const resumed = res.status === 206;
    let expected = Number(res.headers.get('content-length')) || 0;
    if (resumed) {
      const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
      expected = m ? Number(m[1]) : (expected ? have + expected : 0);
    }
    const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    let last = Date.now();
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (expected > 50e6 && Date.now() - last > 10000) {
          last = Date.now();
          console.log(`[TREX] ${path.basename(dest)} ${(out.bytesWritten + (resumed ? have : 0)) / 1e6 | 0}/${expected / 1e6 | 0} MB`);
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    const size = fs.statSync(part).size;
    if (expected && size !== expected) throw new Error(`short read ${size}/${expected}`);
    if (!size) throw new Error('empty file');
    fs.renameSync(part, dest);
    return size;
  });
}

async function download (o, manifest) {
  for (const name of ['SHA256SUMS', 'index.csv']) {
    await downloadFile(`${FILES}/${o.release}/${name}`, path.join(o.releaseDir, name));
  }
  const sums = readSums(o);
  const indexSum = sums.get('index.csv');
  if (indexSum && indexSum !== await sha256File(path.join(o.releaseDir, 'index.csv'))) {
    fs.rmSync(path.join(o.releaseDir, 'index.csv'));
    throw new Error('index.csv does not match SHA256SUMS (deleted; rerun)');
  }
  if (manifest.release === o.release && manifest.extracted) {
    console.log('[TREX] release already extracted; skipping the MD zip');
    return;
  }
  const zip = path.join(o.releaseDir, o.zipName);
  if (!fs.existsSync(zip)) await downloadFile(`${FILES}/${o.release}/${o.zipName}`, zip);
  console.log(`[TREX] ${o.zipName}: ${(fs.statSync(zip).size / 1e6).toFixed(0)} MB`);
}

// ---------------------------------------------------------------- extract

function readSums (o) {
  const map = new Map();
  const text = fs.readFileSync(path.join(o.releaseDir, 'SHA256SUMS'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function parseCsv (text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] || ''])));
}

function decodeEntities (s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function readIndex (o) {
  return parseCsv(fs.readFileSync(path.join(o.releaseDir, 'index.csv'), 'utf8'));
}

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function inside (root, p) {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function extract (o, manifest) {
  if (manifest.release === o.release && manifest.extracted) {
    console.log('[TREX] already extracted');
    return;
  }
  const zip = path.join(o.releaseDir, o.zipName);
  if (!fs.existsSync(zip)) throw new Error(`${zip} missing; run download first`);
  const sums = readSums(o);
  const bySha = new Map();
  for (const row of readIndex(o)) if (row.sha256_md) bySha.set(row.sha256_md.toLowerCase(), row);

  // Outer zip → inner MD/<category>/<group>.zip files.
  const outer = path.join(o.releaseDir, 'outer');
  fs.rmSync(outer, { recursive: true, force: true });
  fs.mkdirSync(outer, { recursive: true });
  console.log('[TREX] unpacking outer zip');
  await run('unzip', ['-q', '-o', zip, '-d', outer]);

  const inner = walk(outer).filter((f) => f.endsWith('.zip'));
  if (!inner.length) throw new Error('no inner zips in the MD archive');
  const files = {};
  let bad = 0;
  for (const z of inner) {
    if (!inside(outer, z)) throw new Error(`refusing path outside the archive: ${z}`);
    const rel = path.relative(outer, z).split(path.sep).join('/');
    const key = rel.slice(rel.indexOf('MD/'));
    const want = sums.get(key);
    const got = await sha256File(z);
    if (!want) console.warn(`[TREX] ${key} not in SHA256SUMS`);
    else if (want !== got) throw new Error(`${key} does not match SHA256SUMS`);

    const group = key.replace(/^MD\//, '').replace(/\.zip$/, '');
    const dest = path.join(o.mdDir, group);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await run('unzip', ['-q', '-o', z, '-d', dest]);
    for (const f of walk(dest)) {
      if (!inside(o.mdDir, f) || !f.endsWith('.md')) { fs.rmSync(f, { force: true }); continue; }
      const sha = await sha256File(f);
      const row = bySha.get(sha);
      if (!row) { bad++; console.warn(`[TREX] not in index.csv (kept, unpublished): ${path.relative(o.mdDir, f)}`); continue; }
      files[row.id] = {
        id: row.id,
        designation: decodeEntities(row.designation),
        title: decodeEntities(row.title),
        editionDate: row.edition_date,
        branch: row.branch,
        family: row.family,
        path: path.relative(o.store, f),
        size: fs.statSync(f).size,
        sha256: sha
      };
    }
    console.log(`[TREX] ${group}: ${Object.keys(files).length} manuals so far`);
  }

  // Keep publish state for manuals already sent to the Hub.
  for (const [id, e] of Object.entries(files)) {
    const prev = manifest.files && manifest.files[id];
    if (prev && prev.sha256 === e.sha256) Object.assign(e, { documentId: prev.documentId, published: prev.published, listed: prev.listed });
  }
  manifest.release = o.release;
  manifest.files = files;
  manifest.extracted = new Date().toISOString();
  saveManifest(o, manifest, true);

  fs.rmSync(outer, { recursive: true, force: true });
  if (!o.keepZips) fs.rmSync(zip, { force: true });
  const missing = [...bySha.values()].filter((r) => !files[r.id]).length;
  console.log(`[TREX] extract: ${Object.keys(files).length} manuals verified, ${missing} index rows without a file, ${bad} unmatched files`);
}

// ---------------------------------------------------------------- publish

let manifestTimer = null;
function saveManifest (o, manifest, now = false) {
  const file = path.join(o.store, 'manifest.json');
  if (now) {
    clearTimeout(manifestTimer);
    manifestTimer = null;
    return writeJson(file, manifest);
  }
  if (!manifestTimer) manifestTimer = setTimeout(() => { manifestTimer = null; writeJson(file, manifest); }, 2000);
}

async function rpc (o, method, params) {
  return withRetry(`RPC ${method}`, async () => {
    const res = await fetch(`${o.hub}/services/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
    });
    if (!res.ok) throw httpError(res, `${o.hub}/services/rpc`);
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message || JSON.stringify(body.error)), { permanent: true });
    const result = body.result;
    if (result && result.status === 'error') throw Object.assign(new Error(result.message), { permanent: true });
    return result;
  }, 4);
}

function documentName (e) {
  const year = /^\d{4}/.test(e.editionDate || '') ? ` (${e.editionDate.slice(0, 4)})` : '';
  const name = `${e.designation} ${e.title}`.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180);
  return `${name}${year}.md`;
}

async function publish (o, manifest) {
  if (!manifest.extracted) throw new Error('nothing extracted yet; run download and extract first');
  let token = null;
  try { token = fs.readFileSync(o.tokenFile, 'utf8').trim() || null; } catch (_) {}
  if (!token) console.warn(`[TREX] no admin token at ${o.tokenFile}; relying on the Hub allowing free listings`);
  await rpc(o, 'GetSetupStatus', []).catch((err) => {
    throw new Error(`Hub not reachable at ${o.hub}: ${err.message}`);
  });

  const entries = Object.values(manifest.files).slice(0, o.limit);
  let published = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of entries) {
    if (e.published && e.documentId === e.sha256 && (e.listed || !o.publishList)) { published++; continue; }
    if (e.size > MAX_DOCUMENT_BYTES) { e.tooLarge = true; skipped++; continue; }
    try {
      const buf = fs.readFileSync(path.join(o.store, e.path));
      const created = await rpc(o, 'CreateDocument', [{
        name: documentName(e),
        mime: 'text/markdown',
        contentBase64: buf.toString('base64'),
        sha256: e.sha256,
        adminToken: token || undefined
      }]);
      const id = created && created.document && created.document.id;
      if (id !== e.sha256) throw new Error(`Hub returned id ${id}, expected ${e.sha256}`);
      e.documentId = id;
      e.published = true;
      if (o.publishList) {
        await rpc(o, 'PublishDocument', [{ id, adminToken: token || undefined }]);
        e.listed = true;
      }
      delete e.publishError;
      published++;
      if (published % 100 === 0) console.log(`[TREX] published ${published}/${entries.length}`);
    } catch (err) {
      failed++;
      e.publishError = err.message;
      console.error(`[TREX] publish ${e.id}: ${err.message}`);
    }
    saveManifest(o, manifest);
  }
  saveManifest(o, manifest, true);
  console.log(`[TREX] publish: ${published} on the Hub, ${skipped} over 8 MiB, ${failed} failed`);
}

// ---------------------------------------------------------------- misc

function status (o) {
  const manifest = readJson(path.join(o.store, 'manifest.json'), { files: {} });
  const files = Object.values(manifest.files || {});
  const count = (f) => files.filter(f).length;
  console.log(JSON.stringify({
    store: o.store,
    release: manifest.release || null,
    extracted: manifest.extracted || null,
    manuals: files.length,
    bytes: files.reduce((s, e) => s + (e.size || 0), 0),
    published: count((e) => e.published),
    listed: count((e) => e.listed),
    tooLarge: count((e) => e.tooLarge),
    publishErrors: count((e) => e.publishError)
  }, null, 2));
}

async function main () {
  const o = parseArgs(process.argv.slice(2));
  if (o.command === 'help' || !['all', 'download', 'extract', 'publish', 'status'].includes(o.command)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  fs.mkdirSync(o.store, { recursive: true });
  if (o.command === 'status') return status(o);
  const manifest = readJson(path.join(o.store, 'manifest.json'), { files: {} });
  if (manifest.release && manifest.release !== o.release) manifest.extracted = null;
  if (o.command === 'all' || o.command === 'download') await download(o, manifest);
  if (o.command === 'all' || o.command === 'extract') await extract(o, manifest);
  if (o.command === 'all' || o.command === 'publish') await publish(o, manifest);
}

main().catch((err) => {
  console.error('[TREX] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
