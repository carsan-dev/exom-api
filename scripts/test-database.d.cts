import type { Pool } from 'pg';
export function databaseUrl(): string;
export function verifyDatabase(): Promise<void>;
export function assertTestDatabase(pool: Pool): Promise<void>;
