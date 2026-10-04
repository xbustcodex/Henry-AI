import { create } from 'zustand';
import type {
  AppState,
  ViewType,
  Conversation,
  Message,
  AIProvider,
  EngineStatus,
  Task,
  MemoryFact,
} from '../types';

export const useStore = create<AppState>((set, get) => ({
  // UI
  currentView: 'chat',
  viewHistory: [] as import('../types').ViewType[],
  setupComplete: false,

  // Conversations
  conversations: [],
  activeConversationId: null,
  messages: [],

  // AI
  providers: [],
  settings: {},
  isStreaming: false,
  streamingContent: '',

  // Engines
  companionStatus: { status: 'idle' },
  workerStatus: { status: 'idle' },

  // Tasks
  tasks: [],

  // Memory
  facts: [],

  // ── Actions ──────────────────────────────────────────────

  setCurrentView: (view: ViewType) => set((state) => ({
    viewHistory: state.currentView !== view
      ? [...state.viewHistory.slice(-14), state.currentView]
      : state.viewHistory,
    currentView: view,
  })),

  goBack: () => set((state) => {
    const history = state.viewHistory;
    if (history.length === 0) return state;
    const prev = history[history.length - 1];
    return { currentView: prev, viewHistory: history.slice(0, -1) };
  }),

  setSetupComplete: (complete: boolean) => set({ setupComplete: complete }),

  setConversations: (conversations: Conversation[]) => set({ conversations }),

  setActiveConversation: (id: string | null) => {
    try {
      if (id) localStorage.setItem('henry:active_conversation', id);
      else localStorage.removeItem('henry:active_conversation');
    } catch { /* ignore */ }
    set({ activeConversationId: id });
  },

  setMessages: (messages: Message[]) => set({ messages }),

  addMessage: (message: Message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  updateMessage: (id: string, updates: Partial<Message>) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),

  setProviders: (providers: AIProvider[]) => set({ providers }),

  updateSetting: (key: string, value: string) =>
    set((state) => ({
      settings: { ...state.settings, [key]: value },
    })),

  setIsStreaming: (isStreaming: boolean) => set({ isStreaming }),

  setStreamingContent: (streamingContent: string) => set({ streamingContent }),

  appendStreamingContent: (chunk: string) =>
    set((state) => ({
      streamingContent: state.streamingContent + chunk,
    })),

  setCompanionStatus: (status: Partial<EngineStatus>) =>
    set((state) => ({
      companionStatus: { ...state.companionStatus, ...status },
    })),

  setWorkerStatus: (status: Partial<EngineStatus>) =>
    set((state) => ({
      workerStatus: { ...state.workerStatus, ...status },
    })),

  setTasks: (tasks: Task[]) => set({ tasks }),

  addTask: (task: Task) =>
    set((state) => ({ tasks: [task, ...state.tasks] })),

  updateTask: (id: string, updates: Partial<Task>) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

  setFacts: (facts: MemoryFact[]) => set({ facts }),

  addFact: (fact: MemoryFact) =>
    set((state) => ({ facts: [fact, ...state.facts] })),
}));
