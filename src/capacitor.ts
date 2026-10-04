import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { Network } from '@capacitor/network';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'
export const isIos = platform === 'ios';
export const isAndroid = platform === 'android';

/**
 * Best-effort iPhone vs iPad detection for companion pairing metadata.
 * Native iOS reports `ipad` for compatible iPad apps; web UA may contain "iPad".
 */
export function getAppleHandsetProduct(): 'iphone' | 'ipad' | 'unknown' {
  if (!isIos) return 'unknown';
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    if (/iPad/i.test(ua)) return 'ipad';
    // iOS 13+ iPad may declare as Macintosh with touch — treat as iPad
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'ipad';
    return 'iphone';
  } catch {
    return 'unknown';
  }
}

export async function initCapacitor() {
  if (!isNative) return;

  try {
    // Status bar — dark style to match Henry's dark theme
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0a0a12' });
    if (isAndroid) {
      await StatusBar.setOverlaysWebView({ overlay: false });
    }
  } catch { /* ignore */ }

  try {
    // Keyboard — push content up when keyboard opens
    Keyboard.addListener('keyboardWillShow', (info) => {
      document.documentElement.style.setProperty(
        '--keyboard-height',
        `${info.keyboardHeight}px`
      );
      document.body.classList.add('keyboard-open');
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.style.setProperty('--keyboard-height', '0px');
      document.body.classList.remove('keyboard-open');
    });
  } catch { /* ignore */ }

  try {
    // Network status monitoring
    Network.addListener('networkStatusChange', (status) => {
      window.dispatchEvent(new CustomEvent('henry_network_change', {
        detail: { connected: status.connected, type: status.connectionType },
      }));
    });
  } catch { /* ignore */ }

  try {
    // App lifecycle — save state when backgrounded
    App.addListener('appStateChange', ({ isActive }) => {
      window.dispatchEvent(new CustomEvent('henry_app_state', { detail: { isActive } }));
    });

    // Handle deep links / universal links
    App.addListener('appUrlOpen', (data) => {
      window.dispatchEvent(new CustomEvent('henry_deep_link', { detail: { url: data.url } }));
    });

    // Back button handling on Android
    if (isAndroid) {
      App.addListener('backButton', () => {
        window.dispatchEvent(new CustomEvent('henry_android_back'));
      });
    }
  } catch { /* ignore */ }

  try {
    // Push notifications
    const permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      await PushNotifications.requestPermissions();
    }
    if (permStatus.receive === 'granted') {
      await PushNotifications.register();
    }

    PushNotifications.addListener('registration', (token) => {
      try {
        localStorage.setItem('henry:push_token', token.value);
      } catch { /* ignore */ }
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      window.dispatchEvent(new CustomEvent('henry_push_notification', {
        detail: { notification },
      }));
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      window.dispatchEvent(new CustomEvent('henry_push_action', {
        detail: { action },
      }));
    });
  } catch { /* ignore */ }

  try {
    // Request local notification permission
    await LocalNotifications.requestPermissions();
  } catch { /* ignore */ }

  // Hide splash screen with a short fade
  try {
    await SplashScreen.hide({ fadeOutDuration: 400 });
  } catch { /* ignore */ }
}

// ── Haptics helpers ────────────────────────────────────────────────────────────

export async function hapticLight() {
  if (!isNative) return;
  try { await Haptics.impact({ style: ImpactStyle.Light }); } catch { /* ignore */ }
}

export async function hapticMedium() {
  if (!isNative) return;
  try { await Haptics.impact({ style: ImpactStyle.Medium }); } catch { /* ignore */ }
}

export async function hapticHeavy() {
  if (!isNative) return;
  try { await Haptics.impact({ style: ImpactStyle.Heavy }); } catch { /* ignore */ }
}

export async function hapticSuccess() {
  if (!isNative) return;
  try { await Haptics.notification({ type: 'SUCCESS' as any }); } catch { /* ignore */ }
}

export async function hapticError() {
  if (!isNative) return;
  try { await Haptics.notification({ type: 'ERROR' as any }); } catch { /* ignore */ }
}

// ── Local Notifications ────────────────────────────────────────────────────────

export async function scheduleLocalNotification(opts: {
  title: string;
  body: string;
  id?: number;
  scheduleAt?: Date;
}) {
  if (!isNative) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: opts.title,
          body: opts.body,
          id: opts.id ?? Math.floor(Math.random() * 100000),
          schedule: opts.scheduleAt ? { at: opts.scheduleAt } : undefined,
          sound: 'default',
          smallIcon: 'ic_stat_henry',
        },
      ],
    });
  } catch { /* ignore */ }
}

// ── Network ────────────────────────────────────────────────────────────────────

export async function getNetworkStatus() {
  try {
    return await Network.getStatus();
  } catch {
    return { connected: true, connectionType: 'unknown' as const };
  }
}
