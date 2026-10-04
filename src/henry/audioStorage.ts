/**
 * Henry — Audio Recording Storage (IndexedDB)
 *
 * Persists audio blobs across sessions for the Meeting Recorder.
 * localStorage is too small for audio; IndexedDB is the right layer.
 *
 * Usage:
 *   await saveAudio('rec_123', blob);
 *   const url = await loadAudioURL('rec_123'); // object URL, revoke when done
 *   await deleteAudio('rec_123');
 */

const DB_NAME = 'henry_audio';
const STORE   = 'recordings';
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Save a Blob under the given recording ID. Overwrites any existing entry. */
export async function saveAudio(id: string, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(blob, id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** Load a Blob and return a temporary object URL, or null if not found. */
export async function loadAudioURL(id: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => {
      const blob: Blob | undefined = req.result;
      db.close();
      resolve(blob ? URL.createObjectURL(blob) : null);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Delete the audio blob for a recording. Silent no-op if not found. */
export async function deleteAudio(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** Check whether audio exists for a recording without loading it. */
export async function hasAudio(id: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getKey(id);
    req.onsuccess = () => { db.close(); resolve(req.result !== undefined); };
    req.onerror   = () => { db.close(); resolve(false); };
  });
}
