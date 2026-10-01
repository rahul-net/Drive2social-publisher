import type { DriveVideoFile } from "@shared";

// ============================================================
// Drive file selection for the Create Post wizard (Phase 6).
// The selection survives navigation via router state AND
// sessionStorage (reload-safe within the tab).
// ============================================================

const STORAGE_KEY = "drive2social:selectedDriveFile";

export function saveSelectedDriveFile(file: DriveVideoFile): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // Storage unavailable — router state still carries the selection.
  }
}

export function loadSelectedDriveFile(): DriveVideoFile | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DriveVideoFile;
  } catch {
    return null;
  }
}

export function clearSelectedDriveFile(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
