# AI Furniture Matcher - NestJS Backend

This is the production-grade NestJS conversion of the original FastAPI Python backend. It replicates all database schema integrations, Supabase storage structures, and pgvector cosine-distance similarity scans, while introducing modular TypeScript architecture and local ONNX-powered CLIP image feature extraction.

## Features

- **Xenova Transformers**: Replaces PyTorch/OpenCLIP with `@xenova/transformers` (running the compiled `Xenova/clip-vit-base-patch32` model in ONNX). It generates identical 512-dimensional unit-normalized image embeddings completely locally.
- **pgvector Cosine Distance Querying**: Uses the PostgreSQL `Pool` adapter to query embeddings using the pgvector operator `<=>` (cosine distance), mapping distances accurately to a `0.0 - 1.0` confidence score range.
- **Supabase Storage Integration**: Integrates file uploading to Supabase Storage buckets (`product-image`, `product-gallery`, `scan-history`) and resolves signed/public URLs.
- **Automatic Categories Seeding**: Replicates the Python startup lifespan event to populate default categories (`Sofa`, `Chair`, `Table`, `Bed`, `Storage`) automatically if the table is empty.
- **Modular NestJS Architecture**: Organizes controllers, services, and configuration cleanly using standard dependency injection.

---

## Folder Structure

```
ai-match-backend-nest/
├── src/
│   ├── main.ts                     # Bootstraps the app, seeds categories, configures CORS & prefixes
│   ├── app.module.ts               # Core module registry
│   ├── controllers/
│   │   ├── app.controller.ts       # Health checks (/health, /health/db) and session (/me)
│   │   ├── categories.controller.ts# Fetch categories
│   │   ├── products.controller.ts  # Products CRUD & image uploads
│   │   ├── saved_products.controller.ts # User-saved products
│   │   └── scans.controller.ts     # Camera scanning & pgvector AI matching
│   ├── database/
│   │   └── database.service.ts     # PostgreSQL connection pool & transaction helper
│   └── services/
│       ├── ai.service.ts           # ONNX CLIP embedding generator
│       └── storage.service.ts      # Supabase cloud storage uploader
├── .env                            # Connection strings and API keys
├── nest-cli.json                   # Nest CLI compiler config
├── tsconfig.json                   # TypeScript compiler configuration
└── package.json                    # Dependencies & npm scripts
```

---

## API Endpoints

All routes (except `/health`) are prefixed with `/api/v1`.

### General & Health
- `GET /health` - Basic health status checks.
- `GET /api/v1/health/db` - Verifies database connectivity.
- `GET /api/v1/me` - Mock user authentication payload.

### Categories
- `GET /api/v1/categories` - Lists all product categories.

### Products
- `GET /api/v1/products` - Lists all products including tags and image arrays.
- `POST /api/v1/products` - Adds a new product to the catalog.
- `GET /api/v1/products/:id` - Retrieves a product by ID.
- `PUT /api/v1/products/:id` - Updates product metadata.
- `DELETE /api/v1/products/:id` - Deletes a product.
- `POST /api/v1/products/:id/images` - Uploads a product image, computes CLIP embedding, and saves it in `image_embeddings`.
- `GET /api/v1/products/:id/images` - Lists all images of a product.

### Saved Products
- `GET /api/v1/saved-products` - Lists products saved by the user.
- `POST /api/v1/saved-products` - Saves a product (`{ "product_id": "UUID" }`).
- `DELETE /api/v1/saved-products/:id` - Removes a saved product.

### AI Matching (Scans)
- `POST /api/v1/scan-product` - Uploads a camera photo scan, performs a pgvector cosine distance lookup, logs history, and returns the top 3 best-matched products (with exact similarity percentages).
- `GET /api/v1/scan-history` - Retrieves all matching scan histories.
- `GET /api/v1/scan-history/:id` - Retrieves a single scan history log.

---

## Quick Start

### 1. Prerequisites
- Node.js (v18 or higher recommended, tested on v24.13)
- npm (v9 or higher)

### 2. Install Dependencies
Run from the root of this folder:
```bash
npm install
```

### 3. Setup Configuration
Confirm that `.env` exists in the folder root and contains:
```env
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_KEY=eyJhbGci...
ENVIRONMENT=development
API_V1_STR=/api/v1
PORT=8000
```
*(Note: Unlike the Python driver, the Node `pg` driver requires `postgresql://` instead of `postgresql+asyncpg://` — the database service automatically handles conversion).*

### 4. Run the Server

#### Run in Development mode (with Hot Reload / watch mode):
```bash
npm run start:dev
```

#### Run in Production mode:
```bash
npm run build
npm run start:prod
```
