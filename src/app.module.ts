import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database/database.service';
import { AIService } from './services/ai.service';
import { StorageService } from './services/storage.service';
import { AppController } from './controllers/app.controller';
import { CategoriesController } from './controllers/categories.controller';
import { ProductsController } from './controllers/products.controller';
import { SavedProductsController } from './controllers/saved_products.controller';
import { ScansController } from './controllers/scans.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [
    AppController,
    CategoriesController,
    ProductsController,
    SavedProductsController,
    ScansController,
  ],
  providers: [
    DatabaseService,
    AIService,
    StorageService,
  ],
})
export class AppModule {}
