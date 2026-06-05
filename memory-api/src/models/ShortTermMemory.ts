import { Schema, model, Document, Types } from 'mongoose';

export interface IMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface IShortTermMemory extends Document {
  userId: string;
  sessionId: string;
  messages: IMessage[];
  lastActivity: Date;
  createdAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ShortTermMemorySchema = new Schema<IShortTermMemory>(
  {
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true },
    messages: {
      type: [MessageSchema],
      default: [],
    },
    lastActivity: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  },
);

// Compound index leading with userId - all queries must be scoped to a user
ShortTermMemorySchema.index({ userId: 1, sessionId: 1 }, { unique: true });

// TTL index: sessions expire 24 hours after last activity
ShortTermMemorySchema.index({ lastActivity: 1 }, { expireAfterSeconds: 86_400 });

// Cap messages array at 100 entries (sliding window) via pre-save hook
const MESSAGE_CAP = 100;
ShortTermMemorySchema.pre('save', function (next) {
  if (this.messages.length > MESSAGE_CAP) {
    this.messages = this.messages.slice(this.messages.length - MESSAGE_CAP);
  }
  next();
});

export const ShortTermMemory = model<IShortTermMemory>(
  'ShortTermMemory',
  ShortTermMemorySchema,
);
