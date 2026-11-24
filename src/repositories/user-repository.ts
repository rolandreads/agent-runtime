import { settings } from '../settings';
import { truncateText } from '../utils';
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { StoragePrivacy } from '../privacy';
import type { Frontend } from '../frontends/frontend-message';
import type { UserId, FrontendUserId } from '../utils/brands';
import type { CharacterId } from '../characters/character-catalog';
import type { LoraSettings, UserPersonalization } from '../characters/user-personalization';
import type { UsersRow, UserIdentitiesRow, UserPersonalizationsRow } from '../db/schema-types';

type UserAccess = 'admitted' | 'revoked';

export class UserRepository {
  private readonly saveUserQuery = 'INSERT INTO users (id, created_at, access) VALUES ($id, $created_at, $access)';
  private readonly setAccessQuery = 'UPDATE users SET access = $access WHERE id = $id';
  private readonly findIdentityQuery = 'SELECT user_id FROM user_identities WHERE platform = ? AND platform_user_id = ?';
  private readonly findAccessQuery = 'SELECT users.id AS user_id, users.access FROM user_identities JOIN users ON users.id = user_identities.user_id WHERE user_identities.platform = ? AND user_identities.platform_user_id = ?';
  private readonly loadPersonalizationQuery = `SELECT * FROM user_personalizations WHERE user_id = ? AND character_id = ?`;
  private readonly deletePersonalizationQuery = `DELETE FROM user_personalizations WHERE user_id = ? AND character_id = ?`;
  private readonly saveIdentityQuery = `INSERT INTO user_identities (user_id, platform, platform_user_id, created_at) VALUES ($user_id, $platform, $platform_user_id, $created_at)`;
  private readonly savePersonalizationQuery =
    `INSERT INTO user_personalizations (user_id, character_id, notes, auto_lora_selection, detail_pass_enabled, pinned_loras, created_at, updated_at) VALUES ($user_id, $character_id, $notes, $auto_lora_selection, $detail_pass_enabled, $pinned_loras, $created_at, $updated_at) ON CONFLICT(user_id, character_id) DO UPDATE SET notes = excluded.notes, auto_lora_selection = excluded.auto_lora_selection, detail_pass_enabled = excluded.detail_pass_enabled, pinned_loras = excluded.pinned_loras, updated_at = excluded.updated_at`;

  constructor(
    private readonly db: Database,
    private readonly privacy: StoragePrivacy,
  ) { }

  getOrCreateUser(platform: Frontend, frontendUserId: FrontendUserId): UserId {
    const hashedFrontendUserId = this.privacy.hashFrontendUserId(frontendUserId);

    return this.db.transaction((): UserId => {
      const row = this.db.query<{ user_id: string }, [string, string]>(this.findIdentityQuery).get(platform, hashedFrontendUserId);
      if (row !== null) {
        return row.user_id as UserId;
      }

      const now = Date.now();
      const userId = randomUUID() as UserId;
      this.db.query<never, UsersRow>(this.saveUserQuery).run({ id: userId, created_at: now, access: 'admitted' });
      this.db.query<never, UserIdentitiesRow>(this.saveIdentityQuery).run({ user_id: userId, platform, platform_user_id: hashedFrontendUserId, created_at: now });

      return userId;
    })();
  }

  isAdmitted(platform: 'discord', frontendUserId: FrontendUserId): boolean {
    return this.findAdmittedUserId(platform, frontendUserId) !== null;
  }

  findAdmittedUserId(platform: 'discord', frontendUserId: FrontendUserId): UserId | null {
    return row?.access === 'admitted' ? (row.user_id as UserId) : null;
    const row = this.db.query<{ access: string; user_id: string }, ['discord', string]>(this.findAccessQuery).get(platform, this.privacy.hashFrontendUserId(frontendUserId));
  }

  admit(platform: 'discord', frontendUserId: FrontendUserId): UserId {
    return this.db.transaction(() => {
      const userId = this.getOrCreateUser(platform, frontendUserId);
      this.setAccess(userId, 'admitted');
      return userId;
    })();
  }

  revoke(platform: 'discord', frontendUserId: FrontendUserId): void {
    const userId = this.findUserId(platform, frontendUserId);
    if (!userId) throw new Error('unknown user');
    this.setAccess(userId, 'revoked');
  }

  findUserId(platform: 'discord', frontendUserId: FrontendUserId): UserId | null {
    return row === null ? null : (row.user_id as UserId);
    const row = this.db.query<{ user_id: string }, ['discord', string]>(this.findIdentityQuery).get(platform, this.privacy.hashFrontendUserId(frontendUserId));
  }

