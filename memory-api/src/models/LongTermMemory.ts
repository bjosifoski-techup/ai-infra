import { Schema, model, Document } from 'mongoose';

export interface IPreferences {
  language?: string;
  currency?: string;
  preferredCategories?: string[];
  [key: string]: unknown;
}

export interface IConversationSummary {
  summary: string;
  createdAt: Date;
}

export interface IPurchaseEvent {
  orderId: string;
  source: string; // e.g. 'aliexpress', 'bigbuy', 'cjdropshipping'
  productId: string;
  productName: string;
  amount: number;
  currency: string;
  purchasedAt: Date;
}

export interface ILongTermMemory extends Document {
  userId: string;
  preferences: IPreferences;
  conversationSummaries: IConversationSummary[];
  purchaseHistory: IPurchaseEvent[];
  updatedAt: Date;
  createdAt: Date;
}

const PreferencesSchema = new Schema<IPreferences>(
  {
    language: { type: String },
    currency: { type: String },
    preferredCategories: { type: [String], default: [] },
  },
  { strict: false, _id: false }, // strict: false allows arbitrary preference keys
);

const ConversationSummarySchema = new Schema<IConversationSummary>(
  {
    summary: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const PurchaseEventSchema = new Schema<IPurchaseEvent>(
  {
    orderId: { type: String, required: true },
    source: { type: String, required: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    purchasedAt: { type: Date, required: true },
  },
  { _id: false },
);

const LongTermMemorySchema = new Schema<ILongTermMemory>(
  {
    // One document per user - userId is the natural key
    userId: { type: String, required: true, unique: true },
    preferences: { type: PreferencesSchema, default: {} },
    conversationSummaries: {
      type: [ConversationSummarySchema],
      default: [],
    },
    purchaseHistory: {
      type: [PurchaseEventSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

// Index leading with userId (unique already creates one, but explicit for clarity)
LongTermMemorySchema.index({ userId: 1 });

// Cap summaries at 50 most recent
const SUMMARY_CAP = 50;
LongTermMemorySchema.pre('save', function (next) {
  if (this.conversationSummaries.length > SUMMARY_CAP) {
    this.conversationSummaries = this.conversationSummaries.slice(
      this.conversationSummaries.length - SUMMARY_CAP,
    );
  }
  next();
});

export const LongTermMemory = model<ILongTermMemory>(
  'LongTermMemory',
  LongTermMemorySchema,
);
