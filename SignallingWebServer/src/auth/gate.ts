// Copyright Epic Games, Inc. All Rights Reserved.
import { IncomingMessage } from 'http';
import { Request, RequestHandler, Response } from 'express';
import { SessionManager } from './sessions';
import { IAuthLogger, safeRedirectPath } from './util';

export interface IAuthGateOptions {
    sessions: SessionManager;
    logger: IAuthLogger;
}

/**
 * Paths that are answered with a JSON 401 rather than a redirect. Scripts fetch these
 * (the grid polls `/snapshots`), and a 302 to an HTML sign-in page would be reported as
 * a successful response with unusable contents.
 */
const API_PATHS = ['/snapshots', '/api-definition', '/api'];

function isApiPath(pathname: string): boolean {
    for (const prefix of API_PATHS) {
        if (pathname === prefix || pathname.indexOf(`${prefix}/`) === 0) {
            return true;
        }
    }
    return false;
}

/** True for requests where a document body is the expected reply. */
function isDocumentRequest(req: Request): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return false;
    }
    const pathname = req.path;
    const lastSlash = pathname.lastIndexOf('/');
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot <= lastSlash) {
        return true;
    }
    return pathname.slice(lastDot).toLowerCase() === '.html';
}

/**
 * Forces `Cache-Control: no-store` even if a later handler tries to set something else.
 *
 * This is needed because `express.static` unconditionally writes its own Cache-Control
 * header, so setting the header here would be overwritten by the static handler. Only
 * applied to documents: scripts, styles and snapshot images keep normal caching, since
 * those are the same for every signed-in visitor and revalidating them on each request
 * would only add load.
 */
function forceNoStore(res: Response): void {
    const original = res.setHeader.bind(res);
    res.setHeader = (name: string, value: number | string | ReadonlyArray<string>): Response => {
        if (name.toLowerCase() === 'cache-control') {
            return original(name, 'no-store');
        }
        return original(name, value);
    };
}

/**
 * Attaches the signed-in user to the request when a valid session cookie is present.
 *
 * Mounted before the auth router, because the router needs `req.user` to render the
 * account and admin pages; enforcement is the separate `requireAuth` middleware.
 */
export function resolveSession(sessions: SessionManager): RequestHandler {
    return (req, _res, next) => {
        const token = sessions.tokenFromCookieHeader(req.headers.cookie);
        const context = sessions.resolve(token);
        if (context) {
            req.user = context.user;
            req.authSession = context.session;
            req.sessionToken = context.token;
        }
        next();
    };
}

/**
 * The gate itself. Everything mounted after this only runs for a signed-in visitor.
 */
export function requireAuth(options: IAuthGateOptions): RequestHandler {
    const { sessions, logger } = options;
    return (req, res, next) => {
        if (req.user) {
            // The reply depends on the cookie, and documents must not be replayable from
            // a browser cache after signing out on a shared machine.
            res.setHeader('Vary', 'Cookie');
            if (isDocumentRequest(req)) {
                forceNoStore(res);
            }
            next();
            return;
        }

        if (isApiPath(req.path)) {
            res.status(401).json({ error: 'unauthorized', signIn: '/login' });
            return;
        }

        const accept = req.headers.accept;
        if (typeof accept === 'string' && accept.indexOf('application/json') >= 0) {
            res.status(401).json({ error: 'unauthorized', signIn: '/login' });
            return;
        }

        const next_ = safeRedirectPath(req.originalUrl, '/');
        const token = sessions.tokenFromCookieHeader(req.headers.cookie);
        if (token) {
            // A cookie was presented but is not usable any more: say so rather than
            // silently showing the sign-in page as if nothing had happened.
            logger.info(`Rejected stale session cookie for ${req.path}`);
        }
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(303, `/login?next=${encodeURIComponent(next_)}`);
    };
}

/** The handshake info `ws` passes to `verifyClient`. */
export interface IWebSocketClientInfo {
    origin: string;
    secure: boolean;
    req: IncomingMessage;
}

/**
 * Gate for the player websocket.
 *
 * The websocket upgrade never reaches express, so static file protection alone would
 * leave the stream itself open to a script that connects directly to the player port.
 * `verifyClient` runs during the handshake, where the request headers (and therefore the
 * session cookie) are available.
 */
export function createVerifyClient(
    sessions: SessionManager,
    logger: IAuthLogger
): (
    info: IWebSocketClientInfo,
    callback: (allowed: boolean, code?: number, message?: string) => void
) => void {
    return (info, callback) => {
        const token = sessions.tokenFromCookieHeader(info.req.headers.cookie);
        if (sessions.resolve(token)) {
            callback(true);
            return;
        }
        const address = info.req.socket.remoteAddress ?? 'unknown';
        logger.warn(`Refused player websocket connection from ${address}: no valid session`);
        callback(false, 401, 'Unauthorized');
    };
}
