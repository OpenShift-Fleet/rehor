/**
 * Validate TypeScript test fixtures against OpenAPI component schemas.
 *
 * If the backend response shape changes and the OpenAPI spec is updated,
 * these tests fail until the TS fixtures match — preventing drift between
 * the Python backend and the React dashboard.
 */

import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures.json';

const thisDir = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(thisDir, '../../../shared/openapi.yaml');
const spec = parse(readFileSync(specPath, 'utf8'));
const schemas = spec.components.schemas as Record<string, any>;

function resolveRefs(schema: any, allSchemas: Record<string, any>): any {
  if (Array.isArray(schema)) return schema.map((item) => resolveRefs(item, allSchemas));
  if (typeof schema !== 'object' || schema === null) return schema;
  if ('$ref' in schema) {
    const refName = (schema.$ref as string).split('/').pop()!;
    return resolveRefs(allSchemas[refName], allSchemas);
  }
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'nullable' && v === true) continue;
    result[k] = resolveRefs(v, allSchemas);
  }
  if (schema.nullable === true) {
    if ('type' in result) {
      result.type = [result.type, 'null'];
    } else if ('allOf' in result) {
      result.oneOf = [...result.allOf, { type: 'null' }];
      delete result.allOf;
    }
  }
  return result;
}

const ajv = new Ajv({ allErrors: true });

function compileSchema(name: string) {
  const resolved = resolveRefs(schemas[name], schemas);
  return ajv.compile(resolved);
}

const validateTask = compileSchema('TaskItem');
const validateMemory = compileSchema('MemoryItem');
const validateCycleRun = compileSchema('CycleRunItem');
const validateCycleEntry = compileSchema('CycleEntryItem');
const validatePaginated = compileSchema('PaginatedResponse');
const validateCostsResponse = compileSchema('CostsResponse');

function expectValid(validate: ReturnType<typeof ajv.compile>, data: unknown, label: string) {
  const valid = validate(data);
  if (!valid) {
    const errors = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
    expect.fail(`${label}: ${errors}`);
  }
}

describe('Task item schema conformance', () => {
  it.each(Object.entries(fixtures.tasks))('task %s matches schema', (key, task) => {
    expectValid(validateTask, task, `task ${key}`);
  });

  it('task has jira_key matching external_key', () => {
    const task = fixtures.tasks['RHCLOUD-001'] as Record<string, unknown>;
    expect(task.jira_key).toBe(task.external_key);
  });
});

describe('Memory item schema conformance', () => {
  it.each(fixtures.memories.map((m, i) => [i, m]))('memory %i matches schema', (idx, memory) => {
    expectValid(validateMemory, memory, `memory ${idx}`);
  });
});

describe('Cycle run item schema conformance', () => {
  it.each(fixtures.cycleRuns.map((cr, i) => [i, cr]))('cycleRun %i matches schema', (idx, run) => {
    expectValid(validateCycleRun, run, `cycleRun ${idx}`);
  });
});

describe('Cycle entry (cost) item schema conformance', () => {
  it.each(fixtures.costs.map((c, i) => [i, c]))('cost %i matches schema', (idx, cost) => {
    expectValid(validateCycleEntry, cost, `cost ${idx}`);
  });
});

describe('Paginated envelope schema conformance', () => {
  it('tasks paginated envelope', () => {
    const envelope = {
      items: Object.values(fixtures.tasks),
      total: Object.keys(fixtures.tasks).length,
      limit: 20,
      offset: 0,
    };
    expectValid(validatePaginated, envelope, 'tasks envelope');
  });

  it('memories paginated envelope', () => {
    const envelope = {
      items: fixtures.memories,
      total: fixtures.memories.length,
      limit: 20,
      offset: 0,
    };
    expectValid(validatePaginated, envelope, 'memories envelope');
  });

  it('cycle runs paginated envelope', () => {
    const envelope = {
      items: fixtures.cycleRuns,
      total: fixtures.cycleRuns.length,
      limit: 50,
      offset: 0,
    };
    expectValid(validatePaginated, envelope, 'cycle runs envelope');
  });

  it('rejects extra fields in envelope', () => {
    const bad = { items: [], total: 0, limit: 20, offset: 0, extra: true };
    expect(validatePaginated(bad)).toBe(false);
  });
});

describe('Costs response schema conformance', () => {
  it('costs response with daily data', () => {
    const response = {
      items: fixtures.costs,
      daily: fixtures.dailyCosts,
    };
    expectValid(validateCostsResponse, response, 'costs response');
  });

  it('rejects paginated fields on costs', () => {
    const bad = { items: [], daily: [], total: 0, limit: 200, offset: 0 };
    expect(validateCostsResponse(bad)).toBe(false);
  });
});
