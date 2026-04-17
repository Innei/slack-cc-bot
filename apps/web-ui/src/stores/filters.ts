import { atom } from 'jotai';

export const repoFilterAtom = atom<string | undefined>(undefined);
export const memoryQueryAtom = atom<string>('');
export const memoryCategoryAtom = atom<string | undefined>(undefined);
