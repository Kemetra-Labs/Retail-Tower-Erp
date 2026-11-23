/**
 * RT-1578 — migration-shape test for `0072_create_availability_cache`: additive (two new tables, ships empty),
 * band-checked, one state row at most, and the scope/rollback notes are present.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  cloneMigratedDb,
  initMigratedDbTemplate,
} from '../../db/__tests__/__helpers__/migrated-db.js';

const MIGRATION = '0072_create_availability_cache';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

beforeAll(async () => {
  await initMigratedDbTemplate();
});

describe('0072_create_availability_cache', () => {
  it('has a unique number that sorts after 0071', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0072_'));
    expect(names).toEqual([`${MIGRATION}.sql`]);
  });

  it('creates exactly the two cache tables, empty, and alters nothing else', () => {
    expect(SQL_TEXT.match(/CREATE TABLE/g)).toHaveLength(2);
    const statements = SQL_TEXT.split(/\r?\n/u)
      .filter((line) => !line.startsWith('--'))
      .join(' ');
    expect(statements).not.toMatch(/ALTER TABLE|DROP TABLE|INSERT INTO|UPDATE |DELETE FROM/);
    const db = cloneMigratedDb();
    for (const table of ['availability_state', 'availability_item']) {
      const rows = db.exec(`SELECT COUNT(*) FROM ${table}`);
      expect(rows[0]?.values[0]?.[0]).toBe(0);
    }
    db.close();
  });

  it('accepts only the three bands and one state row', () => {
    const db = cloneMigratedDb();
    db.run("INSERT INTO availability_item VALUES ('p', 'low', '1')");
    expect(() => db.run("INSERT INTO availability_item VALUES ('q', 'green', '1')")).toThrow();
    db.run("INSERT INTO availability_state VALUES (1, 's', 'a', 'b')");
    expect(() => db.run("INSERT INTO availability_state VALUES (2, 's', 'a', 'b')")).toThrow();
    db.close();
  });

  it('records its authority, scope rule and rollback', () => {
    expect(SQL_TEXT).toContain('RT-1578');
    expect(SQL_TEXT).toContain('scope_key');
    expect(SQL_TEXT).toContain('Rollback');
  });
});
