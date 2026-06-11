import { ShoppingSearch } from '../models/ShoppingSearch';

const HISTORY_CAP = 20;

export async function saveSearch(userId: string, query: string, results: unknown) {
  // De-duplicate: if the user's most recent search has the same query, update it in place
  const last = await ShoppingSearch.findOne({ userId }).sort({ createdAt: -1 });

  if (last && last.query === query) {
    last.results = results;
    await last.save();
    return { doc: last, created: false };
  }

  const doc = await ShoppingSearch.create({ userId, query, results });

  // Prune oldest rows beyond cap — fire-and-forget, non-blocking
  ShoppingSearch.find({ userId })
    .sort({ createdAt: -1 })
    .skip(HISTORY_CAP)
    .select('_id')
    .then((old) => {
      if (old.length > 0) {
        const ids = old.map((d) => d._id);
        return ShoppingSearch.deleteMany({ _id: { $in: ids } });
      }
    })
    .catch(() => {/* non-critical */});

  return { doc, created: true };
}

export async function getLastSearch(userId: string) {
  return ShoppingSearch.findOne({ userId }).sort({ createdAt: -1 });
}

export async function listSearches(userId: string, limit: number) {
  return ShoppingSearch.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('_id query createdAt updatedAt');
}

export async function getSearchById(userId: string, id: string) {
  return ShoppingSearch.findOne({ _id: id, userId });
}

export async function updateSearchResults(userId: string, id: string, results: unknown) {
  return ShoppingSearch.findOneAndUpdate(
    { _id: id, userId },
    { results },
    { new: true },
  );
}

export async function deleteSearch(userId: string, id: string) {
  const result = await ShoppingSearch.deleteOne({ _id: id, userId });
  return result.deletedCount > 0;
}

export async function clearSearches(userId: string) {
  await ShoppingSearch.deleteMany({ userId });
}
