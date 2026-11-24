import type { UserId } from '../utils/brands';
import type { CharacterId } from './character-catalog';
import type { LoraConfig } from '../image-assets/image-loras';

export type LoraSettings = {
  pinnedLoras: LoraConfig[];
  autoLoraSelectionEnabled: boolean;
};

export type UserPersonalization = {
  notes: string;
  userId: UserId;
  characterId: CharacterId;
  detailPassEnabled: boolean;
  loraSettings: LoraSettings;
};
