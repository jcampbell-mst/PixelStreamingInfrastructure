// Copyright Epic Games, Inc. All Rights Reserved.
import express, { Request, Response, Router } from 'express';
import { createLimiters, IAuthLimiters } from './ratelimit';
import { IInviteRecord, IUserRecord, inviteStatus, AuthStore } from './store';
import { MAX_INVITE_DAYS, inviteUrl, issueInvite } from './invites';
import { SessionManager } from './sessions';
import { checkPasswordPolicy, hashPassword, hashToken, verifyPassword } from './passwords';
import {
    IAdminPageOptions,
    IPageContext,
    renderAccountPage,
    renderAdminPage,
    renderInfoPage,
    renderInvitePage,
    renderLoginPage
} from './pages';
import { IAuthLogger, clientIp, isSecureRequest, safeRedirectPath } from './util';

export interface IAuthRoutesOptions {
    store: AuthStore;
    sessions: SessionManager;
    pageContext: IPageContext;
    logger: IAuthLogger;
    /** Lifetime of a freshly issued invite, in days. */
    inviteDays: number;
    limiters?: IAuthLimiters;
}

/** Messages a redirect can carry, so nothing user supplied is ever reflected. */
const OK_MESSAGES: Record<string, string> = {
    'invite-revoked': 'Invite revoked.',
    disabled: 'Account disabled. Any sessions it had are already gone.',
    enabled: 'Account enabled.',
    'signed-out': 'All sessions for that account were ended.',
    deleted: 'Account deleted.',
    'session-ended': 'Session ended.',
    'password-changed': 'Password updated. Other sessions were signed out.'
};

const ERROR_MESSAGES: Record<string, string> = {
    'not-found': 'That account or invite no longer exists.',
    'last-admin': 'That is the last admin who can sign in, so it cannot be disabled or deleted.',
    self: 'You cannot do that to your own account here.',
    'username-taken': 'That username is already in use.',
    'username-invalid': 'Usernames are 3 to 32 characters: letters, digits, dot, dash or underscore.',
    'user-disabled': 'That account is disabled. Enable it before issuing a reset link.',
    csrf: 'That form had expired. Please try again.',
    'rate-limited': 'Too many attempts. Please wait a moment and try again.'
};

/** Reads a form field, tolerating anything that is not a simple string body. */
function formField(req: Request, name: string): string {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) {
        return '';
    }
    const value = body[name];
    return typeof value === 'string' ? value : '';
}

/** Builds the public base URL for invite links, preferring explicit configuration. */
function requestBaseUrl(req: Request, configured: string | undefined): string {
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length === 0) {
        return '';
    }
    return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

type InviteLookup =
    | { ok: true; invite: IInviteRecord }
    | { ok: false; reason: 'invalid' | 'used' | 'expired' | 'revoked' };

/**
 * The authentication surface: sign in, invite redemption, account settings and the
 * admin page.
 *
 * Mounted before the gate, so an unauthenticated visitor can reach exactly these
 * routes and nothing else.
 */
