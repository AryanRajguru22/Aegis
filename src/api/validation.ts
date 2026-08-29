import { assertValidIdentifier } from "../capability/index.js";
import type { Caveats, TransactionRequest } from "../capability/types.js";
import { ApiError } from "./errors.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, `Field "${field}" is required and must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `Field "${field}" is required and must be a positive integer`);
  }
  return value;
}

function requireStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    throw new ApiError(400, `Field "${field}" is required and must be a non-empty array of strings`);
  }
  return value;
}

export function parseCaveatsBody(body: unknown): Caveats {
  if (!isPlainObject(body)) {
    throw new ApiError(400, `"caveats" is required and must be an object`);
  }
  const caveats: Caveats = {
    maxAmountMinorUnits: requirePositiveInteger(body, "maxAmountMinorUnits"),
    currency: requireString(body, "currency"),
    categories: requireStringArray(body, "categories"),
    rails: requireStringArray(body, "rails"),
    expiresAt: requireString(body, "expiresAt"),
  };
  if (Number.isNaN(new Date(caveats.expiresAt).getTime())) {
    throw new ApiError(400, `Field "expiresAt" must be a valid ISO 8601 timestamp`);
  }
  return caveats;
}

function requireOptionalStringArray(body: Record<string, unknown>, field: string): string[] | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ApiError(400, `Field "${field}", if present, must be an array of strings`);
  }
  return value;
}

export interface CreateMissionBody {
  missionId: string;
  agentId: string;
  goal: string;
  budgetMinorUnits: number;
  currency: string;
  allowedCategories: string[] | null;
  approvedCounterparties: string[] | null;
  expiresAt: string;
}

export function parseCreateMissionBody(body: unknown): CreateMissionBody {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  const missionId = requireString(body, "missionId");
  try {
    assertValidIdentifier(missionId, "missionId");
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : String(error));
  }
  const agentId = requireString(body, "agentId");
  const goal = requireString(body, "goal");
  const budgetMinorUnits = requirePositiveInteger(body, "budgetMinorUnits");
  const currency = requireString(body, "currency");
  const allowedCategories = requireOptionalStringArray(body, "allowedCategories");
  const approvedCounterparties = requireOptionalStringArray(body, "approvedCounterparties");
  const expiresAt = requireString(body, "expiresAt");
  if (Number.isNaN(new Date(expiresAt).getTime())) {
    throw new ApiError(400, `Field "expiresAt" must be a valid ISO 8601 timestamp`);
  }
  return { missionId, agentId, goal, budgetMinorUnits, currency, allowedCategories, approvedCounterparties, expiresAt };
}

export interface CreateAgentBody {
  agentId: string;
  delegatedGoal: string;
  caveats: Caveats;
}

export function parseCreateAgentBody(body: unknown): CreateAgentBody {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  const agentId = requireString(body, "agentId");
  try {
    assertValidIdentifier(agentId, "agentId");
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : String(error));
  }
  const delegatedGoal = requireString(body, "delegatedGoal");
  const caveats = parseCaveatsBody(body["caveats"]);
  return { agentId, delegatedGoal, caveats };
}

export function parseTransactionBody(body: unknown): TransactionRequest & { purpose: string } {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  const transactionRaw = body["transaction"];
  if (!isPlainObject(transactionRaw)) {
    throw new ApiError(400, `"transaction" is required and must be an object`);
  }
  return {
    amountMinorUnits: requirePositiveInteger(transactionRaw, "amountMinorUnits"),
    currency: requireString(transactionRaw, "currency"),
    category: requireString(transactionRaw, "category"),
    rail: requireString(transactionRaw, "rail"),
    purpose: requireString(transactionRaw, "purpose"),
  };
}

/** Optional — a POST /transactions request with no "missionId" behaves exactly as it always has. */
export function parseOptionalMissionId(body: unknown): string | undefined {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  const value = body["missionId"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, `Field "missionId", if present, must be a non-empty string`);
  }
  return value;
}

export function parseCounterparty(body: unknown): string {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  return requireString(body, "counterparty");
}

/** Optional — /simulate has no counterparty concept unless a missionId is also present (see routes/transactions.ts). */
export function parseOptionalCounterparty(body: unknown): string | undefined {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  const value = body["counterparty"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, `Field "counterparty", if present, must be a non-empty string`);
  }
  return value;
}

export function parseRevokeBody(body: unknown): { reason: string } {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  return { reason: requireString(body, "reason") };
}

export function parsePrincipalBody(body: unknown): { principalId: string } {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  const principalId = requireString(body, "principalId");
  try {
    assertValidIdentifier(principalId, "principalId");
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : String(error));
  }
  return { principalId };
}
