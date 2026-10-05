// Copyright Epic Games, Inc. All Rights Reserved.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Privilege level of an account. Admins can manage users and invites. */
export type UserRole = 'admin' | 'user';

/** Derived state of an invite, computed on read from its timestamps. */
export type InviteStatus = 'pending' | 'used' | 'revoked' | 'expired';

/** Resolves the default location of the auth store file. */
export function defaultStorePath(): string {
    // store.js lives in <package>/dist/auth at runtime, so this lands in <package>/data,
    // deliberately outside `dist/` (wiped by every build) and outside `www/` (wiped by
    // every frontend build).
    return path.resolve(__dirname, '..', '..', 'data', 'auth.json');
}

export interface IUserRecord {
    id: string;
    /** Lowercased handle used to sign in. Unique. */
    username: string;
    /** Free-text name shown in the UI. Defaults to the username. */
    displayName: string;
    role: UserRole;
    /** Null until the account's invite has been redeemed. */
    passwordHash: string | null;
    disabled: boolean;
    createdAt: string;
    lastLoginAt: string | null;
    createdBy: string | null;
}

export interface IInviteRecord {
    id: string;
    /** SHA-256 of the invite code. Always present. */
    codeHash: string;
    /**
     * The code itself, kept only while the invite is pending so the admin page can
     * re-display a link it has already issued. Cleared as soon as the invite is used
     * or revoked, at which point only the hash remains for the audit trail.
     */
    code: string | null;
    label: string;
    role: UserRole;
    /** The account this invite sets a password for. */
    userId: string;
    createdAt: string;
    expiresAt: string;
    createdBy: string;
    usedAt: string | null;
    usedIp: string | null;
    revokedAt: string | null;
}

export interface ISessionRecord {
    /** SHA-256 of the cookie token. The token itself is never stored. */
    id: string;
    userId: string;
    createdAt: string;
    /** Null for a session that does not lapse; see `SessionManager.permanent`. */
    expiresAt: string | null;
    lastSeenAt: string;
    ip: string;
    userAgent: string;
}

interface IAuthFile {
    version: number;
    /** Random per-installation key used to sign CSRF tokens. */
    csrfSecret: string;
    users: IUserRecord[];
    invites: IInviteRecord[];
    sessions: ISessionRecord[];
}

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 1000;
/** Invites that are spent or revoked are kept for this long as an audit trail. */
const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 200;

function emptyFile(): IAuthFile {
    return {
        version: FILE_VERSION,
        csrfSecret: crypto.randomBytes(32).toString('base64url'),
        users: [],
        invites: [],
        sessions: []
    };
}

function asArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asBool(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function asRole(value: unknown): UserRole {
    return value === 'admin' ? 'admin' : 'user';
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * The single source of truth for accounts, invites and sessions.
 *
 * Persistence is a small JSON file written atomically (temp file plus rename), which
 * keeps the zero-native-dependency property of the rest of the server and sidesteps
 * the experimental `node:sqlite` on the deployment host. Sessions are touched on
 * almost every request, so those writes are debounced; anything security relevant
 * (a password being set, an account or session being revoked) is written through
 * immediately.
 */
export class AuthStore {
    private readonly filePath: string;
    private data: IAuthFile = emptyFile();
    private saveTimer: NodeJS.Timeout | null = null;

    public constructor(filePath: string) {
        this.filePath = path.resolve(filePath);
    }

    /** Absolute path of the JSON file backing the store. */
    public get path(): string {
        return this.filePath;
    }

    /** Reads the file, coercing anything unexpected into a safe default. */
    public load(): void {
        if (!fs.existsSync(this.filePath)) {
            this.data = emptyFile();
            return;
        }

        const raw = JSON.parse(fs.readFileSync(this.filePath, { encoding: 'utf8' })) as Record<
            string,
            unknown
        >;
        const users = asArray(raw.users);
        const invites = asArray(raw.invites);
        const sessions = asArray(raw.sessions);

        this.data = {
            version: FILE_VERSION,
            csrfSecret: asString(raw.csrfSecret, '') || crypto.randomBytes(32).toString('base64url'),
            users: users
                .filter((user) => typeof user.id === 'string' && typeof user.username === 'string')
                .map((user) => ({
                    id: user.id as string,
                    username: (user.username as string).toLowerCase(),
                    displayName: asString(user.displayName, user.username as string),
                    role: asRole(user.role),
                    passwordHash: asNullableString(user.passwordHash),
                    disabled: asBool(user.disabled),
                    createdAt: asString(user.createdAt, nowIso()),
                    lastLoginAt: asNullableString(user.lastLoginAt),
                    createdBy: asNullableString(user.createdBy)
                })),
            invites: invites
                .filter((invite) => typeof invite.id === 'string' && typeof invite.codeHash === 'string')
                .map((invite) => ({
                    id: invite.id as string,
                    codeHash: invite.codeHash as string,
                    code: asNullableString(invite.code),
                    label: asString(invite.label, ''),
                    role: asRole(invite.role),
                    userId: asString(invite.userId, ''),
                    createdAt: asString(invite.createdAt, nowIso()),
                    expiresAt: asString(invite.expiresAt, nowIso()),
                    createdBy: asString(invite.createdBy, ''),
                    usedAt: asNullableString(invite.usedAt),
                    usedIp: asNullableString(invite.usedIp),
                    revokedAt: asNullableString(invite.revokedAt)
                })),
            sessions: sessions
                .filter((session) => typeof session.id === 'string' && typeof session.userId === 'string')
                .map((session) => ({
                    id: session.id as string,
                    userId: session.userId as string,
                    createdAt: asString(session.createdAt, nowIso()),
                    // Only an explicit null means "does not lapse". A missing or
                    // non-string deadline falls back to now, which reads as already
                    // expired, so damaged data cannot turn into an eternal session.
                    expiresAt: session.expiresAt === null ? null : asString(session.expiresAt, nowIso()),
                    lastSeenAt: asString(session.lastSeenAt, nowIso()),
                    ip: asString(session.ip, ''),
                    userAgent: asString(session.userAgent, '').slice(0, MAX_USER_AGENT_LENGTH)
                }))
        };
    }

    /** Writes the current state now, cancelling any pending debounced write. */
    public saveNow(): void {
        this.clearTimer();
        this.write();
    }

    /** Writes soon, coalescing bursts of near-simultaneous changes into one write. */
    public saveSoon(): void {
        if (this.saveTimer) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.write();
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref();
    }

    /** Flushes any pending write. Called on shutdown. */
    public flush(): void {
        if (this.saveTimer) {
            this.saveNow();
        }
    }

    private write(): void {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        // 0600 keeps the file readable only by the account running the server.
        fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, this.filePath);
    }

    private clearTimer(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }

    /** Key used to sign CSRF tokens. Stable for the life of the file. */
    public get csrfSecret(): string {
        return this.data.csrfSecret;
    }

    // -- Users ---------------------------------------------------------------

    public listUsers(): IUserRecord[] {
        return this.data.users.slice().sort((a, b) => a.username.localeCompare(b.username));
    }

    public findUserByName(username: string): IUserRecord | undefined {
        const wanted = username.trim().toLowerCase();
        return this.data.users.find((user) => user.username === wanted);
    }

    public findUserById(id: string): IUserRecord | undefined {
        return this.data.users.find((user) => user.id === id);
    }

    /** Number of admins that could still sign in, optionally excluding one account. */
    public countEnabledAdmins(exceptUserId?: string): number {
        return this.data.users.filter(
            (user) => user.role === 'admin' && !user.disabled && user.id !== exceptUserId
        ).length;
    }

    public addUser(record: IUserRecord): void {
        this.data.users.push(record);
        this.saveNow();
    }

    /**
     * Applies a partial update. Security relevant changes are written through
     * immediately; a display name change can wait for the debounced write.
     */
    public updateUser(id: string, patch: Partial<IUserRecord>, immediate = true): IUserRecord | undefined {
        const user = this.findUserById(id);
        if (!user) {
            return undefined;
        }
        Object.assign(user, patch);
        if (immediate) {
            this.saveNow();
        } else {
            this.saveSoon();
        }
        return user;
    }

    /** Removes an account along with its sessions and invites. */
    public removeUser(id: string): void {
        const index = this.data.users.findIndex((user) => user.id === id);
        if (index >= 0) {
            this.data.users.splice(index, 1);
        }
        this.data.sessions = this.data.sessions.filter((session) => session.userId !== id);
        this.data.invites = this.data.invites.filter((invite) => invite.userId !== id);
        this.saveNow();
    }

    // -- Invites -------------------------------------------------------------

    public listInvites(): IInviteRecord[] {
        return this.data.invites.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    public findInviteByCodeHash(codeHash: string): IInviteRecord | undefined {
        return this.data.invites.find((invite) => invite.codeHash === codeHash);
    }

    public findInviteById(id: string): IInviteRecord | undefined {
        return this.data.invites.find((invite) => invite.id === id);
    }

    public findPendingInviteForUser(userId: string): IInviteRecord | undefined {
        return this.data.invites.find(
            (invite) => invite.userId === userId && !invite.usedAt && !invite.revokedAt
        );
    }

    public addInvite(record: IInviteRecord): void {
        this.data.invites.push(record);
        this.saveNow();
    }

    public updateInvite(id: string, patch: Partial<IInviteRecord>): IInviteRecord | undefined {
        const invite = this.findInviteById(id);
        if (!invite) {
            return undefined;
        }
        Object.assign(invite, patch);
        this.saveNow();
        return invite;
    }

    /** Revokes every pending invite belonging to an account. */
    public revokeInvitesForUser(userId: string, now: Date): void {
        let changed = false;
        for (const invite of this.data.invites) {
            if (invite.userId === userId && !invite.usedAt && !invite.revokedAt) {
                invite.revokedAt = now.toISOString();
                invite.code = null;
                changed = true;
            }
        }
        if (changed) {
            this.saveNow();
        }
    }

    // -- Sessions ------------------------------------------------------------

    public listSessions(): ISessionRecord[] {
        return this.data.sessions.slice().sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    }

    public sessionsForUser(userId: string): ISessionRecord[] {
        return this.data.sessions.filter((session) => session.userId === userId);
    }

    public findSession(id: string): ISessionRecord | undefined {
        return this.data.sessions.find((session) => session.id === id);
    }

    public addSession(record: ISessionRecord): void {
        this.data.sessions.push(record);
        this.saveNow();
    }

    public removeSession(id: string): void {
        const index = this.data.sessions.findIndex((session) => session.id === id);
        if (index >= 0) {
            this.data.sessions.splice(index, 1);
            this.saveNow();
        }
    }

    /** Drops every session belonging to an account. Returns how many were removed. */
    public removeSessionsForUser(userId: string): number {
        const before = this.data.sessions.length;
        this.data.sessions = this.data.sessions.filter((session) => session.userId !== userId);
        const removed = before - this.data.sessions.length;
        if (removed > 0) {
            this.saveNow();
        }
        return removed;
    }

    public touchSession(id: string, now: Date): void {
        const session = this.findSession(id);
        if (session) {
            session.lastSeenAt = now.toISOString();
            this.saveSoon();
        }
    }

    /**
     * Drops sessions that have expired, and invites that have been spent or revoked for
     * longer than the retention window. Returns the number of records removed.
     */
    public sweep(now: Date): number {
        const nowIsoValue = now.toISOString();
        const users = this.data.users;
        const sessionsBefore = this.data.sessions.length;
        const invitesBefore = this.data.invites.length;

        this.data.sessions = this.data.sessions.filter((session) => {
            // A null deadline is a session that only ends when it is ended, not a
            // malformed one, so it is never swept for age.
            if (session.expiresAt !== null && session.expiresAt <= nowIsoValue) {
                return false;
            }
            // A session belonging to a deleted account can never be valid again.
            return users.some((user) => user.id === session.userId);
        });

        this.data.invites = this.data.invites.filter((invite) => {
            const finished = invite.usedAt || invite.revokedAt;
            if (!finished) {
                return true;
            }
            return now.getTime() - new Date(finished).getTime() < INVITE_RETENTION_MS;
        });

        return sessionsBefore - this.data.sessions.length + (invitesBefore - this.data.invites.length);
    }
}

/** Derives an invite's display status from its timestamps. */
export function inviteStatus(invite: IInviteRecord, now: Date): InviteStatus {
    if (invite.revokedAt) {
        return 'revoked';
    }
    if (invite.usedAt) {
        return 'used';
    }
    return invite.expiresAt <= now.toISOString() ? 'expired' : 'pending';
}
