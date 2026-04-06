import { atom } from 'jotai';
import { create } from 'zustand';

export interface BotStatus {
  activeSessionCount: number;
  connected: boolean;
  uptime: number | null;
}

export const useBotStatusStore = create<BotStatus>()(() => ({
  connected: false,
  uptime: null,
  activeSessionCount: 0,
}));

export const sidebarOpenAtom = atom(true);
