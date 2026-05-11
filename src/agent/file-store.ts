/**
 * Module-level store for raw File objects attached by the user.
 * Populated when the user selects files in the Composer.
 * The file.upload tool reads from here to perform multipart uploads.
 */
const store = new Map<string, File>();

export function storeFile(file: File): void {
  store.set(file.name, file);
}

export function removeFile(name: string): void {
  store.delete(name);
}

export function getFile(name: string): File | undefined {
  return store.get(name);
}

export function getStoredFileNames(): string[] {
  return Array.from(store.keys());
}
