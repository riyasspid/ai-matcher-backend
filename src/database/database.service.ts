import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    let connectionString = this.configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new Error('DATABASE_URL is not defined in the environment variables.');
    }

    // Adapt Python +asyncpg schema if present
    if (connectionString.startsWith('postgresql+asyncpg://')) {
      connectionString = connectionString.replace('postgresql+asyncpg://', 'postgresql://');
    }

    this.logger.log('Initializing PostgreSQL Connection Pool...');
    const isSupabase = connectionString.includes('supabase.co') || connectionString.includes('supabase.com');

    this.pool = new Pool({
      connectionString,
      ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected error on idle database client', err);
    });

    // Run the seeding logic asynchronously as soon as pool is initialized
    this.seedDatabase().catch((err) => {
      this.logger.error('Failed to run database seeding:', err);
    });
  }

  private async seedDatabase() {
    // Ensure schema has avatar_url column in users table
    try {
      await this.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT');
    } catch (e) {
      this.logger.warn(`Could not add avatar_url column to users table: ${e.message}`);
    }

    // 1. Seed categories
    try {
      const check = await this.query('SELECT COUNT(*) FROM categories');
      const count = parseInt(check.rows[0].count, 10);
      if (count === 0) {
        this.logger.log('Seeding default categories into the database...');
        const defaultCategories = [
          ['Sofa', 'Sofas and couches'],
          ['Chair', 'Chairs and seating'],
          ['Table', 'Tables and desks'],
          ['Bed', 'Beds and bedroom furniture'],
          ['Storage', 'Storage and cabinets'],
        ];

        for (const [name, desc] of defaultCategories) {
          await this.query(
            'INSERT INTO categories (name, description) VALUES ($1, $2)',
            [name, desc],
          );
        }
        this.logger.log('Default categories successfully seeded.');
      }
    } catch (error) {
      this.logger.warn(`Could not seed categories: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down PostgreSQL Connection Pool...');
    if (this.pool) {
      await this.pool.end();
    }
  }

  async query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const res = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;
      this.logger.debug(`Query executed: ${text} [${duration}ms]`);
      return res;
    } catch (error) {
      this.logger.error(`Query failed: ${text}`, error);
      throw error;
    }
  }

  async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
