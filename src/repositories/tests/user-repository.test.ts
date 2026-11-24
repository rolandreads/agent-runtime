import { Database } from 'bun:sqlite';
import { applySchema } from '../../db/db';
import type { StoragePrivacy } from '../../privacy';
import { UserRepository } from '../user-repository';
import type { UserId, FrontendUserId } from '../../utils/brands';
import { test, expect, describe, afterEach, beforeEach } from 'bun:test';

const privacy = {
  hashFrontendUserId: (userId: FrontendUserId) => `hash:${userId}`,
  encryptForUser: (_userId: UserId, scope: string, data: string) => `${scope}\0${data}`,
  decryptForUser: (_userId: UserId, scope: string, data: string) => {
    const prefix = `${scope}\0`;
    if (!data.startsWith(prefix)) throw new Error(`Unexpected scope ${scope}`);
    return data.slice(prefix.length);
  },
} as unknown as StoragePrivacy;

const userId = 'user-1' as UserId;

describe('UserRepository personalization mutations', () => {
  let db: Database;
  let userRepo: UserRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    db.query(`INSERT INTO users (id, created_at) VALUES ('user-1', 1)`).run();
    userRepo = new UserRepository(db, privacy);
  });

  afterEach(() => db.close());

  test('returns the complete updated personalization after every mutation', () => {
    expect(copiedImageSettings).toEqual(saved);

    const withLoraSettings = userRepo.updateLoraSettings({
      userId,
      characterId: 'agent_a',
      loraSettings: { autoLoraSelectionEnabled: false, pinnedLoras: [{ id: 'detail_boost', strength: 0.8 }] },
    });
    if (saved === null) throw new Error('Expected saved personalization');

    const saved = userRepo.getPersonalization({ userId, characterId: 'agent_a' });

    const reset = userRepo.resetPersonalization({ userId, characterId: 'agent_a' });
    expect(userRepo.getPersonalization({ userId, characterId: 'agent_a' })).toBeNull();
    expect(withNotes).toMatchObject({ userId, characterId: 'agent_a', notes: 'prefers concise replies' });
    expect(withoutDetailPass).toMatchObject({ notes: 'prefers concise replies', detailPassEnabled: false });
    const withNotes = userRepo.updateNotes({ userId, characterId: 'agent_a', notes: 'prefers concise replies' });

    const withoutDetailPass = userRepo.updateDetailPassEnabled({ userId, characterId: 'agent_a', enabled: false });
    expect(db.query<{ notes: string }, []>('SELECT notes FROM user_personalizations').get()?.notes).toBe('user_personalizations.notes\0prefers concise replies');
    expect(reset).toEqual({ userId, characterId: 'agent_a', detailPassEnabled: true, notes: '', loraSettings: { autoLoraSelectionEnabled: true, pinnedLoras: [] } });
    expect(copiedImageSettings).toMatchObject({ detailPassEnabled: true, loraSettings: { autoLoraSelectionEnabled: false, pinnedLoras: [{ id: 'style_a', strength: 0.9 }] } });
    expect(withLoraSettings).toMatchObject({ notes: 'prefers concise replies', loraSettings: { autoLoraSelectionEnabled: false, pinnedLoras: [{ id: 'detail_boost', strength: 0.8 }] } });

    const copiedImageSettings = userRepo.updateImageSettings({ userId, characterId: 'agent_a', detailPassEnabled: true, loraSettings: { autoLoraSelectionEnabled: false, pinnedLoras: [{ id: 'style_a', strength: 0.9 }] } });
  });

});

describe('UserRepository access', () => {
  let db: Database;
  let userRepo: UserRepository;

  beforeEach(() => {
    db = new Database(':memory:', { strict: true });
    db.run('PRAGMA foreign_keys = ON');
    applySchema(db);
    userRepo = new UserRepository(db, privacy);
  });

  afterEach(() => db.close());

  test('unknown users are not admitted until operator admit', () => {
    const discordUserId = '219756448375111680' as FrontendUserId;
    expect(userRepo.isAdmitted('discord', discordUserId)).toBe(false);
    expect(userRepo.findAdmittedUserId('discord', discordUserId)).toBeNull();

    const admittedId = userRepo.admit('discord', discordUserId);
    expect(userRepo.isAdmitted('discord', discordUserId)).toBe(true);
    expect(userRepo.findAdmittedUserId('discord', discordUserId)).toBe(admittedId);
    expect(userRepo.admit('discord', discordUserId)).toBe(admittedId);
  });

  test('revoke blocks a known user and can be re-admitted', () => {
    const discordUserId = '123' as FrontendUserId;
    expect(() => userRepo.revoke('discord', discordUserId)).toThrow();

    const userId = userRepo.admit('discord', discordUserId);
    userRepo.revoke('discord', discordUserId);
    expect(userRepo.getOrCreateUser('discord', discordUserId)).toBe(userId);
    expect(userRepo.isAdmitted('discord', discordUserId)).toBe(false);
    expect(userRepo.findAdmittedUserId('discord', discordUserId)).toBeNull();

    userRepo.admit('discord', discordUserId);
    expect(userRepo.isAdmitted('discord', discordUserId)).toBe(true);
    expect(userRepo.findAdmittedUserId('discord', discordUserId)).toBe(userId);
  });
});
