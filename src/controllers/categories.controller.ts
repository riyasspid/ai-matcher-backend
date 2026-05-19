import { Controller, Get, InternalServerErrorException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async getCategories() {
    try {
      const result = await this.db.query(
        'SELECT id, name, description, created_at FROM categories ORDER BY name ASC'
      );
      return result.rows;
    } catch (error) {
      throw new InternalServerErrorException(`Failed to fetch categories: ${error.message}`);
    }
  }
}
