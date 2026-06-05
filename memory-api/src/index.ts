import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
import { requireAuth } from './middleware/auth';
import shortTermRouter from './routes/shortTerm';
import longTermRouter from './routes/longTerm';
import { swaggerSpec } from './swagger';

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const requiredEnv = [
  'MONGODB_URI',
  'KEYCLOAK_JWKS_URL',
  'KEYCLOAK_ISSUER_URL',
  'MEMORY_JWT_AUDIENCE',
];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(express.json({ limit: '1mb' }));

// API docs - no auth required
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Emerico Memory API Docs',
}));

// Health check - no auth required
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// All memory routes require a valid Keycloak JWT
app.use('/short-term', requireAuth, shortTermRouter);
app.use('/long-term', requireAuth, longTermRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler - does not leak internal details
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// MongoDB connection + server start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.MEMORY_API_PORT ?? '3001', 10);

async function start() {
  try {
    await mongoose.connect(process.env.MONGODB_URI as string, {
      dbName: process.env.MONGODB_DB_NAME ?? 'emerico-memory',
    });
    console.log('Connected to MongoDB Atlas');

    app.listen(PORT, () => {
      console.log(`Memory API listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }
}

start();
