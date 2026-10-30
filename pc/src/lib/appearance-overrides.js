/** Pure built-in video merging, restoration and device quality input helpers. */
export function mergeVideoOverrides(families, overrides, sourceUrl, revisions = {}) {
  const merged = families.map(item => ({ ...item }));
  for (const [family, videoPath] of Object.entries(overrides)) {
    const index = merged.findIndex(item => item.family === family);
    const revision = revisions[family] || "";
    const src = sourceUrl(videoPath);
    const videoSrc = src && revision ? `${src}${src.includes("?") ? "&" : "?"}revision=${encodeURIComponent(revision)}` : src;
    const item = { ...(merged[index] || { family }), ok: true, videoPath, videoSrc, videoRevision: revision, videoOverride: true, taskId: `builtin-override-${family}` };
    if (index < 0) merged.push(item); else merged[index] = item;
  }
  return merged;
}
export function removeVideoOverrides(overrides, family) {
  if (!family) return {};
  const next = { ...overrides };
  delete next[family];
  return next;
}
export function parseBitrateSettings(values) {
  const result = {};
  for (const [family, raw] of Object.entries(values)) {
    if (String(raw).trim() === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error(`${family} 的码率须为 1 到 10000 的整数。`);
    result[family] = value;
  }
  return result;
}

export function createAppearanceOperationGate() {
  let active = false;
  return { begin() { if (active) return false; active = true; return true; }, end() { active = false; } };
}
