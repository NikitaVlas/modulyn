import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { parseEnvironment } from '../config/environment.js';

/** Phase 1 connectivity only. Business repositories and Prisma belong to Phase 2. */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool = new Pool({ connectionString: parseEnvironment(process.env).databaseUrl, max: 2, connectionTimeoutMillis: 2000, query_timeout: 2000, idleTimeoutMillis: 10000 });
  constructor() { this.pool.on('error', () => { /* Readiness reports failure without logging credentials. */ }); }
  async ping(): Promise<void> { await this.pool.query('SELECT 1'); }
  async onApplicationShutdown(): Promise<void> { await this.pool.end(); }
}
