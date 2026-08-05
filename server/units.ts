import type { FieldDefinition } from "./types";

type Quantity = { source: string; value: number; unit: string; dimension: "power" | "energy" };

const QUANTITY_PATTERN = /(\d[\d,.]*(?:\.\d+)?)\s*(thousand|million|billion|万|亿)?\s*(kwh|mwh|gwh|twh|kw|mw|gw|tw|千瓦时|兆瓦时|吉瓦时|太瓦时|千瓦|兆瓦|吉瓦|太瓦)(?![A-Za-z])/giu;

function magnitudeMultiplier(value: string) {
  return ({ thousand: 1e3, million: 1e6, billion: 1e9, 万: 1e4, 亿: 1e8 } as Record<string, number>)[value.toLowerCase()] ?? 1;
}

function canonicalUnit(raw: string) {
  const unit = raw.toLowerCase();
  const aliases: Record<string, string> = {
    千瓦: "kW", 兆瓦: "MW", 吉瓦: "GW", 太瓦: "TW",
    千瓦时: "kWh", 兆瓦时: "MWh", 吉瓦时: "GWh", 太瓦时: "TWh",
  };
  return aliases[raw] ?? ({ kw: "kW", mw: "MW", gw: "GW", tw: "TW", kwh: "kWh", mwh: "MWh", gwh: "GWh", twh: "TWh" } as Record<string, string>)[unit] ?? raw;
}

export function extractQuantities(text: string): Quantity[] {
  const quantities: Quantity[] = [];
  for (const match of text.matchAll(QUANTITY_PATTERN)) {
    const unit = canonicalUnit(match[3]);
    const numeric = Number(match[1].replace(/,/g, "")) * magnitudeMultiplier(match[2] ?? "");
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    quantities.push({ source: match[0], value: numeric, unit, dimension: unit.endsWith("Wh") ? "energy" : "power" });
  }
  return quantities;
}

function convert(quantity: Quantity, targetUnit: string) {
  const factors: Record<string, number> = {
    kW: 0.001, MW: 1, GW: 1_000, TW: 1_000_000,
    kWh: 0.001, MWh: 1, GWh: 1_000, TWh: 1_000_000,
  };
  const targetFactor = factors[targetUnit];
  const sourceFactor = factors[quantity.unit];
  if (!targetFactor || !sourceFactor) return null;
  return quantity.value * sourceFactor / targetFactor;
}

function expectedDimension(unit: string) {
  return unit.endsWith("Wh") ? "energy" : "power";
}

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function implausible(fieldId: string, value: number, unit: string) {
  if (fieldId === "storage_capacity_mwh") return value > 1_000_000;
  if (unit === "MW") return value > 100_000;
  if (unit === "MWh") return value > 100_000_000;
  return false;
}

export function normalizeMeasurementFields(
  fields: Record<string, unknown>, definitions: FieldDefinition[],
  originalFields: Record<string, string>, evidence: Record<string, string>,
) {
  const normalized = { ...fields };
  const checks: Record<string, string> = {};
  const warnings: string[] = [];
  for (const field of definitions.filter((item) => item.type === "number" && item.unit)) {
    const raw = Number(normalized[field.id]);
    if (!Number.isFinite(raw) || raw <= 0) { normalized[field.id] = null; continue; }
    const sourceTexts = [originalFields[field.id], evidence[field.id]].filter(Boolean);
    const quantities = sourceTexts.flatMap(extractQuantities)
      .filter((item) => item.dimension === expectedDimension(String(field.unit)));
    if (!quantities.length) {
      normalized[field.id] = null;
      warnings.push(`${field.label.replace(/\n/g, " ")}缺少带单位的原文证据，已拒绝数值 ${raw} ${field.unit}`);
      checks[field.id] = "未通过：原文中没有可核实的单位表达";
      continue;
    }
    const quantity = quantities[0];
    const converted = convert(quantity, String(field.unit));
    if (!converted || !Number.isFinite(converted) || converted <= 0) {
      normalized[field.id] = null;
      warnings.push(`${field.label.replace(/\n/g, " ")}单位 ${quantity.unit} 无法换算为 ${field.unit}`);
      checks[field.id] = `未通过：${quantity.source} 无法换算`;
      continue;
    }
    const value = rounded(converted);
    if (implausible(field.id, value, String(field.unit))) {
      normalized[field.id] = null;
      warnings.push(`${field.label.replace(/\n/g, " ")}换算结果 ${value} ${field.unit} 超出单体项目合理范围，已拦截并要求人工复核`);
      checks[field.id] = `未通过：原文 ${quantity.source} → ${value} ${field.unit}，数量级异常`;
      continue;
    }
    normalized[field.id] = value;
    const changed = Math.abs(raw - value) / Math.max(1, Math.abs(value)) > 0.02;
    checks[field.id] = `已核实：原文 ${quantity.source} → ${value} ${field.unit}${changed ? `；修正模型值 ${raw} ${field.unit}` : ""}`;
    if (changed) warnings.push(`${field.label.replace(/\n/g, " ")}已按原文单位从 ${raw} 修正为 ${value} ${field.unit}`);
  }
  const storagePower = Number(normalized.storage_power_mw);
  const storageEnergy = Number(normalized.storage_capacity_mwh);
  if (storagePower > 0 && storageEnergy > 0) {
    const duration = storageEnergy / storagePower;
    checks.storage_duration = `交叉校验：${storageEnergy} MWh ÷ ${storagePower} MW = ${rounded(duration)} 小时`;
    if (duration < 0.05 || duration > 72) warnings.push(`储能时长 ${rounded(duration)} 小时明显异常，请复核功率/容量单位或项目口径`);
  }
  return { fields: normalized, checks, warnings };
}
