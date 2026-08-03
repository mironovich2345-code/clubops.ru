// READ-ONLY Prisma schema parser (FULL AUDIT 2/6). Parses prisma/schema.prisma on disk — NO DB
// connection — and emits machine-readable catalogs: model-catalog.json, money-fields.json,
// status-matrix.json, relation-risks.json. Deterministic evidence for the data-model docs.
//   node scripts/audit-data-model-catalog.mjs [--json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");

// Split into model blocks.
const modelRe = /^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm;
const MONEY_HINT = /(Kopeks|amount|Amount|balance|Balance|limit|Limit|price|Price|total|Total|sum|Sum)/;
const AUDIT_FIELDS = ["createdAt", "updatedAt", "createdById", "createdByUserId"];
const models = [];
let m;
while ((m = modelRe.exec(schema))) {
  const name = m[1];
  const body = m[2];
  const lines = body.split("\n");
  const fields = [];
  const uniques = [];
  const indexes = [];
  const relations = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("@@unique")) { uniques.push(line); continue; }
    if (line.startsWith("@@index")) { indexes.push(line); continue; }
    if (line.startsWith("@@")) continue;
    const fm = line.match(/^([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?\s*(.*)$/);
    if (!fm) continue;
    const [, fname, ftype, list, opt, attrs] = fm;
    const isRelation = /@relation/.test(attrs) || /^[A-Z]/.test(ftype) && !["String", "Int", "Boolean", "DateTime", "Float", "Decimal", "Json", "BigInt", "Bytes"].includes(ftype);
    const field = { name: fname, type: ftype + (list ? "[]" : ""), nullable: !!opt, isId: /@id/.test(attrs), isUnique: /@unique/.test(attrs), hasDefault: /@default/.test(attrs) };
    if (isRelation && /@relation/.test(attrs)) {
      const onDelete = (attrs.match(/onDelete:\s*([A-Za-z]+)/) || [])[1] || "(default: Restrict for required / SetNull for optional)";
      const flds = (attrs.match(/fields:\s*\[([^\]]*)\]/) || [])[1] || "";
      relations.push({ name: fname, target: ftype, nullable: !!opt, onDelete, fields: flds });
    }
    fields.push(field);
  }
  const fieldNames = new Set(fields.map((f) => f.name));
  const moneyFields = fields.filter((f) => (MONEY_HINT.test(f.name)) && ["Int", "Decimal", "Float", "BigInt"].includes(f.type.replace("[]", ""))).map((f) => ({ field: f.name, type: f.type, nullable: f.nullable, unit: /Kopeks/.test(f.name) ? "kopeks" : "UNSUFFIXED (verify unit)" }));
  const statusField = fields.find((f) => f.name === "status");
  const statusDefault = statusField ? (body.match(/status\s+String\s+@default\("([a-z_]+)"\)/) || [])[1] || null : null;
  models.push({
    name,
    fieldCount: fields.length,
    tenant: { companyId: fieldNames.has("companyId"), clubId: fieldNames.has("clubId"), legalEntityId: fieldNames.has("legalEntityId") },
    denormalizedTenant: ["companyId", "clubId", "legalEntityId"].filter((t) => fieldNames.has(t)).length,
    money: moneyFields,
    hasStatus: !!statusField,
    statusDefault,
    hasVersion: fieldNames.has("version"),
    hasAudit: AUDIT_FIELDS.some((a) => fieldNames.has(a)),
    softDelete: fieldNames.has("isActive") || fieldNames.has("archivedAt") || fieldNames.has("cancelledAt") || fieldNames.has("deletedAt"),
    idempotencyKey: fieldNames.has("idempotencyKey"),
    uniques,
    indexCount: indexes.length,
    relations,
  });
}

// Catalogs.
const modelCatalog = { totalModels: models.length, models };
const moneyFields = [];
for (const mdl of models) for (const f of mdl.money) moneyFields.push({ model: mdl.name, ...f });
const statusMatrix = models.filter((mm) => mm.hasStatus).map((mm) => ({ model: mm.name, default: mm.statusDefault }));
const relationRisks = models.flatMap((mm) => mm.relations.map((r) => ({ model: mm.name, relation: r.name, target: r.target, nullable: r.nullable, onDelete: r.onDelete, denormalizedTenantFields: mm.denormalizedTenant })));

const outDir = join(ROOT, "docs/audits/data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "model-catalog.json"), JSON.stringify(modelCatalog, null, 2));
writeFileSync(join(outDir, "money-fields.json"), JSON.stringify({ total: moneyFields.length, unsuffixed: moneyFields.filter((f) => f.unit !== "kopeks").length, nonInteger: moneyFields.filter((f) => !f.type.startsWith("Int")).length, fields: moneyFields }, null, 2));
writeFileSync(join(outDir, "status-matrix.json"), JSON.stringify({ modelsWithStatus: statusMatrix.length, models: statusMatrix }, null, 2));
writeFileSync(join(outDir, "relation-risks.json"), JSON.stringify({ totalRelations: relationRisks.length, cascade: relationRisks.filter((r) => r.onDelete === "Cascade"), setNull: relationRisks.filter((r) => r.onDelete === "SetNull"), all: relationRisks }, null, 2));

if (!JSON_ONLY) {
  const moneyModels = models.filter((mm) => mm.money.length).length;
  const cascade = relationRisks.filter((r) => r.onDelete === "Cascade").length;
  console.log("=== Data-model catalog (read-only schema parse) ===");
  console.log(`Models: ${models.length} | with money fields: ${moneyModels} | with status: ${statusMatrix.length} | with version: ${models.filter((x) => x.hasVersion).length} | with idempotencyKey: ${models.filter((x) => x.idempotencyKey).length}`);
  console.log(`Money fields: ${moneyFields.length} (unsuffixed/verify: ${moneyFields.filter((f) => f.unit !== "kopeks").length}, non-Int: ${moneyFields.filter((f) => !f.type.startsWith("Int")).length})`);
  console.log(`Relations: ${relationRisks.length} | onDelete Cascade: ${cascade} | SetNull: ${relationRisks.filter((r) => r.onDelete === "SetNull").length}`);
  console.log(`Models scoped: companyId ${models.filter((x) => x.tenant.companyId).length} | clubId ${models.filter((x) => x.tenant.clubId).length} | legalEntityId ${models.filter((x) => x.tenant.legalEntityId).length}`);
  console.log(`Cascade relations (financial-history risk to verify):`);
  for (const r of relationRisks.filter((x) => x.onDelete === "Cascade")) console.log(`  ${r.model}.${r.relation} → ${r.target}`);
  console.log(`\nWrote model-catalog.json, money-fields.json, status-matrix.json, relation-risks.json`);
}
