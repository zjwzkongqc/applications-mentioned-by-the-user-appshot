import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const clubs = sqliteTable('clubs', {
  id: text('id').primaryKey(), inviteHash: text('invite_hash').notNull(),
  name: text('name').notNull(), slogan: text('slogan').notNull(), ownerId: text('owner_id').notNull(), createdAt: text('created_at').notNull()
}, t => [uniqueIndex('idx_clubs_invite_hash').on(t.inviteHash)]);
export const members = sqliteTable('members', {
  id: text('id').primaryKey(), clubId: text('club_id').notNull().references(() => clubs.id),
  sessionHash: text('session_hash').notNull(), nickname: text('nickname').notNull(),
  avatarKey: text('avatar_key'), bio: text('bio').notNull(), createdAt: text('created_at').notNull()
}, t => [index('idx_members_club').on(t.clubId), uniqueIndex('idx_members_club_session').on(t.clubId, t.sessionHash)]);
export const records = sqliteTable('records', {
  id: text('id').primaryKey(), clubId: text('club_id').notNull().references(() => clubs.id),
  memberId: text('member_id').notNull().references(() => members.id),
  playDate: text('play_date').notNull(), minutes: integer('minutes').notNull(),
  partners: text('partners').notNull(), venue: text('venue').notNull(),
  mood: text('mood').notNull(), note: text('note').notNull(), createdAt: text('created_at').notNull(),
  forehand: integer('forehand'), backhand: integer('backhand'), serve: integer('serve'),
  returnSkill: integer('return_skill'), net: integer('net'), footwork: integer('footwork'),
  trainingProjects: text('training_projects').notNull().default('[]'),
  trainingContent: text('training_content').notNull().default(''),
  trainingEffect: text('training_effect').notNull().default(''),
  effectNote: text('effect_note').notNull().default(''), nextPlan: text('next_plan').notNull().default('')
}, t => [index('idx_records_club_date').on(t.clubId, t.playDate), index('idx_records_member').on(t.memberId)]);
export const culture = sqliteTable('culture', {
  id: text('id').primaryKey(), clubId: text('club_id').notNull().references(() => clubs.id),
  memberId: text('member_id').notNull().references(() => members.id),
  content: text('content').notNull(), createdAt: text('created_at').notNull()
}, t => [index('idx_culture_club').on(t.clubId)]);
export const cheers = sqliteTable('cheers', {
  recordId: text('record_id').notNull().references(() => records.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull().references(() => members.id),
  emoji: text('emoji').notNull()
}, t => [uniqueIndex('idx_cheers_record_member').on(t.recordId,t.memberId)]);
export const checkins = sqliteTable('checkins', {
  id: text('id').primaryKey(), clubId: text('club_id').notNull().references(() => clubs.id),
  memberId: text('member_id').notNull().references(() => members.id),
  checkinDate: text('checkin_date').notNull(), createdAt: text('created_at').notNull()
}, t => [uniqueIndex('idx_checkins_member_date').on(t.memberId,t.checkinDate),index('idx_checkins_club_date').on(t.clubId,t.checkinDate)]);
