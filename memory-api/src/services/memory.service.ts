import { ShortTermMemory, IMessage } from '../models/ShortTermMemory';
import {
  LongTermMemory,
  IPreferences,
  IConversationSummary,
  IPurchaseEvent,
  ICartActivityRecord,
} from '../models/LongTermMemory';

// ---------------------------------------------------------------------------
// Short-term memory
// ---------------------------------------------------------------------------

/**
 * Return all messages for a session owned by the given user.
 * userId is always the first filter - never queryable without it.
 */
export async function getSession(
  userId: string,
  sessionId: string,
): Promise<IMessage[]> {
  const doc = await ShortTermMemory.findOne({ userId, sessionId }).lean();
  return doc?.messages ?? [];
}

/**
 * Append a message to a session. Creates the session document if it does not exist.
 * The pre-save hook enforces the 100-message sliding window cap.
 */
export async function appendMessage(
  userId: string,
  sessionId: string,
  message: Omit<IMessage, 'timestamp'>,
): Promise<void> {
  await ShortTermMemory.findOneAndUpdate(
    { userId, sessionId },
    {
      $push: { messages: { ...message, timestamp: new Date() } },
      $set: { lastActivity: new Date() },
    },
    { upsert: true, new: true },
  );
}

/**
 * Delete all messages for a session - used when the user ends a session
 * or when the AI triggers a summarise-and-clear flow.
 */
export async function clearSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  await ShortTermMemory.deleteOne({ userId, sessionId });
}

/**
 * List all active session IDs for a user (for debugging / admin purposes).
 */
export async function listSessions(userId: string): Promise<string[]> {
  const docs = await ShortTermMemory.find({ userId }, { sessionId: 1 }).lean();
  return docs.map((d) => d.sessionId);
}

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

/**
 * Return the long-term memory document for a user.
 * Returns null if the user has no long-term memory yet.
 */
export async function getLongTermMemory(userId: string) {
  return LongTermMemory.findOne({ userId }).lean();
}

/**
 * Merge partial preferences into the user's long-term memory.
 * Creates the document if it does not exist.
 */
export async function upsertPreferences(
  userId: string,
  preferences: Partial<IPreferences>,
): Promise<void> {
  const setFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(preferences)) {
    setFields[`preferences.${key}`] = value;
  }
  await LongTermMemory.findOneAndUpdate(
    { userId },
    { $set: setFields },
    { upsert: true, new: true },
  );
}

/**
 * Append a conversation summary to the user's long-term memory.
 * The pre-save hook keeps the last 50 summaries.
 */
export async function appendSummary(
  userId: string,
  summary: string,
): Promise<void> {
  const doc = await LongTermMemory.findOneAndUpdate(
    { userId },
    {
      $push: {
        conversationSummaries: { summary, createdAt: new Date() },
      },
    },
    { upsert: true, new: true },
  );
  // Enforce summary cap via a save to trigger pre-save hook
  if (doc && doc.conversationSummaries.length > 50) {
    await doc.save();
  }
}

/**
 * Record a purchase event in the user's long-term memory.
 */
export async function recordPurchase(
  userId: string,
  purchase: IPurchaseEvent,
): Promise<void> {
  await LongTermMemory.findOneAndUpdate(
    { userId },
    { $push: { purchaseHistory: purchase } },
    { upsert: true, new: true },
  );
}

/**
 * Upsert a cart-add signal in the user's long-term memory.
 * Re-adding the same productId bumps addedAt instead of appending a duplicate.
 * The pre-save hook keeps the array capped at 50.
 */
export async function recordCartActivity(
  userId: string,
  record: ICartActivityRecord,
): Promise<void> {
  // Try to update an existing entry for the same product first
  const updated = await LongTermMemory.findOneAndUpdate(
    { userId, 'cartActivity.productId': record.productId },
    {
      $set: {
        'cartActivity.$.addedAt': record.addedAt,
        'cartActivity.$.price': record.price,
        'cartActivity.$.productName': record.productName,
        'cartActivity.$.thumbnail': record.thumbnail ?? null,
      },
    },
    { new: true },
  );

  if (updated) return;

  // No existing entry — push a new one and enforce cap via save
  const doc = await LongTermMemory.findOneAndUpdate(
    { userId },
    { $push: { cartActivity: record } },
    { upsert: true, new: true },
  );
  if (doc && doc.cartActivity.length > 50) {
    await doc.save();
  }
}
