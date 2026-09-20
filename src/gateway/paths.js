// Validates a project-relative path coming over the wire (no absolute paths, no "..").
export function safeRel(p) {
  const rel = String(p).replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) {
    throw Object.assign(new Error(`invalid path: ${p}`), { status: 400 });
  }
  return rel;
}
