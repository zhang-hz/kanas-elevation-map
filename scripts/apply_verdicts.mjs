// Merge QA verdicts (batch + independent confirm) into the build blacklist.
// Reads: data/research/link_review.json (PRE-REBUILD evidence, by id),
//        data/research/verdicts_batch1..4.json, data/research/verdicts_confirm.json
// Writes: data/research/link_blacklist.json (geometry of final drops, for process.py)
//         data/research/verdicts_merged.json (audit trail)
import fs from "node:fs";

const ROOT = "C:/Data/Code/Kanas/data/research";

const review = JSON.parse(fs.readFileSync(`${ROOT}/link_review.json`, "utf8"));
const byId = new Map(review.map((r) => [r.id, r]));

const base = new Map();
for (const f of ["verdicts_batch1a", "verdicts_batch1b", "verdicts_batch2", "verdicts_batch3", "verdicts_batch4"]) {
  const arr = JSON.parse(fs.readFileSync(`${ROOT}/${f}.json`, "utf8"));
  for (const v of arr) {
    if (base.has(v.id)) console.log(`WARN duplicate verdict for ${v.id}`);
    base.set(v.id, v);
  }
}

const confirm = new Map();
let confirmRaw = [];
try {
  confirmRaw = JSON.parse(fs.readFileSync(`${ROOT}/verdicts_confirm.json`, "utf8"));
  for (const c of confirmRaw) confirm.set(c.id, c);
} catch {
  console.log("WARN: verdicts_confirm.json missing — using batch verdicts only");
}

const merged = [];
for (const [id, v] of [...base.entries()].sort((a, b) => a[0] - b[0])) {
  const c = confirm.get(id);
  let verdict = v.verdict;
  let confirmed = null;
  let note = "";
  if (c) {
    confirmed = !!c.confirmed;
    if (c.confirmed === false && c.corrected) {
      verdict = c.corrected;
      note = c.note || "";
    }
  }
  const r = byId.get(id);
  merged.push({
    id,
    verdict,
    confirmed,
    reason: v.reason,
    confirmNote: note,
    x0: r ? r.p0.x : null, y0: r ? r.p0.y : null,
    x1: r ? r.p1.x : null, y1: r ? r.p1.y : null,
    cls: r ? r.cls : null, tier: r ? r.tier : null, lenM: r ? r.lenM : null,
  });
}

const drops = merged.filter((m) => m.verdict === "drop");
const uncertain = merged.filter((m) => m.verdict === "uncertain");
const keeps = merged.filter((m) => m.verdict === "keep");

const blacklist = drops
  .filter((d) => d.x0 !== null)
  .map((d) => ({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, id: d.id, reason: d.reason }));

fs.writeFileSync(`${ROOT}/link_blacklist.json`, JSON.stringify(blacklist, null, 1));
fs.writeFileSync(`${ROOT}/verdicts_merged.json`, JSON.stringify(merged, null, 1));

console.log(`verdicts: keep ${keeps.length}, drop ${drops.length}, uncertain ${uncertain.length}`);
console.log(`blacklist entries: ${blacklist.length}`);
for (const d of drops) console.log(`  DROP ${d.id} ${d.cls} ${d.lenM}m  ${d.reason}`);
for (const u of uncertain) console.log(`  UNCERTAIN ${u.id} ${u.cls} ${u.lenM}m  ${u.reason}`);
const over = confirmRaw.filter((c) => c.confirmed === false);
for (const o of over) console.log(`  OVERRULED ${o.id} -> ${o.corrected}: ${o.note}`);
