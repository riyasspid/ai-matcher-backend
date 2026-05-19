import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AIService implements OnModuleInit {
  private readonly logger = new Logger(AIService.name);
  private extractor: any;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    this.logger.log('Initializing AI Service with Xenova/clip-vit-base-patch32...');
    try {
      // Dynamic import to handle ES module inside CommonJS NestJS setup
      const { pipeline } = await (eval('import("@xenova/transformers")') as Promise<any>);
      
      // Use Xenova's compiled clip-vit-base-patch32 model for image feature extraction
      this.extractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
      this.logger.log('AI Service (CLIP model) successfully initialized.');

      // Proactively trigger background database embedding synchronization
      this.syncMissingEmbeddings();
    } catch (error) {
      this.logger.error('Failed to initialize AI Service:', error);
    }
  }

  private async syncMissingEmbeddings() {
    this.logger.log('Checking database for any product images missing AI embeddings...');
    try {
      const queryResult = await this.db.query(
        `SELECT pi.id, pi.image_url 
         FROM product_images pi 
         LEFT JOIN image_embeddings ie ON pi.id = ie.product_image_id 
         WHERE ie.id IS NULL`
      );

      const missingCount = queryResult.rows.length;
      if (missingCount === 0) {
        this.logger.log('All product images are fully synchronized with AI embeddings.');
        return;
      }

      this.logger.log(`Found ${missingCount} product image(s) missing AI embeddings. Initiating synchronization...`);

      for (const row of queryResult.rows) {
        const { id: imageId, image_url: imageUrl } = row;
        this.logger.log(`Syncing AI embedding for image ID ${imageId} (${imageUrl})...`);

        try {
          const response = await fetch(imageUrl);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          
          const arrayBuffer = await response.arrayBuffer();
          const imageBuffer = Buffer.from(arrayBuffer);

          const embedding = await this.generateEmbedding(imageBuffer);
          const pgVectorStr = `[${embedding.join(',')}]`;

          await this.db.query(
            `INSERT INTO image_embeddings (product_image_id, embedding)
             VALUES ($1, $2)`,
            [imageId, pgVectorStr]
          );

          this.logger.log(`Successfully generated and saved embedding for image ID ${imageId}.`);
        } catch (imageError) {
          this.logger.error(`Failed to generate embedding for image ID ${imageId}:`, imageError);
        }
      }

      this.logger.log('Database embedding synchronization complete.');
    } catch (error) {
      this.logger.error('Error during database embedding synchronization:', error);
    }
  }

  async generateEmbedding(imageBuffer: Buffer): Promise<number[]> {
    if (!this.extractor) {
      throw new Error('AI Service has not been initialized yet.');
    }

    try {
      const { RawImage } = await (eval('import("@xenova/transformers")') as Promise<any>);
      
      this.logger.log('Decoding and pre-resizing image in-memory using sharp...');
      
      // Force single-threaded VIPS execution to completely prevent GObject DLL registration crashes on Windows
      process.env.VIPS_CONCURRENCY = '1';
      const sharpModule = await import('sharp');
      const sharp = (sharpModule.default || sharpModule) as any;
      
      // Decode raw RGB pixels and pre-scale to exact CLIP dimensions (224x224 cover fit)
      // This completely avoids any secondary internal sharp calls by Transformers.js AutoProcessor!
      const { data, info } = await sharp(imageBuffer)
        .resize(224, 224, { fit: 'cover' })
        .removeAlpha() // Ensure no alpha transparency channel (always 3 channels)
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      this.logger.log(`Successfully decoded image bitmap: ${info.width}x${info.height} (forced 3 channels)`);
      
      const image = new RawImage(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        3
      );
      
      // Generate CLIP features
      this.logger.log('Extracting CLIP features (this may take 15-30 seconds on the very first run)...');
      const output = await this.extractor(image);
      this.logger.log('CLIP feature extraction completed successfully.');
      
      const embedding: number[] = Array.from(output.data);

      // Normalize the embedding vector to unit length (L2 normalization)
      let sumSq = 0;
      for (const val of embedding) {
        sumSq += val * val;
      }
      const norm = Math.sqrt(sumSq);

      if (norm > 0) {
        return embedding.map(val => val / norm);
      }
      return embedding;
    } catch (error) {
      this.logger.error('Error generating image embedding:', error);
      throw new Error(`Embedding generation failed: ${error.message}`);
    }
  }
}
