import { Router } from "express";
import { z } from "zod";
import {
  createInventoryCategory,
  createInventoryItem,
  deleteInventoryCategory,
  deleteInventoryItem,
  getInventoryCategories,
  getInventoryItemByBarcode,
  getInventoryItems,
  setInventoryItemCheckedOut,
  updateInventoryItem,
  type InventoryCategoryRow,
  type InventoryItemRow,
} from "../db.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth);

function toApiCategory(row: InventoryCategoryRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

function toApiItem(row: InventoryItemRow) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    barcode: row.barcode,
    photoBase64: row.photo_base64,
    photoMime: row.photo_mime,
    checkedOut: row.checked_out === 1,
    checkedOutAt: row.checked_out_at,
    createdAt: row.created_at,
  };
}

inventoryRouter.get(
  "/categories",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await getInventoryCategories(req.userId!);
    res.json({ categories: rows.map(toApiCategory) });
  })
);

const categorySchema = z.object({ name: z.string().min(1).max(60) });

inventoryRouter.post(
  "/categories",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const row = await createInventoryCategory(req.userId!, parsed.data.name);
    res.json(toApiCategory(row));
  })
);

inventoryRouter.delete(
  "/categories/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const deleted = await deleteInventoryCategory(req.userId!, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Category not found" });
    }
    res.json({ ok: true });
  })
);

inventoryRouter.get(
  "/items",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await getInventoryItems(req.userId!);
    res.json({ items: rows.map(toApiItem) });
  })
);

// Base64 photo — the client resizes/compresses to a small thumbnail before
// sending, so this ceiling is generous headroom against a client that
// skipped that step, not a target size in itself. Nullable (not just
// optional): the client sends an explicit `null` for "no photo" (it always
// includes the key, since InventoryItem.photoBase64 is `string | null`
// throughout, never an absent field), which a plain `.optional()` schema
// rejects as "Expected string, received null".
const photoBase64Schema = z.string().max(6_000_000).nullable().optional();
const photoMimeSchema = z.string().max(40).nullable().optional();

const createItemSchema = z.object({
  name: z.string().min(1).max(120),
  categoryId: z.string().max(64).nullable().optional(),
  photoBase64: photoBase64Schema,
  photoMime: photoMimeSchema,
});

// The barcode itself is never client-supplied — createInventoryItem always
// generates a fresh one, so there's no way to end up with two items sharing
// a code or an item claiming some real retail product's barcode.
inventoryRouter.post(
  "/items",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const row = await createInventoryItem(req.userId!, parsed.data);
    res.json(toApiItem(row));
  })
);

const updateItemSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  categoryId: z.string().max(64).nullable().optional(),
  photoBase64: photoBase64Schema,
  photoMime: photoMimeSchema,
});

inventoryRouter.put(
  "/items/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = updateItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const row = await updateInventoryItem(req.userId!, req.params.id, parsed.data);
    if (!row) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(toApiItem(row));
  })
);

inventoryRouter.delete(
  "/items/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const deleted = await deleteInventoryItem(req.userId!, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json({ ok: true });
  })
);

// Explicit check-out/check-in, addressed by item id — the detail panel's
// fallback for when scanning isn't handy (testing on web, poor lighting).
inventoryRouter.post(
  "/items/:id/checkout",
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await setInventoryItemCheckedOut(req.userId!, req.params.id, true);
    if (!row) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(toApiItem(row));
  })
);

inventoryRouter.post(
  "/items/:id/checkin",
  asyncHandler(async (req: AuthedRequest, res) => {
    const row = await setInventoryItemCheckedOut(req.userId!, req.params.id, false);
    if (!row) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json(toApiItem(row));
  })
);

const scanSchema = z.object({ barcode: z.string().min(1).max(40) });

// The camera-scan flow's one endpoint — looks the code up and flips
// checked_out, so scanning an item on your way out checks it out, and
// scanning that same item again later checks it back in. No mode switch to
// get wrong; whichever state it's in, scanning it moves it to the other one.
inventoryRouter.post(
  "/scan",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const existing = await getInventoryItemByBarcode(req.userId!, parsed.data.barcode);
    if (!existing) {
      return res.status(404).json({ error: "No item matches this barcode." });
    }
    const nextCheckedOut = existing.checked_out !== 1;
    const row = await setInventoryItemCheckedOut(req.userId!, existing.id, nextCheckedOut);
    res.json({ item: toApiItem(row!), action: nextCheckedOut ? "checked-out" : "checked-in" });
  })
);
