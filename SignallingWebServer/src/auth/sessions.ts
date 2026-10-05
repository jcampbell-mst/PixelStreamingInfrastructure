// Copyright Epic Games, Inc. All Rights Reserved.
import crypto from 'crypto';
import { Response } from 'express';
import { AuthStore, ISessionRecord, IUserRecord } from './store';
import { hashToken, randomToken, safeEqual } from './passwords';

export interface ISessionContext {
    user: IUserRecord;
    session: ISessionRecord;
    /** The raw cookie value for this session. */
    token: string;
    /**
     * True when this request moved the rolling deadline, in which case the caller has
     * to re-send the cookie so the browser's own copy of it moves too.
     */
    refreshed: boolean;
}

export interface ISessionManagerOptions {
    cookieName: string;
    /**
     * Session lifetime in days, refreshed on use. Zero (the default) means a sign-in
     * does not lapse at all: it stays valid until the user signs out, changes their
     * password, or an admin ends it.
     */
    days: number;
    /** How often the "last seen" stamp is written back to disk. */
    touchIntervalMs: number;
}

export interface ISessionOrigin {
    ip: string;
    userAgent: string;
}

const DEFAULT_OPTIONS: ISessionManagerOptions = {
    cookieName: 'ps_session',
    days: 0,
    touchIntervalMs: 60 * 1000
};

/**
 * Lifetime asked of the browser for a session that does not lapse.
 *
 * A cookie cannot be truly permanent, and Chrome silently caps any lifetime at 400
 * days, so this is the longest deadline that survives. It is re-sent every time the
 * session is used, which keeps moving the deadline for anyone who keeps visiting; only
 * a visitor who is away for more than a year has to sign in again.
 */
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Server side sessions.
 *
 * Only a hash of the session token is stored, so the store file cannot be replayed as
 * a login, and logout or revocation is immediate because validity is decided here on
 * every request rather than by the client holding a signed token.
 */
export class SessionManager {
    private readonly store: AuthStore;
    private readonly options: ISessionManagerOptions;

    public constructor(store: AuthStore, options: Partial<ISessionManagerOptions> = {}) {
        this.store = store;
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    public get cookieName(): string {
        return this.options.cookieName;
    }

    /** Configured lifetime in days. Zero means sign-ins do not lapse. */
    public get days(): number {
        return this.options.days;
    }

    /** True when sessions are kept until they are ended rather than until they lapse. */
    public get permanent(): boolean {
        return !(this.options.days > 0);
    }

    public get lifetimeMs(): number {
        return this.options.days * 24 * 60 * 60 * 1000;
    }

    /**
     * The deadline for a session issued now.
     *
     * Null marks a session with no deadline. Storing that in the record rather than a
     * far-future date keeps the store honest about what it means, and lets an install
     * that switches to a finite lifetime still expire the sessions it already has.
     */
    private expiryFrom(now: Date): string | null {
        return this.permanent ? null : new Date(now.getTime() + this.lifetimeMs).toISOString();
    }

    /** Issues a new session and returns the raw token to put in the cookie. */
    public create(user: IUserRecord, origin: ISessionOrigin): { token: string; record: ISessionRecord } {
        const now = new Date();
        const token = randomToken(32);
        const record: ISessionRecord = {
            id: hashToken(token),
            userId: user.id,
            createdAt: now.toISOString(),
            expiresAt: this.expiryFrom(now),
            lastSeenAt: now.toISOString(),
            ip: origin.ip,
            userAgent: origin.userAgent.slice(0, 200)
        };
        this.store.addSession(record);
        return { token, record };
    }

    /**
     * Resolves a cookie token to a live session, or null.
     *
     * Synchronous on purpose: the websocket handshake handler cannot wait on the
     * event loop, and everything needed here is already in memory.
     */
    public resolve(token: string | undefined): ISessionContext | null {
        if (!token || token.length < 16 || token.length > 128) {
            return null;
        }

        const record = this.store.findSession(hashToken(token));
        if (!record) {
            return null;
        }

        const now = new Date();
        if (record.expiresAt !== null && record.expiresAt <= now.toISOString()) {
            this.store.removeSession(record.id);
            return null;
        }

        const user = this.store.findUserById(record.userId);
        if (!user || user.disabled || !user.passwordHash) {
            // Disabling an account or clearing its password ends its sessions at once.
            this.store.removeSession(record.id);
            return null;
        }

        const refreshed = this.touch(record, now);
        return { user, session: record, token, refreshed };
    }

    /**
     * Refreshes the rolling expiry, writing back to disk at most once per interval so
     * that ordinary page loads do not hammer the store file. Returns whether anything
     * was actually written.
     */
    private touch(record: ISessionRecord, now: Date): boolean {
        const lastSeenMs = new Date(record.lastSeenAt).getTime();
        if (now.getTime() - lastSeenMs < this.options.touchIntervalMs) {
            return false;
        }
        record.lastSeenAt = now.toISOString();
        record.expiresAt = this.expiryFrom(now);
        this.store.saveSoon();
        return true;
    }

    public revoke(token: string): void {
        this.store.removeSession(hashToken(token));
    }

    public revokeAllForUser(userId: string): number {
        return this.store.removeSessionsForUser(userId);
    }

    /**
     * CSRF token for a session. Derived from a server held secret and the session
     * token, so it needs no storage, cannot be produced without a session, and is
     * stable for that session (which keeps multiple open tabs working).
     */
    public csrfToken(token: string): string {
        return crypto.createHmac('sha256', this.store.csrfSecret).update(token).digest('base64url');
    }

    public verifyCsrfToken(token: string, presented: unknown): boolean {
        if (typeof presented !== 'string' || presented.length === 0) {
            return false;
        }
        return safeEqual(this.csrfToken(token), presented);
    }

    /** Serialises a Set-Cookie value for a session. */
    public cookieHeader(token: string, secure: boolean): string {
        const maxAge = this.permanent ? MAX_COOKIE_AGE_SECONDS : Math.floor(this.lifetimeMs / 1000);
        const attributes = [
            `${this.options.cookieName}=${token}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${maxAge}`
        ];
        if (secure) {
            attributes.push('Secure');
        }
        return attributes.join('; ');
    }

    /** Serialises a Set-Cookie value that removes the session cookie. */
    public clearCookieHeader(secure: boolean): string {
        const attributes = [`${this.options.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
        if (secure) {
            attributes.push('Secure');
        }
        return attributes.join('; ');
    }

    /** Reads the session token out of a raw Cookie header. */
    public tokenFromCookieHeader(header: string | undefined): string | undefined {
        if (!header) {
            return undefined;
        }
        return SessionManager.parseCookies(header)[this.options.cookieName];
    }

    /** Minimal cookie header parser; express 4 has no built in one. */
    public static parseCookies(header: string): Record<string, string> {
        const cookies: Record<string, string> = {};
        const parts = header.split(';');
        for (const part of parts) {
            const separator = part.indexOf('=');
            if (separator <= 0) {
                continue;
            }
            const name = part.slice(0, separator).trim();
            if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) {
                continue;
            }
            cookies[name] = part.slice(separator + 1).trim();
        }
        return cookies;
    }

    /** Appends a Set-Cookie value without discarding any already set on the response. */
    public static appendCookie(res: Response, value: string): void {
        const existing = res.getHeader('Set-Cookie');
        if (!existing) {
            res.setHeader('Set-Cookie', [value]);
        } else if (Array.isArray(existing)) {
            res.setHeader('Set-Cookie', existing.concat([value]));
        } else {
            res.setHeader('Set-Cookie', [String(existing), value]);
        }
    }
}