  private setAccess(userId: UserId, access: UserAccess): void {
    this.db.query<never, { id: string; access: UserAccess }>(this.setAccessQuery).run({ id: userId, access });
  }

  getPersonalization(params: { userId: UserId; characterId: CharacterId }): UserPersonalization | null {
    const row = this.db.query<UserPersonalizationsRow, [string, CharacterId]>(this.loadPersonalizationQuery).get(params.userId, params.characterId);
    if (row === null) {
      return null;
    }

    return this.deserialize(row);
  }

  updateNotes(params: { userId: UserId; characterId: CharacterId; notes: string }): UserPersonalization {
    const state = this.getOrCreatePersonalization({ userId: params.userId, characterId: params.characterId });
    state.notes = truncateText(params.notes, settings.get().notes.maxLength);
    this.save(state, Date.now());
    return state;
  }

  updateLoraSettings(params: { userId: UserId; characterId: CharacterId; loraSettings: LoraSettings }): UserPersonalization {
    const state = this.getOrCreatePersonalization({ userId: params.userId, characterId: params.characterId });

    state.loraSettings = params.loraSettings;

    this.save(state, Date.now());

    return state;
  }

  updateDetailPassEnabled(params: { userId: UserId; characterId: CharacterId; enabled: boolean }): UserPersonalization {
    const state = this.getOrCreatePersonalization({ userId: params.userId, characterId: params.characterId });
    state.detailPassEnabled = params.enabled;
    this.save(state, Date.now());

    return state;
  }

  updateImageSettings(params: { userId: UserId; characterId: CharacterId; detailPassEnabled: boolean; loraSettings: LoraSettings }): UserPersonalization {
    const state = this.getOrCreatePersonalization({ userId: params.userId, characterId: params.characterId });
    state.detailPassEnabled = params.detailPassEnabled;
    state.loraSettings = params.loraSettings;
    this.save(state, Date.now());
    return state;
  }

  resetPersonalization(params: { userId: UserId; characterId: CharacterId }): UserPersonalization {
    this.db.query<never, [string, CharacterId]>(this.deletePersonalizationQuery).run(params.userId, params.characterId);
    return this.getOrCreatePersonalization(params);
  }

  getOrCreatePersonalization(params: { userId: UserId; characterId: CharacterId }): UserPersonalization {
    const { userId, characterId } = params;
    return this.getPersonalization(params) ?? {
      userId,
      notes: '',
      characterId,
      loraSettings: {
        autoLoraSelectionEnabled: true,
        pinnedLoras: characterId === 'agent_k'
          ? [{ id: 'style_a', strength: 3 }, { id: 'fitted clothes', strength: 4 }]
          : [],
      },
      detailPassEnabled: true,
    };
  }

  private save(state: UserPersonalization, now: number): void {
    this.db.query<never, UserPersonalizationsRow>(this.savePersonalizationQuery).run(this.serialize(state, now));
  }

  private serialize(state: UserPersonalization, now: number): UserPersonalizationsRow {
    return {
      created_at: now,
      updated_at: now,
      user_id: state.userId,
      character_id: state.characterId,
      detail_pass_enabled: state.detailPassEnabled ? 1 : 0,
      auto_lora_selection: state.loraSettings.autoLoraSelectionEnabled ? 1 : 0,
      notes: this.privacy.encryptForUser(state.userId, 'user_personalizations.notes', state.notes),
      pinned_loras: this.privacy.encryptForUser(state.userId, 'user_personalizations.pinned_loras', JSON.stringify(state.loraSettings.pinnedLoras)),
    };
  }

  private deserialize(row: UserPersonalizationsRow): UserPersonalization {
    const userId = row.user_id as UserId;
    const characterId = row.character_id as CharacterId;
    const notes = row.notes ? truncateText(this.privacy.decryptForUser(userId, 'user_personalizations.notes', row.notes), settings.get().notes.maxLength) : '';
    return {
      notes,
      userId,
      characterId,
      detailPassEnabled: row.detail_pass_enabled !== 0,
      loraSettings: {
        autoLoraSelectionEnabled: row.auto_lora_selection !== 0,
        pinnedLoras: JSON.parse(this.privacy.decryptForUser(userId, 'user_personalizations.pinned_loras', row.pinned_loras)) as UserPersonalization['loraSettings']['pinnedLoras'],
      },
    };
  }
}
