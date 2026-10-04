// Copyright Epic Games, Inc. All Rights Reserved.
import crypto from 'crypto';
import { generateInviteCode, hashToken } from './passwords';
import { AuthStore, IInviteRecord, IUserRecord, UserRole } from './store';

/** Usernames are lowercased handles: letters, digits, dot, dash, underscore. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const MAX_INVITE_DAYS = 90;

export interface IIssueInviteInput {
    username: string;
    label: string;
    role: UserRole;
    /** Lifetime of the link in days. */
    days: number;
    /** Username of whoever asked for it, for the audit trail. */
    createdBy: string;
    /**
     * `create` refuses a name that already has a password. `reset` is for an existing
     * account, where having a password is the whole point.
     */
    mode?: 'create' | 'reset';
}

export type IIssueInviteError = 'username-invalid' | 'username-taken' | 'user-disabled';

export type IIssueInviteOutcome =
    | { ok: true; invite: IInviteRecord; user: IUserRecord; code: string }
    | { ok: false; error: IIssueInviteError };

/**
 * Creates (or re-arms) an account and issues a single-use invite for it.
 *
 * The account exists from the moment the invite is issued, without a password, so the
 * admin page can show who is expected and so the invite is bound to a role. Any earlier
 * link for the same account is revoked, so only one can ever be outstanding.
 */
export function issueInvite(store: AuthStore, input: IIssueInviteInput): IIssueInviteOutcome {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
        return { ok: false, error: 'username-invalid' };
    }

    const mode = input.mode ?? 'create';
    const now = new Date();
    let user = store.findUserByName(username);
    let role = input.role;

    if (user) {
        if (mode === 'create') {
            if (user.passwordHash) {
                return { ok: false, error: 'username-taken' };
            }
            store.updateUser(user.id, { role, disabled: false });
        } else {
            if (user.disabled) {
                // A link for a disabled account would fail at redemption, so say so now.
                return { ok: false, error: 'user-disabled' };
            }
            // A reset re-arms the existing account; it must not change the role.
            role = user.role;
        }
    } else {
        user = {
            id: crypto.randomUUID(),
            username,
            displayName: username,
            role,
            passwordHash: null,
            disabled: false,
            createdAt: now.toISOString(),
            lastLoginAt: null,
            createdBy: input.createdBy
        };
        store.addUser(user);
    }

    store.revokeInvitesForUser(user.id, now);

    const code = generateInviteCode();
    const invite: IInviteRecord = {
        id: crypto.randomUUID(),
        codeHash: hashToken(code),
        code,
        label: input.label.trim().slice(0, 80),
        role,
        userId: user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000).toISOString(),
        createdBy: input.createdBy,
        usedAt: null,
        usedIp: null,
        revokedAt: null
    };
    store.addInvite(invite);
    return { ok: true, invite, user, code };
}

/** Builds the absolute link an invitee opens. */
export function inviteUrl(baseUrl: string, code: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    return base.length > 0 ? `${base}/invite/${code}` : `/invite/${code}`;
}
