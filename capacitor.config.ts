import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.henry.ai',
  appName: 'Henry AI',
  webDir: 'dist',

  server: {
    androidScheme: 'https',
    // To load the live deployed web app instead of bundled assets
    // (enables instant OTA updates without App Store re-submission):
    // url: 'https://your-deployed-henry-url.replit.app',
    // cleartext: false,
  },

  ios: {
    contentInset: 'always',
    preferredContentMode: 'mobile',
    backgroundColor: '#0a0a12',
    minVersion: '14.0',
  } as CapacitorConfig['ios'],

  android: {
    backgroundColor: '#0a0a12',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },

  plugins: {
    Camera: {
      permissions: ['camera', 'photos'],
    },
    SplashScreen: {
      launchShowDuration: 1800,
      launchAutoHide: false,
      backgroundColor: '#0a0a12',
      iosSpinnerStyle: 'small',
      spinnerColor: '#6366f1',
      showSpinner: true,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0a0a12',
    },
    Keyboard: {
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_henry',
      iconColor: '#6366f1',
      sound: 'default',
    },
    SpeechRecognition: {
      language: 'en-US',
    },
  },
};

export default config;
