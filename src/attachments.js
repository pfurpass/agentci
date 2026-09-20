import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Files the user hands to the team: pasted screenshots, specs, logs, designs.
// They live in .agentci/attachments/ inside the project, so they travel with the run
// (including to a gateway) without ever showing up as a change made by an agent.

export const ATTACH_DIR = path.join('.agentci', 'attachments');
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const TEXTISH_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.csv', '.log', '.html', '.xml',
  '.js', '.ts', '.py', '.go', '.rs', '.java', '.sql', '.sh', '.diff', '.patch']);
const DOC_EXT = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.odt']);

export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (DOC_EXT.has(ext)) return 'document';
  if (TEXTISH_EXT.has(ext)) return 'text';
  return 'file';
}

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80);
  return base || 'file';
}

export function attachmentsDir(cwd) {
  return path.join(cwd, ATTACH_DIR);
}

// Stores a buffer and returns the entry the UI and the prompts work with.
export function saveAttachment(cwd, name, buffer) {
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error(`file is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`), { status: 413 });
  }
  const dir = attachmentsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const clean = safeName(name);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${clean}`;
  fs.writeFileSync(path.join(dir, id), buffer);
  return entry(cwd, id);
}

function entry(cwd, id) {
  const rel = path.posix.join('.agentci/attachments', id);
  const stat = fs.statSync(path.join(cwd, ATTACH_DIR, id));
  return {
    id,
    name: id.replace(/^[a-z0-9]+-[0-9a-f]{6}-/, ''),
    path: rel,
    bytes: stat.size,
    kind: kindOf(id),
    addedAt: stat.mtimeMs,
  };
}

export function listAttachments(cwd) {
  const dir = attachmentsDir(cwd);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => !n.startsWith('.'))
    .map((n) => { try { return entry(cwd, n); } catch { return null; } })
    .filter(Boolean)
    // stable order even when two files land in the same millisecond
    .sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function readAttachment(cwd, id) {
  const clean = path.basename(String(id));
  const full = path.join(attachmentsDir(cwd), clean);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw Object.assign(new Error('attachment not found'), { status: 404 });
  return { buffer: fs.readFileSync(full), entry: entry(cwd, clean) };
}

export function deleteAttachment(cwd, id) {
  const clean = path.basename(String(id));
  fs.rmSync(path.join(attachmentsDir(cwd), clean), { force: true });
}

// Moves attachments along when the user switches the project folder – the draft
// in the composer should survive that.
export function copyAttachments(fromCwd, toCwd, ids = []) {
  const out = [];
  for (const id of ids) {
    const clean = path.basename(String(id));
    const src = path.join(attachmentsDir(fromCwd), clean);
    if (!fs.existsSync(src)) continue;
    const dir = attachmentsDir(toCwd);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, clean);
    if (!fs.existsSync(target)) fs.copyFileSync(src, target);
    out.push(entry(toCwd, clean));
  }
  return out;
}

// Copies a file the user passed on the command line (agentci run --attach spec.md).
export function attachFromDisk(cwd, filePath) {
  const full = path.resolve(filePath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`attachment not found: ${filePath}`);
  return saveAttachment(cwd, path.basename(full), fs.readFileSync(full));
}

// The block that goes into every agent prompt.
export function formatAttachments(list = []) {
  if (!list.length) return '';
  const lines = list.map((a) => {
    const size = a.bytes > 1024 * 1024 ? `${(a.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.bytes / 1024))} kB`;
    return `- ${a.path}  (${a.kind}, ${size}${a.note ? `, note: ${a.note}` : ''})`;
  });
  return `ATTACHMENTS the user provided for this task – read them before you start; `
    + `images are screenshots or designs, documents are specs:\n${lines.join('\n')}`;
}

export function imageAttachments(list = []) {
  return list.filter((a) => a.kind === 'image');
}
