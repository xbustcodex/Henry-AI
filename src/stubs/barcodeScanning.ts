/**
 * Web stub for @capacitor-mlkit/barcode-scanning
 *
 * This file is aliased in vite.web.config.ts so the dev server and
 * production web build can resolve the module without the native package.
 * On the real native app the Capacitor plugin is used directly.
 */

export interface BarcodeScanResult {
  barcodes?: Array<{ rawValue?: string }>;
}

/** Non-null shape matches the native plugin; value is always `null` in web/Electron bundles. */
export const BarcodeScanner: { scan: () => Promise<BarcodeScanResult> } | null = null;
