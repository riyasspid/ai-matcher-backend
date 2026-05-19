import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('saved-products')
export class SavedProductsController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  async saveProduct(
    @Body() body: { product_id: string },
    @Headers('x-user-id') userIdHeader?: string,
  ) {
    const { product_id } = body;
    const user_id = userIdHeader || '00000000-0000-0000-0000-000000000000'; // Mock standard user fallback

    // Validate product existence
    const productCheck = await this.db.query(
      'SELECT title FROM products WHERE id = $1',
      [product_id],
    );
    if (productCheck.rows.length === 0) {
      throw new NotFoundException('Product not found');
    }

    try {
      const result = await this.db.query(
        `INSERT INTO saved_products (user_id, product_id)
         VALUES ($1, $2)
         RETURNING id, product_id`,
        [user_id, product_id],
      );

      return {
        id: result.rows[0].id,
        product_id: result.rows[0].product_id,
        title: productCheck.rows[0].title,
      };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to save product: ${error.message}`);
    }
  }

  @Get()
  async getSavedProducts(@Headers('x-user-id') userIdHeader?: string) {
    const user_id = userIdHeader || '00000000-0000-0000-0000-000000000000';
    try {
      const result = await this.db.query(
        `SELECT sp.id, p.id AS product_id, p.title, p.price, p.featured_image_url AS image_url
         FROM saved_products sp
         JOIN products p ON sp.product_id = p.id
         WHERE sp.user_id = $1`,
        [user_id],
      );
      
      // Ensure number formatting for prices in JSON matches original
      return result.rows.map((row) => ({
        id: row.id,
        product_id: row.product_id,
        title: row.title,
        price: row.price !== null ? parseFloat(row.price) : null,
        image_url: row.image_url,
      }));
    } catch (error) {
      throw new InternalServerErrorException(`Failed to retrieve saved products: ${error.message}`);
    }
  }

  @Delete(':id')
  async deleteSavedProduct(@Param('id') id: string) {
    try {
      const result = await this.db.query(
        'DELETE FROM saved_products WHERE id = $1',
        [id],
      );
      if (result.rowCount === 0) {
        throw new NotFoundException('Saved product not found');
      }
      return { message: 'Successfully removed saved product' };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to remove saved product: ${error.message}`);
    }
  }
}
