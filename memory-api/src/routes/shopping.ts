import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import * as service from '../services/shoppingSearch.service';

const router = Router();

const auth = (req: Request) => req as unknown as AuthenticatedRequest;

// POST /shopping/searches
router.post('/searches', async (req, res: Response) => {
  const { userId } = auth(req);
  const { query, results } = req.body as { query?: string; results?: unknown };

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  if (!results || typeof results !== 'object') {
    res.status(400).json({ error: 'results is required' });
    return;
  }

  const { doc, created } = await service.saveSearch(userId, query.trim(), results);
  res.status(created ? 201 : 200).json(doc);
});

// GET /shopping/searches/last — must be before /:id
router.get('/searches/last', async (req, res: Response) => {
  const { userId } = auth(req);
  const doc = await service.getLastSearch(userId);
  if (!doc) {
    res.status(204).end();
    return;
  }
  res.json(doc);
});

// GET /shopping/searches
router.get('/searches', async (req, res: Response) => {
  const { userId } = auth(req);
  const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 50);
  const docs = await service.listSearches(userId, limit);
  res.json(docs);
});

// GET /shopping/searches/:id
router.get('/searches/:id', async (req, res: Response) => {
  const { userId } = auth(req);
  const doc = await service.getSearchById(userId, req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(doc);
});

// PUT /shopping/searches/:id
router.put('/searches/:id', async (req, res: Response) => {
  const { userId } = auth(req);
  const { results } = req.body as { results?: unknown };

  if (!results || typeof results !== 'object') {
    res.status(400).json({ error: 'results is required' });
    return;
  }

  const doc = await service.updateSearchResults(userId, req.params.id, results);
  if (!doc) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(doc);
});

// DELETE /shopping/searches/:id
router.delete('/searches/:id', async (req, res: Response) => {
  const { userId } = auth(req);
  const deleted = await service.deleteSearch(userId, req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.status(204).end();
});

// DELETE /shopping/searches
router.delete('/searches', async (req, res: Response) => {
  const { userId } = auth(req);
  await service.clearSearches(userId);
  res.status(204).end();
});

export default router;