export function createAuthRouter(options: IAuthRoutesOptions): Router {
    const { store, sessions, pageContext, logger } = options;
    const limiters = options.limiters ?? createLimiters();
    const router = express.Router();

    router.use(express.urlencoded({ extended: false, limit: '64kb' }));
    router.use(express.json({ limit: '64kb' }));

    // Nothing here should sit in a cache: these responses are per session.
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    function origin(req: Request): { ip: string; userAgent: string } {
        const agent = req.headers['user-agent'];
        return {
            ip: clientIp(req),
            userAgent: typeof agent === 'string' ? agent : ''
        };
    }

    function requireCsrf(req: Request, res: Response): boolean {
        const token = req.sessionToken ?? '';
        if (!token || !sessions.verifyCsrfToken(token, formField(req, 'csrf'))) {
            logger.warn(`Rejected ${req.method} ${req.path} from ${clientIp(req)}: bad CSRF token`);
            res.status(400).send(
                renderInfoPage(pageContext, {
                    title: 'Form expired',
                    message: 'That form was no longer valid. Reload the page and try again.',
                    linkText: 'Administration',
                    linkHref: '/admin'
                })
            );
            return false;
        }
        return true;
    }

    function redirectWith(res: Response, path: string, kind: 'ok' | 'err' | null, code: string): void {
        const separator = path.indexOf('?') >= 0 ? '&' : '?';
        const query = kind === null ? '' : `${separator}${kind}=${encodeURIComponent(code)}`;
        res.redirect(303, `${path}${query}`);
    }

    function flashFrom(req: Request): { error?: string; notice?: string } {
        const ok = req.query.ok;
        const err = req.query.err;
        return {
            error: typeof err === 'string' ? ERROR_MESSAGES[err] : undefined,
            notice: typeof ok === 'string' ? OK_MESSAGES[ok] : undefined
        };
    }

    function renderAdmin(req: Request, res: Response, extra: Partial<IAdminPageOptions> = {}): void {
        const admin = req.user;
        const now = new Date();
        store.sweep(now);
        res.send(
            renderAdminPage(pageContext, {
                admin: admin as IUserRecord,
                users: store.listUsers(),
                invites: store.listInvites(),
                sessions: store.listSessions(),
                csrf: sessions.csrfToken(req.sessionToken ?? ''),
                baseUrl: requestBaseUrl(req, options.pageContext.baseUrl),
                ...flashFrom(req),
                ...extra
            })
        );
    }

    function findEnabledAdmin(req: Request, res: Response, id: string): IUserRecord | null {
        const target = store.findUserById(id);
        if (!target) {
            redirectWith(res, '/admin', 'err', 'not-found');
            return null;
        }
        if (target.id === req.user?.id) {
            redirectWith(res, '/admin', 'err', 'self');
            return null;
        }
        return target;
    }

    function lookupInvite(code: string): InviteLookup {
        if (!code || code.length > 200) {
            return { ok: false, reason: 'invalid' };
        }
        const invite = store.findInviteByCodeHash(hashToken(code));
        if (!invite) {
            return { ok: false, reason: 'invalid' };
        }
        const status = inviteStatus(invite, new Date());
        if (status === 'pending') {
            return { ok: true, invite };
        }
        return {
            ok: false,
            reason: status === 'used' ? 'used' : status === 'expired' ? 'expired' : 'revoked'
        };
    }

    function inviteProblem(reason: string): string {
        if (reason === 'used') {
            return 'That invite has already been used. Ask an administrator for a new link.';
        }
        if (reason === 'expired') {
            return 'That invite has expired. Ask an administrator for a new one.';
        }
        if (reason === 'revoked') {
            return 'That invite was withdrawn. Ask an administrator for a new one.';
        }
        return 'That invite link is not valid. Check that you copied the whole link.';
    }

    // -- Sign in -------------------------------------------------------------

    router.get('/login', (req, res) => {
        if (req.user) {
            res.redirect(303, safeRedirectPath(req.query.next, '/'));
            return;
        }
        res.send(
            renderLoginPage(pageContext, {
                next: safeRedirectPath(req.query.next, '/'),
                needsSetup: store.listUsers().length === 0,
                error: typeof req.query.err === 'string' ? ERROR_MESSAGES[req.query.err] : undefined
            })
        );
    });

    router.post('/login', async (req, res) => {
        const username = formField(req, 'username').trim().toLowerCase();
        const password = formField(req, 'password');
        const next = safeRedirectPath(formField(req, 'next'), '/');
        const { ip, userAgent } = origin(req);

        const retryAfter = limiters.loginIp.hit(ip) ?? limiters.loginAccount.hit(`${ip}|${username}`);
        if (retryAfter !== null) {
            logger.warn(`Sign-in rate limit hit from ${ip} for "${username}"`);
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).send(
                renderLoginPage(pageContext, {
                    next,
                    needsSetup: false,
                    error: `Too many attempts. Try again in ${retryAfter} seconds.`
                })
            );
            return;
        }

        const user = store.findUserByName(username);
        const allowed = user && !user.disabled ? await verifyPassword(password, user.passwordHash) : false;

        if (!allowed || !user) {
            if (user && !user.passwordHash) {
                logger.warn(`Sign-in attempted for "${username}", whose invite has not been redeemed`);
            } else {
                logger.warn(`Failed sign-in for "${username}" from ${ip}`);
            }
            res.status(401).send(
                renderLoginPage(pageContext, {
                    next,
                    needsSetup: false,
                    error: 'That username and password combination was not recognised.'
                })
            );
            return;
        }

        limiters.loginIp.reset(ip);
        limiters.loginAccount.reset(`${ip}|${username}`);
        const { token } = sessions.create(user, { ip, userAgent });
        store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
        logger.info(`Signed in: ${user.username} from ${ip}`);
        res.setHeader('Set-Cookie', sessions.cookieHeader(token, isSecureRequest(req)));
        res.redirect(303, next);
    });

    router.post('/logout', (req, res) => {
        const token = req.sessionToken;
        if (token && req.user) {
            logger.info(`Signed out: ${req.user.username}`);
            sessions.revoke(token);
        }
        res.setHeader('Set-Cookie', sessions.clearCookieHeader(isSecureRequest(req)));
        res.redirect(303, '/login');
    });

    // -- Invite redemption ---------------------------------------------------

    router.get('/invite/:code', (req, res) => {
        const lookup = lookupInvite(req.params.code);
        if (!lookup.ok) {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Invite not usable',
                    message: inviteProblem(lookup.reason),
                    linkText: 'Sign in',
                    linkHref: '/login'
                })
            );
            return;
        }

        const invite = lookup.invite;
        const user = store.findUserById(invite.userId);
        if (!user || user.disabled) {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Invite not usable',
                    message: user
                        ? 'That account is not active. Ask an administrator to enable it.'
                        : inviteProblem('invalid'),
                    linkText: 'Sign in',
                    linkHref: '/login'
                })
            );
            return;
        }

        // The code is in the URL, so make sure it is never forwarded as a referrer.
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.send(
            renderInvitePage(pageContext, {
                code: req.params.code,
                username: user.username,
                label: invite.label
            })
        );
    });

    router.post('/invite/:code', async (req, res) => {
        const { ip, userAgent } = origin(req);
        const retryAfter = limiters.invite.hit(ip);
        if (retryAfter !== null) {
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).send(
                renderInfoPage(pageContext, {
                    title: 'Too many attempts',
                    message: `Please wait ${retryAfter} seconds and try again.`
                })
            );
            return;
        }

        const lookup = lookupInvite(req.params.code);
        if (!lookup.ok) {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Invite not usable',
                    message: inviteProblem(lookup.reason),
                    linkText: 'Sign in',
                    linkHref: '/login'
                })
            );
            return;
        }

        const invite = lookup.invite;
        const user = store.findUserById(invite.userId);
        if (!user || user.disabled) {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Invite not usable',
                    message: user
                        ? 'That account is not active. Ask an administrator to enable it.'
                        : inviteProblem('invalid')
                })
            );
            return;
        }

        const password = formField(req, 'password');
        const confirm = formField(req, 'confirm');
        const problem =
            checkPasswordPolicy(password, user.username) ??
            (password === confirm ? null : 'The two passwords do not match.');

        if (problem) {
            res.status(400).send(
                renderInvitePage(pageContext, {
                    code: req.params.code,
                    username: user.username,
                    label: invite.label,
                    error: problem
                })
            );
            return;
        }

        const passwordHash = await hashPassword(password);
        const now = new Date();
        store.updateUser(user.id, {
            passwordHash,
            role: invite.role,
            lastLoginAt: now.toISOString()
        });
        // The invite is spent: keep the hash for the audit trail, drop the code itself.
        store.updateInvite(invite.id, { usedAt: now.toISOString(), usedIp: ip, code: null });
        limiters.invite.reset(ip);

        const { token } = sessions.create(user, { ip, userAgent });
        logger.info(`Invite redeemed for ${user.username} from ${ip}`);
        res.setHeader('Set-Cookie', sessions.cookieHeader(token, isSecureRequest(req)));
        res.redirect(303, '/');
    });

    // -- Account -------------------------------------------------------------

    router.get('/account', (req, res) => {
        if (!req.user) {
            res.redirect(303, '/login?next=%2Faccount');
            return;
        }
        res.send(
            renderAccountPage(pageContext, {
                user: req.user,
                csrf: sessions.csrfToken(req.sessionToken ?? ''),
                sessionCount: store.sessionsForUser(req.user.id).length,
                sessionDays: sessions.days,
                ...flashFrom(req)
            })
        );
    });

    // The grid is a static file, so it cannot be rendered with the visitor's name in
    // it and it has no session of its own to read. It asks here instead, and this is
    // also how it learns whether to offer the administration link at all. Nothing is
    // returned for a signed-out caller, which the page treats as "not signed in"
    // rather than as an error.
    router.get('/account/session', (req, res) => {
        const user = req.user;
        if (!user) {
            res.json(null);
            return;
        }
        res.json({ username: user.username, displayName: user.displayName, role: user.role });
    });

    router.post('/account/password', async (req, res) => {
        if (!req.user) {
            res.redirect(303, '/login?next=%2Faccount');
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }

        const user = store.findUserById(req.user.id);
        if (!user) {
            sessions.revoke(req.sessionToken ?? '');
            res.setHeader('Set-Cookie', sessions.clearCookieHeader(isSecureRequest(req)));
            res.redirect(303, '/login');
            return;
        }

        const current = formField(req, 'current');
        const password = formField(req, 'password');
        const confirm = formField(req, 'confirm');
        const { ip } = origin(req);

        const retryAfter = limiters.loginAccount.hit(`${ip}|password-change`);
        if (retryAfter !== null) {
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).send(
                renderAccountPage(pageContext, {
                    user,
                    csrf: sessions.csrfToken(req.sessionToken ?? ''),
                    sessionCount: store.sessionsForUser(user.id).length,
                    sessionDays: sessions.days,
                    error: `Too many attempts. Try again in ${retryAfter} seconds.`
                })
            );
            return;
        }

        if (!(await verifyPassword(current, user.passwordHash))) {
            logger.warn(`Failed password change for ${user.username} from ${ip}`);
            res.status(401).send(
                renderAccountPage(pageContext, {
                    user,
                    csrf: sessions.csrfToken(req.sessionToken ?? ''),
                    sessionCount: store.sessionsForUser(user.id).length,
                    sessionDays: sessions.days,
                    error: 'Your current password was not correct.'
                })
            );
            return;
        }

        const problem =
            checkPasswordPolicy(password, user.username) ??
            (password === confirm ? null : 'The two new passwords do not match.');
        if (problem) {
            res.status(400).send(
                renderAccountPage(pageContext, {
                    user,
                    csrf: sessions.csrfToken(req.sessionToken ?? ''),
                    sessionCount: store.sessionsForUser(user.id).length,
                    sessionDays: sessions.days,
                    error: problem
                })
            );
            return;
        }

        limiters.loginAccount.reset(`${ip}|password-change`);
        store.updateUser(user.id, { passwordHash: await hashPassword(password) });
        // Anyone else holding a session for this account is cut off; this one survives.
        const keep = req.sessionToken ? hashToken(req.sessionToken) : '';
        let ended = 0;
        for (const session of store.sessionsForUser(user.id)) {
            if (session.id !== keep) {
                store.removeSession(session.id);
                ended++;
            }
        }
        logger.info(`Password changed for ${user.username} from ${ip}; ${ended} other session(s) ended`);
        redirectWith(res, '/account', 'ok', 'password-changed');
    });

    // -- Administration ------------------------------------------------------

    router.get('/admin', (req, res) => {
        if (!req.user) {
            res.redirect(303, '/login?next=%2Fadmin');
            return;
        }
        if (req.user.role !== 'admin') {
            // 404 rather than 403: an ordinary member has no reason to know this exists.
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.',
                    linkText: 'Back to the streams',
                    linkHref: '/'
                })
            );
            return;
        }
        renderAdmin(req, res);
    });

    router.post('/admin/invites', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }

        const { ip } = origin(req);
        const retryAfter = limiters.admin.hit(ip);
        if (retryAfter !== null) {
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).send(
                renderInfoPage(pageContext, {
                    title: 'Too many attempts',
                    message: `Please wait ${retryAfter} seconds and try again.`
                })
            );
            return;
        }

        const requestedDays = Number.parseInt(formField(req, 'expires_days'), 10);
        const days =
            Number.isFinite(requestedDays) && requestedDays > 0 && requestedDays <= MAX_INVITE_DAYS
                ? requestedDays
                : options.inviteDays;

        const outcome = issueInvite(store, {
            username: formField(req, 'username'),
            label: formField(req, 'label'),
            role: formField(req, 'role') === 'admin' ? 'admin' : 'user',
            days,
            createdBy: req.user.username
        });

        if (!outcome.ok) {
            renderAdmin(req, res, {
                error: ERROR_MESSAGES[outcome.error] ?? 'That invite could not be created.'
            });
            return;
        }

        const baseUrl = requestBaseUrl(req, options.pageContext.baseUrl);
        logger.info(
            `Invite created for ${outcome.user.username} (${outcome.invite.role}) by ${req.user.username}`
        );
        renderAdmin(req, res, {
            createdInvite: {
                link: inviteUrl(baseUrl, outcome.code),
                label: outcome.user.username,
                expiresAt: outcome.invite.expiresAt
            }
        });
    });

    router.post('/admin/invites/:id/revoke', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }

        const invite = store.findInviteById(req.params.id);
        if (!invite) {
            redirectWith(res, '/admin', 'err', 'not-found');
            return;
        }
        store.updateInvite(invite.id, { revokedAt: new Date().toISOString(), code: null });
        logger.info(`Invite for ${invite.userId} revoked by ${req.user.username}`);
        redirectWith(res, '/admin', 'ok', 'invite-revoked');
    });

    router.post('/admin/users/:id/reset', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }

        const target = store.findUserById(req.params.id);
        if (!target) {
            redirectWith(res, '/admin', 'err', 'not-found');
            return;
        }

        // A reset link is deliberately the same mechanism as an invite: it is a
        // single-use link that sets a new password, which is the only way back in for
        // somebody who has forgotten theirs.
        const outcome = issueInvite(store, {
            username: target.username,
            label: target.displayName,
            role: target.role,
            days: options.inviteDays,
            createdBy: req.user.username,
            mode: 'reset'
        });
        if (!outcome.ok) {
            redirectWith(res, '/admin', 'err', outcome.error);
            return;
        }

        const baseUrl = requestBaseUrl(req, options.pageContext.baseUrl);
        logger.info(`Password reset link issued for ${target.username} by ${req.user.username}`);
        renderAdmin(req, res, {
            createdReset: {
                link: inviteUrl(baseUrl, outcome.code),
                username: target.username,
                expiresAt: outcome.invite.expiresAt
            }
        });
    });

    router.post('/admin/users/:id/disable', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }

        const target = findEnabledAdmin(req, res, req.params.id);
        if (!target) {
            return;
        }
        if (target.role === 'admin' && store.countEnabledAdmins(target.id) === 0) {
            redirectWith(res, '/admin', 'err', 'last-admin');
            return;
        }

        store.updateUser(target.id, { disabled: true });
        // An outstanding invite must not become a way back in for a disabled account.
        store.revokeInvitesForUser(target.id, new Date());
        const ended = sessions.revokeAllForUser(target.id);
        logger.warn(`Account ${target.username} disabled by ${req.user.username}; ${ended} session(s) ended`);
        redirectWith(res, '/admin', 'ok', 'disabled');
    });

    router.post('/admin/users/:id/enable', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }
        const target = store.findUserById(req.params.id);
        if (!target) {
            redirectWith(res, '/admin', 'err', 'not-found');
            return;
        }
        store.updateUser(target.id, { disabled: false });
        logger.info(`Account ${target.username} enabled by ${req.user.username}`);
        redirectWith(res, '/admin', 'ok', 'enabled');
    });

    router.post('/admin/users/:id/signout', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }
        const target = store.findUserById(req.params.id);
        if (!target) {
            redirectWith(res, '/admin', 'err', 'not-found');
            return;
        }
        const ended = sessions.revokeAllForUser(target.id);
        logger.info(`All sessions for ${target.username} ended by ${req.user.username} (${ended})`);
        redirectWith(res, '/admin', 'ok', 'signed-out');
    });

    router.post('/admin/users/:id/delete', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }
        const target = findEnabledAdmin(req, res, req.params.id);
        if (!target) {
            return;
        }
        if (target.role === 'admin' && !target.disabled && store.countEnabledAdmins(target.id) === 0) {
            redirectWith(res, '/admin', 'err', 'last-admin');
            return;
        }
        store.removeUser(target.id);
        logger.warn(`Account ${target.username} deleted by ${req.user.username}`);
        redirectWith(res, '/admin', 'ok', 'deleted');
    });

    router.post('/admin/sessions/:id/revoke', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            res.status(404).send(
                renderInfoPage(pageContext, {
                    title: 'Not found',
                    message: 'There is nothing at this address.'
                })
            );
            return;
        }
        if (!requireCsrf(req, res)) {
            return;
        }

        const session = store.findSession(req.params.id);
        if (!session) {
            redirectWith(res, '/admin', 'err', 'not-found');
            return;
        }
        store.removeSession(session.id);

        if (req.sessionToken && hashToken(req.sessionToken) === session.id) {
            // Ended our own session; the cookie has to go as well.
            res.setHeader('Set-Cookie', sessions.clearCookieHeader(isSecureRequest(req)));
            res.redirect(303, '/login');
            return;
        }
        logger.info(
            `Session ${session.id.slice(0, 8)} of user ${session.userId} ended by ${req.user.username}`
        );
        redirectWith(res, '/admin', 'ok', 'session-ended');
    });

    return router;
}
