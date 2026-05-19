import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  UploadedFile,
  UseInterceptors,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../services/storage.service';
import { AIService } from '../services/ai.service';

@Controller()
export class ScansController {
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

  @Post('scan-product')
  @UseInterceptors(FileInterceptor('file'))
  async scanProduct(
    @UploadedFile() file: Express.Multer.File,
    @Body('user_id') userIdFromBody?: string,
    @Query('user_id') userIdFromQuery?: string,
    @Headers('x-user-id') userIdHeader?: string,
  ) {
    const startTime = Date.now();

    if (!file) {
      throw new BadRequestException('No image file provided for scanning.');
    }

    const actualUserId =
      userIdFromBody || userIdFromQuery || userIdHeader || '00000000-0000-0000-0000-000000000000';

    // 1. Generate query embedding
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.aiService.generateEmbedding(file.buffer);
    } catch (error) {
      throw new BadRequestException(`Failed to process scan image: ${error.message}`);
    }

    // 2. Upload scan image to Supabase Storage
    let uploadedImageUrl = 'http://example.com/dummy-scan-url.jpg';
    try {
      uploadedImageUrl = await this.storageService.uploadImage(
        file.buffer,
        file.originalname || 'scan.jpg',
        file.mimetype || 'image/jpeg',
        this.storageService.scanHistoryBucket,
      );
    } catch (error) {
      // Fallback
    }

    // 3. Query pgvector for the nearest 3 neighbors using cosine distance
    const pgVectorStr = `[${queryEmbedding.join(',')}]`;
    let dbResults;
    try {
      dbResults = await this.db.query(
        `SELECT 
           p.*, 
           (ie.embedding <=> $1) AS distance
         FROM image_embeddings ie
         JOIN product_images pi ON ie.product_image_id = pi.id
         JOIN products p ON pi.product_id = p.id
         ORDER BY distance ASC
         LIMIT 3`,
        [pgVectorStr],
      );
    } catch (error) {
      throw new InternalServerErrorException(`Database query failed: ${error.message}`);
    }

    if (!dbResults || dbResults.rows.length === 0) {
      throw new NotFoundException(
        'No matching products found. Please add products to the catalog first.',
      );
    }

    const processingTimeMs = Date.now() - startTime;

    // 4. Load full relations for matching products
    const rawMatchedProducts = dbResults.rows;
    const populatedProducts = await this.populateProductsRelations(rawMatchedProducts);

    // Calculate similarity & confidences (mapping distance 0-2 -> similarity 0-1)
    const matches = populatedProducts.map((prod, index) => {
      const distance = Number(rawMatchedProducts[index].distance);
      const similarity = Math.max(0.0, 1.0 - distance / 2.0);
      const confidence = Math.round(similarity * 100) / 100;
      return {
        product: prod,
        confidence,
        rank: index + 1,
      };
    });

    const firstMatch = matches[0];
    const similarMatches = matches.slice(1).map((m) => ({
      product: m.product,
      confidence: m.confidence,
    }));

    // 5. Save history & matches inside a transaction
    try {
      await this.db.transaction(async (client) => {
        // Insert ScanHistory
        const historyResult = await client.query(
          `INSERT INTO scan_history (
             user_id, matched_product_id, confidence, uploaded_image_url,
             processing_time, device_platform
           ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            actualUserId === '00000000-0000-0000-0000-000000000000' ? null : actualUserId,
            firstMatch.product.id,
            firstMatch.confidence,
            uploadedImageUrl,
            processingTimeMs,
            'API',
          ],
        );
        const scanHistoryId = historyResult.rows[0].id;

        // Insert ScanMatches
        for (const match of matches) {
          await client.query(
            `INSERT INTO scan_matches (scan_id, product_id, confidence, rank)
             VALUES ($1, $2, $3, $4)`,
            [scanHistoryId, match.product.id, match.confidence, match.rank],
          );
        }
      });
    } catch (error) {
      console.error(`Failed to save scan history: ${error.message}`, error.stack);
    }

    return {
      matchedProduct: firstMatch.product,
      confidence: firstMatch.confidence,
      similarMatches: similarMatches,
      scannedAt: new Date().toISOString(),
    };
  }

  @Get('scan-history')
  async getScanHistory(
    @Query('user_id') userIdFromQuery?: string,
    @Headers('x-user-id') userIdHeader?: string,
  ) {
    const userId = userIdFromQuery || userIdHeader;
    if (!userId) {
      throw new BadRequestException('user_id is a required query parameter or header.');
    }

    try {
      const result = await this.db.query(
        `SELECT 
           p.*
         FROM scan_history sh
         JOIN products p ON sh.matched_product_id = p.id
         WHERE sh.user_id = $1 
         ORDER BY sh.created_at DESC
         LIMIT 5`,
        [userId],
      );
      
      return this.populateProductsRelations(result.rows);
    } catch (error) {
      throw new InternalServerErrorException(`Failed to fetch scan history: ${error.message}`);
    }
  }

  @Get('scan-history/:id')
  async getScanHistoryById(@Param('id') id: string) {
    try {
      const result = await this.db.query(
        'SELECT * FROM scan_history WHERE id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        throw new NotFoundException('Scan history not found');
      }
      
      const row = result.rows[0];
      return {
        id: row.id,
        user_id: row.user_id,
        matched_product_id: row.matched_product_id,
        confidence: row.confidence !== null ? parseFloat(row.confidence) : null,
        uploaded_image_url: row.uploaded_image_url,
        processing_time: row.processing_time,
        device_platform: row.device_platform,
        created_at: row.created_at,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Failed to fetch scan history item: ${error.message}`);
    }
  }
}
