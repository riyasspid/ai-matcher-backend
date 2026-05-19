import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  Query,
  Headers,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../services/storage.service';
import { AIService } from '../services/ai.service';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storageService: StorageService,
    private readonly aiService: AIService,
  ) {}

  private async populateProductsRelations(products: any[]): Promise<any[]> {
    if (products.length === 0) return [];

    const productIds = products.map((p) => p.id);

    // Fetch images
    const imagesResult = await this.db.query(
      'SELECT id, product_id, image_url, is_primary FROM product_images WHERE product_id = ANY($1)',
      [productIds],
    );

    // Fetch tags
    const tagsResult = await this.db.query(
      'SELECT product_id, tag FROM product_tags WHERE product_id = ANY($1)',
      [productIds],
    );

    // Group by product_id
    const imagesByProduct: Record<string, any[]> = {};
    const tagsByProduct: Record<string, string[]> = {};

    for (const img of imagesResult.rows) {
      if (!imagesByProduct[img.product_id]) {
        imagesByProduct[img.product_id] = [];
      }
      imagesByProduct[img.product_id].push({
        id: img.id,
        product_id: img.product_id,
        image_url: img.image_url,
        is_primary: img.is_primary,
        sort_order: 0,
      });
    }

    for (const t of tagsResult.rows) {
      if (!tagsByProduct[t.product_id]) {
        tagsByProduct[t.product_id] = [];
      }
      tagsByProduct[t.product_id].push(t.tag);
    }

    return products.map((p) => ({
      ...p,
      price: p.price !== null && p.price !== undefined ? parseFloat(p.price) : null,
      images: imagesByProduct[p.id] || [],
      tags: tagsByProduct[p.id] || [],
    }));
  }

  @Post()
  async createProduct(
    @Body() body: any,
    @Headers('x-user-id') userIdHeader?: string,
  ) {
    const {
      title,
      product_code,
      category_id,
      description,
      material,
      dimensions,
      color,
      brand,
      price,
      stock,
      is_available,
      featured_image_url,
    } = body;

    const created_by = userIdHeader || '00000000-0000-0000-0000-000000000000'; // Default user uuid fallback

    try {
      const result = await this.db.query(
        `INSERT INTO products (
          title, product_code, category_id, description, material,
          dimensions, color, brand, price, stock, is_available,
          featured_image_url, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          title,
          product_code,
          category_id || null,
          description || null,
          material || null,
          dimensions || null,
          color || null,
          brand || null,
          price !== undefined ? parseFloat(price) : null,
          stock !== undefined ? parseInt(stock, 10) : 0,
          is_available ?? true,
          featured_image_url || null,
          created_by,
        ],
      );

      const populated = await this.populateProductsRelations(result.rows);
      return populated[0];
    } catch (error) {
      if (error.code === '23505') {
        throw new BadRequestException('Product code must be unique.');
      }
      throw new InternalServerErrorException(`Failed to create product: ${error.message}`);
    }
  }

  @Get()
  async listProducts() {
    try {
      const result = await this.db.query(
        'SELECT * FROM products ORDER BY created_at DESC',
      );
      return await this.populateProductsRelations(result.rows);
    } catch (error) {
      throw new InternalServerErrorException(`Failed to list products: ${error.message}`);
    }
  }

  @Get(':id')
  async getProduct(@Param('id') id: string) {
    try {
      const result = await this.db.query('SELECT * FROM products WHERE id = $1', [id]);
      if (result.rows.length === 0) {
        throw new NotFoundException('Product not found');
      }
      const populated = await this.populateProductsRelations(result.rows);
      return populated[0];
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to fetch product: ${error.message}`);
    }
  }

  @Put(':id')
  async updateProduct(@Param('id') id: string, @Body() body: any) {
    const check = await this.db.query('SELECT * FROM products WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      throw new NotFoundException('Product not found');
    }

    const allowedFields = [
      'title',
      'product_code',
      'category_id',
      'description',
      'material',
      'dimensions',
      'color',
      'brand',
      'price',
      'stock',
      'is_available',
      'featured_image_url',
    ];

    const setStatements: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        setStatements.push(`${key} = $${idx}`);
        if (key === 'category_id' && !body[key]) {
          values.push(null);
        } else if (key === 'price' && body[key] !== null) {
          values.push(parseFloat(body[key]));
        } else if (key === 'stock' && body[key] !== null) {
          values.push(parseInt(body[key], 10));
        } else {
          values.push(body[key]);
        }
        idx++;
      }
    }

    if (setStatements.length === 0) {
      const populated = await this.populateProductsRelations(check.rows);
      return populated[0];
    }

    setStatements.push(`updated_at = NOW()`);
    values.push(id);

    const queryStr = `UPDATE products SET ${setStatements.join(', ')} WHERE id = $${idx} RETURNING *`;

    try {
      const result = await this.db.query(queryStr, values);
      const populated = await this.populateProductsRelations(result.rows);
      return populated[0];
    } catch (error) {
      throw new InternalServerErrorException(`Failed to update product: ${error.message}`);
    }
  }

  @Delete(':id')
  async deleteProduct(@Param('id') id: string) {
    try {
      const result = await this.db.query('DELETE FROM products WHERE id = $1', [id]);
      if (result.rowCount === 0) {
        throw new NotFoundException('Product not found');
      }
      return { message: 'Product deleted successfully' };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to delete product: ${error.message}`);
    }
  }

  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProductImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('is_primary') isPrimaryBody?: any,
    @Query('is_primary') isPrimaryStr?: string,
  ) {
    const rawVal = isPrimaryStr !== undefined ? isPrimaryStr : isPrimaryBody;
    const is_primary = rawVal === 'true' || rawVal === '1' || rawVal === true || rawVal === 1;

    const check = await this.db.query('SELECT * FROM products WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      throw new NotFoundException('Product not found');
    }

    if (!file) {
      throw new BadRequestException('No image file provided.');
    }

    try {
      // 1. Upload to Supabase Storage
      const targetBucket = is_primary
        ? this.storageService.productImageBucket
        : this.storageService.productGalleryBucket;

      const imageUrl = await this.storageService.uploadImage(
        file.buffer,
        file.originalname || 'image.jpg',
        file.mimetype || 'image/jpeg',
        targetBucket,
      );

      // 2. Insert image metadata to product_images table
      const imageResult = await this.db.query(
        `INSERT INTO product_images (product_id, image_url, is_primary)
         VALUES ($1, $2, $3) RETURNING id`,
        [id, imageUrl, is_primary],
      );
      const imageId = imageResult.rows[0].id;

      // 3. Generate CLIP unit-normalized embedding
      const embedding = await this.aiService.generateEmbedding(file.buffer);

      // 4. Save embedding to pgvector image_embeddings table
      // Format array as postgres vector string: '[v1, v2, ...]'
      const pgVectorStr = `[${embedding.join(',')}]`;
      await this.db.query(
        `INSERT INTO image_embeddings (product_image_id, embedding)
         VALUES ($1, $2)`,
        [imageId, pgVectorStr],
      );

      // 5. Update featured_image_url on the product table if this is the primary image
      if (is_primary) {
        await this.db.query(
          'UPDATE products SET featured_image_url = $1 WHERE id = $2',
          [imageUrl, id],
        );
      }

      return {
        message: 'Image uploaded and processed',
        image_url: imageUrl,
      };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to process and upload image: ${error.message}`);
    }
  }

  @Get(':id/images')
  async getProductImages(@Param('id') id: string) {
    try {
      const result = await this.db.query(
        'SELECT id, image_url, is_primary FROM product_images WHERE product_id = $1',
        [id],
      );
      return result.rows.map((row) => ({
        id: row.id,
        image_url: row.image_url,
        is_primary: row.is_primary,
      }));
    } catch (error) {
      throw new InternalServerErrorException(`Failed to fetch product images: ${error.message}`);
    }
  }
}
