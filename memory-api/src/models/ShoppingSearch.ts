import { Schema, model, Document } from 'mongoose';

export interface IShoppingSearch extends Document {
  userId: string;
  query: string;
  results: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const ShoppingSearchSchema = new Schema<IShoppingSearch>(
  {
    userId: { type: String, required: true, index: true },
    query: { type: String, required: true },
    results: { type: Schema.Types.Mixed, required: true },
  },
  {
    timestamps: true,
  },
);

ShoppingSearchSchema.index({ userId: 1, createdAt: -1 });

export const ShoppingSearch = model<IShoppingSearch>(
  'ShoppingSearch',
  ShoppingSearchSchema,
);
