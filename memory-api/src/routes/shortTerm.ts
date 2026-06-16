import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import * as memoryService from '../services/memory.service';

const router = Router();

const auth = (req: Request) => req as unknown as AuthenticatedRequest;

// GET /short-term/sessions — must be before /:sessionId to avoid being swallowed by the wildcard
router.get('/sessions', async (req, res: Response) => {
  const { userId } = auth(req);
  const sessions = await memoryService.listSessions(userId);
  res.json({ sessions });
});

// GET /short-term/:sessionId
router.get('/:sessionId', async (req, res: Response) => {
  const { userId } = auth(req);
  const { sessionId } = req.params;
  const messages = await memoryService.getSession(userId, sessionId);
  res.json({ sessionId, messages });
});

// POST /short-term/:sessionId/messages
router.post('/:sessionId/messages', async (req, res: Response) => {
  const { userId } = auth(req);
  const { sessionId } = req.params;
  const { role, content, toolCalls } = req.body as {
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  };

  if (!role || !content) {
    res.status(400).json({ error: 'role and content are required' });
    return;
  }
  if (!['user', 'assistant', 'system'].includes(role)) {
    res.status(400).json({ error: 'role must be user, assistant, or system' });
    return;
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: 'content must be a non-empty string' });
    return;
  }

  await memoryService.appendMessage(userId, sessionId, {
    role: role as 'user' | 'assistant' | 'system',
    content: content.trim(),
    ...(Array.isArray(toolCalls) && toolCalls.length > 0 ? { toolCalls } : {}),
  });

  res.status(201).json({ ok: true });
});

// DELETE /short-term/:sessionId
router.delete('/:sessionId', async (req, res: Response) => {
  const { userId } = auth(req);
  const { sessionId } = req.params;
  await memoryService.clearSession(userId, sessionId);
  res.json({ ok: true });
});

export default router;
