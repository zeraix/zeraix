/**
 * Renderer-layer bridge for file-based "memories" (window.memoryFiles exposed by preload, Electron only).
 *
 * Each memory is a standalone Markdown file; the AI writes them via the save_memory tool and reads them back into context during chat.
 * In non-Electron (Web) environments the bridge is absent, so everything degrades to no-op / empty array.
 */

/** A single memory (corresponds to one Markdown file). */
export interface MemoryFile {
  id: string;
  title: string;
  content: string;
  created: string;
  updated: string;
  file: string;
}

/** Save result. */
export interface SavedMemory {
  id: string;
  title: string;
  file: string;
  created: string;
  updated: string;
}

interface MemoryFilesBridge {
  save(input: { title?: string; content?: string; id?: string }): Promise<SavedMemory>;
  list(): Promise<MemoryFile[]>;
  remove(id: string): Promise<boolean>;
  openDir(): Promise<string>;
  import(): Promise<{ imported: number }>;
  downloadTemplate(): Promise<{ ok: boolean; path?: string; error?: string }>;
  exportZip(): Promise<{ ok: boolean; path?: string; count?: number; empty?: boolean; error?: string }>;
}

declare global {
  interface Window {
    memoryFiles?: MemoryFilesBridge;
  }
}

function bridge(): MemoryFilesBridge | null {
  return typeof window !== "undefined" && window.memoryFiles ? window.memoryFiles : null;
}

/** Whether the current environment supports file-based memories (Electron only). */
export function isMemoryFilesAvailable(): boolean {
  return !!bridge();
}

/** Save/update a memory; returns null outside Electron. */
export async function saveMemoryFile(input: {
  title?: string;
  content?: string;
  id?: string;
}): Promise<SavedMemory | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return await b.save(input);
  } catch {
    return null;
  }
}

/** List all memories; returns an empty array on failure. */
export async function listMemoryFiles(): Promise<MemoryFile[]> {
  const b = bridge();
  if (!b) return [];
  try {
    return await b.list();
  } catch {
    return [];
  }
}

/** Delete a memory; returns whether it succeeded. */
export async function deleteMemoryFile(id: string): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  try {
    return await b.remove(id);
  } catch {
    return false;
  }
}

/** Open the memory directory. */
export async function openMemoryDir(): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    await b.openDir();
  } catch {
    /* Ignore */
  }
}

/** Pop up a file picker to import memories (.md/.markdown/.txt, multi-select allowed); returns the number successfully imported. */
export async function importMemories(): Promise<number> {
  const b = bridge();
  if (!b?.import) return 0;
  try {
    const r = await b.import();
    return r?.imported ?? 0;
  } catch {
    return 0;
  }
}

/** Download a memory template .md (random id, timestamp is the download moment); returns whether the write succeeded. */
export async function downloadTemplate(): Promise<boolean> {
  const b = bridge();
  if (!b?.downloadTemplate) return false;
  try {
    return (await b.downloadTemplate()).ok;
  } catch {
    return false;
  }
}

/** Export all memories to a ZIP in one click; returns { ok, count, empty }. */
export async function exportMemories(): Promise<{ ok: boolean; count: number; empty: boolean }> {
  const b = bridge();
  if (!b?.exportZip) return { ok: false, count: 0, empty: false };
  try {
    const r = await b.exportZip();
    return { ok: !!r.ok, count: r.count ?? 0, empty: !!r.empty };
  } catch {
    return { ok: false, count: 0, empty: false };
  }
}
