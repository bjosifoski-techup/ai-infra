import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import * as memoryService from '../services/memory.service';

const router = Router();

const auth = (req: Request) => req as unknown as AuthenticatedRequest;

// GET /long-term
router.get('/', async (req, res: Response) => {
  const { userId } = auth(req);
  const memory = await memoryService.getLongTermMemory(userId);
  const doc = memory ?? { userId, preferences: {}, conversationSummaries: [], purchaseHistory: [], cartActivity: [] };
  if (!doc.cartActivity) (doc as any).cartActivity = [];
  res.json(doc);
});

// PATCH /long-term/preferences
router.patch('/preferences', async (req, res: Response) => {
  const { userId } = auth(req);
  const preferences = req.body as Record<string, unknown>;

  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    res.status(400).json({ error: 'Body must be a JSON object of preference key-value pairs' });
    return;
  }

  await memoryService.upsertPreferences(userId, preferences);
  res.json({ ok: true });
});

// POST /long-term/summaries
router.post('/summaries', async (req, res: Response) => {
  const { userId } = auth(req);
  const { summary } = req.body as { summary: string };

  if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
    res.status(400).json({ error: 'summary must be a non-empty string' });
    return;
  }

  await memoryService.appendSummary(userId, summary.trim());
  res.status(201).json({ ok: true });
});

// POST /long-term/cart-activity
router.post('/cart-activity', async (req, res: Response) => {
  const { userId } = auth(req);
  const { source, productId, productName, variantId, price, currency, thumbnail, addedAt } =
    req.body as {
      source: string;
      productId: string;
      productName: string;
      variantId?: string | null;
      price: number;
      currency: string;
      thumbnail?: string | null;
      addedAt?: string;
    };

  if (!source || !productId || !productName || price == null || !currency) {
    res.status(400).json({ error: 'Missing required fields: source, productId, productName, price, currency' });
    return;
  }
  if (typeof price !== 'number' || price < 0) {
    res.status(400).json({ error: 'price must be a non-negative number' });
    return;
  }

  const parsedDate = addedAt ? new Date(addedAt) : new Date();
  if (isNaN(parsedDate.getTime())) {
    res.status(400).json({ error: 'addedAt must be a valid ISO date string' });
    return;
  }

  await memoryService.recordCartActivity(userId, {
    source,
    productId,
    productName,
    variantId: variantId ?? null,
    price,
    currency,
    thumbnail: thumbnail ?? null,
    addedAt: parsedDate,
  });

  res.status(201).json({ ok: true });
});

// POST /long-term/purchases
router.post('/purchases', async (req, res: Response) => {
  const { userId } = auth(req);
  const { orderId, source, productId, productName, amount, currency, purchasedAt } =
    req.body as {
      orderId: string;
      source: string;
      productId: string;
      productName: string;
      amount: number;
      currency: string;
      purchasedAt: string;
    };

  if (!orderId || !source || !productId || !productName || amount == null || !currency || !purchasedAt) {
    res.status(400).json({ error: 'Missing required purchase fields' });
    return;
  }
  if (typeof amount !== 'number' || amount < 0) {
    res.status(400).json({ error: 'amount must be a non-negative number' });
    return;
  }

  const parsedDate = new Date(purchasedAt);
  if (isNaN(parsedDate.getTime())) {
    res.status(400).json({ error: 'purchasedAt must be a valid ISO date string' });
    return;
  }

  await memoryService.recordPurchase(userId, {
    orderId,
    source,
    productId,
    productName,
    amount,
    currency,
    purchasedAt: parsedDate,
  });

  res.status(201).json({ ok: true });
});

export default router;
