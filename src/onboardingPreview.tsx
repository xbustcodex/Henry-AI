import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/globals.css';
import SetupWizard from './components/wizard/SetupWizard';
import { useStore } from './store';

const answers: Record<string, unknown> = {
  platform: () => 'win32',
  getSettings: async () => ({}),
  getProviders: async () => [],
  saveSetting: async () => true,
  saveProvider: async () => ({ ok: true }),
  opencodeStatus: async () => ({ available: false }),
  opencodeModels: async () => ({ ok: true, models: [] }),
  ollamaModels: async () => ({ models: [] }),
  ollamaIsInstalled: async () => ({ installed: false, running: false }),
  checkAccessibility: async () => ({ granted: false }),
  checkScreenRecording: async () => ({ granted: false }),
  syncStart: async () => ({ ok: true }),
  syncGetState: async () => ({}),
  syncGetTunnelUrl: async () => ({ url: null }),
  onCompanionDeviceLinked: () => () => {},
  onCompanionCapture: () => () => {},
  onCompanionPrompt: () => () => {},
  onCompanionActionDecision: () => () => {},
  onAppQuitting: () => () => {},
  computerRunShell: async () => undefined,
};

window.henryAPI = new Proxy(answers as unknown as Window['henryAPI'], {
  get(target, prop: string) {
    if (prop in target) return target[prop as keyof typeof target];
    return () => undefined;
  },
});

useStore.setState({ providers: [], settings: {} });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <SetupWizard onComplete={() => console.log('complete')} />,
);
