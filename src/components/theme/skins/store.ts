/**
 * The skin store, simulated -- the same seam as src/lib/ai/skills/marketplace.ts. The catalog is bundled
 * (builtin.ts) and these two functions fake a network round trip. Going online means replacing their bodies with a
 * fetch; the payload already passes through sanitizeSkin as if untrusted, because then it will be.
 */
import { sanitizeSkin, type Skin } from "../../../../electron/skins/schema.mjs";
import { STORE_CATALOG } from "./builtin";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const catalog = () =>
  STORE_CATALOG.map((raw) => sanitizeSkin(raw, { origin: "store" })).filter((s): s is Skin => s !== null);

export async function fetchSkinCatalog(): Promise<Skin[]> {
  await delay(250);
  return catalog();
}

export async function downloadSkin(id: string): Promise<Skin> {
  await delay(300);
  const hit = catalog().find((s) => s.id === id);
  if (!hit) throw new Error(`No such skin in the store: ${id}`);
  return hit;
}
