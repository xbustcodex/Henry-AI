// Canonical implementation lives in electron/ipc/_keyStorage.ts
// This re-export exists so any future imports from this path still resolve.
export { encryptKey, decryptKey, isEncrypted, canEncrypt, migrateProviderKeys } from '../ipc/_keyStorage';
