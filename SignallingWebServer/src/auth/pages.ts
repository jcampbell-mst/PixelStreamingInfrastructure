// Copyright Epic Games, Inc. All Rights Reserved.
import { IInviteRecord, ISessionRecord, IUserRecord, inviteStatus } from './store';
import { escapeHtml, formatRelative, formatTimestamp } from './util';
import { PASSWORD_MIN_LENGTH } from './passwords';

export interface IPageContext {
    appName: string;
    /** Absolute base URL used to render invite links the admin can hand out. */
    baseUrl: string;
    /** Shown in the admin page's reminder about the unauthenticated streamer port. */
    streamerPort: number;
}

export interface IFlash {
    error?: string;
    notice?: string;
}

/**
 * Pages are rendered from here rather than served out of `www/`, because `www/` is
 * gitignored and rewritten by every frontend build, and because these pages must not
 * be reachable as static files by an unauthenticated visitor.
 *
 * No webfont is requested: the bundled Montserrat lives under `www/`, and pulling a
 * font into the login path would mean leaving an unauthenticated asset exposed for a
 * cosmetic gain. The system stack is used instead.
 */

const CSS = `
:root {
    /* Same studio tokens as the stream grid, so signing in does not feel like a
       different product. */
    --bg: #191715;
    --surface: #211f1c;
    --surface-2: #292724;
    --border: #37332f;
    --border-strong: #47433e;
    --input-bg: #1b1a18;
    --button-bg: #23211f;
    --button-hover: #2e2c28;
    --text: #eeedec;
    --dim: #a59f97;
    --faint: #80796f;
    --accent: #f2332c;
    --accent-soft: rgba(242, 51, 44, 0.22);
    --good: #25e455;
    --warn: #f0a93b;
    --warn-soft: rgba(240, 169, 59, 0.12);
    --radius: 14px;
    --ctl-radius: 10px;
    --bar-grey: #bfbfbf;
    --bar-yellow: #bfbf00;
    --bar-cyan: #00bfbf;
    --bar-green: #00bf00;
    --bar-magenta: #bf00bf;
    --bar-red: #bf0000;
    --bar-blue: #0000bf;
    --bars: linear-gradient(
        90deg,
        var(--bar-grey) 0 14.29%,
        var(--bar-yellow) 0 28.57%,
        var(--bar-cyan) 0 42.86%,
        var(--bar-green) 0 57.14%,
        var(--bar-magenta) 0 71.43%,
        var(--bar-red) 0 85.71%,
        var(--bar-blue) 0 100%
    );
}

@media (prefers-color-scheme: light) {
    :root {
        --bg: #f6f5f3;
        --surface: #fdfcfc;
        --surface-2: #f9f8f6;
        --border: #edebe8;
        --border-strong: #d3cdc5;
        --input-bg: #ffffff;
        --button-bg: #ffffff;
        --button-hover: #f2f0ee;
        --text: #231f1a;
        --dim: #696259;
        --faint: #9c958b;
        --accent-soft: rgba(242, 51, 44, 0.16);
        --warn-soft: rgba(240, 169, 59, 0.16);
    }
}

*, *::before, *::after { box-sizing: border-box; }

body {
    margin: 0;
    min-height: 100vh;
    background-color: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
}

a { color: var(--text); }
a:hover { color: var(--accent); }

.bars { height: 5px; background: var(--bars); }

.shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 20px 48px;
    gap: 18px;
}

.shell.wide { justify-content: flex-start; align-items: stretch; }

.card {
    width: 100%;
    max-width: 400px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
}

.card.wide { max-width: 1080px; }

.card-body { padding: 28px; }

.brand {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 22px;
}

.brand-name {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.02em;
}

.brand-tag {
    color: var(--dim);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
}

h1 { font-size: 18px; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 0 0 4px; }
.lede { color: var(--dim); font-size: 14px; margin: 0 0 22px; }

.field { margin-bottom: 16px; }

label {
    display: block;
    font-size: 13px;
    color: var(--dim);
    margin-bottom: 6px;
}

input[type=text], input[type=password], select {
    width: 100%;
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--ctl-radius);
    color: var(--text);
    font: inherit;
    padding: 10px 12px;
}

input:focus, select:focus, button:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

input[readonly] { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }

button {
    font: inherit;
    color: var(--text);
    background: var(--button-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--ctl-radius);
    padding: 9px 14px;
    cursor: pointer;
}

button:hover { background: var(--button-hover); }

button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
}

button.primary:hover { filter: brightness(1.08); }

button.block { width: 100%; padding: 11px 14px; }

button.tiny { padding: 5px 10px; font-size: 13px; }

button.danger { color: var(--accent); border-color: var(--accent-soft); }

button:disabled { opacity: 0.45; cursor: not-allowed; }

.msg {
    border-radius: var(--ctl-radius);
    padding: 10px 12px;
    font-size: 14px;
    margin-bottom: 18px;
}

.msg.error { background: var(--accent-soft); border: 1px solid var(--accent); }
.msg.notice { background: var(--warn-soft); border: 1px solid var(--warn); color: var(--text); }
.msg.ok { background: rgba(37, 228, 85, 0.12); border: 1px solid var(--good); }

.muted { color: var(--dim); font-size: 13px; }
.faint { color: var(--faint); font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }

code {
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 5px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 13px;
}

.section { border-top: 1px solid var(--border); padding: 22px 28px; }
.section:first-of-type { border-top: none; }
.section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 14px; }

.topbar {
    width: 100%;
    max-width: 1080px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
}

.logout { display: inline; }

table { width: 100%; border-collapse: collapse; font-size: 14px; }

th, td {
    text-align: left;
    padding: 9px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
}

th { color: var(--faint); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }

td.actions { white-space: nowrap; }
td.actions form { display: inline; }

.pill {
    display: inline-block;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    padding: 2px 9px;
    font-size: 12px;
    color: var(--dim);
}

.pill.pending { border-color: var(--warn); color: var(--warn); }
.pill.used { border-color: var(--good); color: var(--good); }
.pill.admin { border-color: var(--accent); color: var(--accent); }
.pill.off { border-color: var(--faint); color: var(--faint); }

.invite-link { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.invite-link input { flex: 1; }

.inline-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.inline-form .field { margin-bottom: 0; }
.inline-form .field.grow { flex: 1; min-width: 220px; }

.foot { color: var(--faint); font-size: 12px; text-align: center; max-width: 520px; }

.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
`;

function layout(title: string, body: string, options: { wide?: boolean } = {}): string {
    const shellClass = options.wide ? 'shell wide' : 'shell';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="${shellClass}">
${body}
</div>
</body>
</html>
`;
}

function messageBlock(flash: IFlash): string {
    let html = '';
    if (flash.error) {
        html += `<div class="msg error" role="alert">${escapeHtml(flash.error)}</div>`;
    }
    if (flash.notice) {
        html += `<div class="msg ok" role="status">${escapeHtml(flash.notice)}</div>`;
    }
    return html;
}

function brandLine(appName: string, tag: string): string {
    return `<div class="brand"><span class="brand-name">${escapeHtml(appName)}</span><span class="brand-tag">${escapeHtml(
        tag
    )}</span></div>`;
}

export interface ILoginPageOptions extends IFlash {
    next: string;
    /** True when no account exists yet, so the page can explain how to create one. */
    needsSetup: boolean;
}

export function renderLoginPage(ctx: IPageContext, options: ILoginPageOptions): string {
    const setup = options.needsSetup
        ? `<div class="msg notice">No accounts exist yet. On the server, run:<br>
<code>node dist/auth/cli.js create-admin &lt;username&gt;</code></div>`
        : '';

    const body = `<div class="card">
<div class="bars"></div>
<div class="card-body">
${brandLine(ctx.appName, 'Members only')}
<h1>Sign in</h1>
<p class="lede">Streams are private. Use the account you set up from your invite.</p>
${setup}
${messageBlock(options)}
<form method="post" action="/login" autocomplete="on">
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<div class="field">
<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required>
</div>
<div class="field">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
</div>
<button class="primary block" type="submit">Sign in</button>
</form>
</div>
</div>
<p class="foot">Access is by invitation. If you need an account, ask an administrator for an invite link.</p>`;

    return layout(`Sign in - ${ctx.appName}`, body);
}

export interface IInvitePageOptions extends IFlash {
    code: string;
    username: string;
    label: string;
}

export function renderInvitePage(ctx: IPageContext, options: IInvitePageOptions): string {
    const body = `<div class="card">
<div class="bars"></div>
<div class="card-body">
${brandLine(ctx.appName, 'Invite')}
<h1>Set your password</h1>
<p class="lede">This link sets the password for <strong>${escapeHtml(
        options.username
    )}</strong> and can only be used once.</p>
${messageBlock(options)}
<form method="post" action="/invite/${escapeHtml(options.code)}" autocomplete="on">
<div class="field">
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
</div>
<div class="field">
<label for="confirm">Repeat password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
</div>
<button class="primary block" type="submit">Set password and sign in</button>
</form>
<div class="muted" style="margin-top:16px">At least ${PASSWORD_MIN_LENGTH} characters. A passphrase of a few
words is both stronger and easier to remember than something short and complicated.</div>
</div>
</div>`;

    return layout(`Set your password - ${ctx.appName}`, body);
}

export interface IInfoPageOptions {
    title: string;
    message: string;
    linkText?: string;
    linkHref?: string;
}

export function renderInfoPage(ctx: IPageContext, options: IInfoPageOptions): string {
    const link =
        options.linkText && options.linkHref
            ? `<p style="margin-bottom:0"><a href="${escapeHtml(options.linkHref)}">${escapeHtml(
                  options.linkText
              )}</a></p>`
            : '';
    const body = `<div class="card">
<div class="bars"></div>
<div class="card-body">
${brandLine(ctx.appName, 'Notice')}
<h1>${escapeHtml(options.title)}</h1>
<p class="lede">${escapeHtml(options.message)}</p>
${link}
</div>
</div>`;
    return layout(`${options.title} - ${ctx.appName}`, body);
}

export interface IAccountPageOptions extends IFlash {
    user: IUserRecord;
    csrf: string;
    sessionCount: number;
}

export function renderAccountPage(ctx: IPageContext, options: IAccountPageOptions): string {
    const body = `<div class="topbar">
${brandLine(ctx.appName, 'Account')}
${options.user.role === 'admin' ? '<a href="/admin">Administration</a>' : ''}
<form class="logout" method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(
        options.csrf
    )}"><button class="tiny" type="submit">Sign out</button></form>
</div>
<div class="card wide" style="max-width:640px">
<div class="bars"></div>
<div class="card-body">
<h1>${escapeHtml(options.user.displayName)}</h1>
<p class="lede">Signed in as <span class="mono">${escapeHtml(options.user.username)}</span> (${escapeHtml(
        options.user.role
    )}). ${options.sessionCount} active session${options.sessionCount === 1 ? '' : 's'} for this account.</p>
${messageBlock(options)}
<h2>Change password</h2>
<form method="post" action="/account/password">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<div class="field">
<label for="current">Current password</label>
<input id="current" name="current" type="password" autocomplete="current-password" required>
</div>
<div class="field">
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
</div>
<div class="field">
<label for="confirm">Repeat new password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
</div>
<button class="primary" type="submit">Update password</button>
<div class="muted" style="margin-top:12px">Changing your password signs out every other session.</div>
</form>
</div>
</div>
<p class="foot">Sessions last 30 days from last use. Signing out ends only this one.</p>`;
    return layout(`Account - ${ctx.appName}`, body, { wide: true });
}
export interface IAdminPageOptions extends IFlash {
    admin: IUserRecord;
    users: IUserRecord[];
    invites: IInviteRecord[];
    sessions: ISessionRecord[];
    csrf: string;
    /** Base URL used to rebuild pending invite links, derived from the request. */
    baseUrl: string;
    /** Invite just created by this request, shown in full because it is never in a URL. */
    createdInvite?: { link: string; label: string; expiresAt: string };
    /** Reset link just created for an existing account. */
    createdReset?: { link: string; username: string; expiresAt: string };
}

function inviteLinkBlock(link: string, caption: string): string {
    return `<div class="invite-link">
<input type="text" readonly spellcheck="false" value="${escapeHtml(
        link
    )}" aria-label="${escapeHtml(caption)}">
</div>`;
}

function renderUserRows(options: IAdminPageOptions): string {
    const csrf = escapeHtml(options.csrf);
    let rows = '';
    for (const user of options.users) {
        const isSelf = user.id === options.admin.id;
        // Disabling or deleting the only admin that can still sign in would lock
        // everybody out, including the person doing it.
        const otherEnabledAdmins = options.users.filter(
            (candidate) => candidate.role === 'admin' && !candidate.disabled && candidate.id !== user.id
        ).length;
        const isLastEnabledAdmin = user.role === 'admin' && !user.disabled && otherEnabledAdmins === 0;
        const sessionCount = options.sessions.filter((session) => session.userId === user.id).length;
        const status = user.disabled
            ? '<span class="pill off">disabled</span>'
            : user.passwordHash
              ? '<span class="pill used">active</span>'
              : '<span class="pill pending">invite pending</span>';

        const resetButton = `<form method="post" action="/admin/users/${escapeHtml(
            user.id
        )}/reset"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny" type="submit">Reset link</button></form>`;

        const toggleButton = `<form method="post" action="/admin/users/${escapeHtml(
            user.id
        )}/${user.disabled ? 'enable' : 'disable'}"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny ${
            user.disabled ? '' : 'danger'
        }" type="submit" ${
            isSelf || isLastEnabledAdmin ? 'disabled' : ''
        }>${user.disabled ? 'Enable' : 'Disable'}</button></form>`;

        const revokeButton = `<form method="post" action="/admin/users/${escapeHtml(
            user.id
        )}/signout"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny" type="submit" ${
            sessionCount === 0 ? 'disabled' : ''
        }>Sign out${sessionCount ? ` (${sessionCount})` : ''}</button></form>`;

        const deleteButton = `<form method="post" action="/admin/users/${escapeHtml(
            user.id
        )}/delete"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny danger" type="submit" ${
            isSelf || isLastEnabledAdmin ? 'disabled' : ''
        }>Delete</button></form>`;

        rows += `<tr>
<td><span class="mono">${escapeHtml(user.username)}</span>${
            isSelf ? ' <span class="faint">(you)</span>' : ''
        }</td>
<td><span class="pill ${user.role === 'admin' ? 'admin' : ''}">${escapeHtml(user.role)}</span></td>
<td>${status}</td>
<td class="muted">${escapeHtml(formatTimestamp(user.lastLoginAt))}</td>
<td class="actions">${resetButton} ${toggleButton} ${revokeButton} ${deleteButton}</td>
</tr>`;
    }
    return rows;
}

function renderInviteRows(options: IAdminPageOptions, now: Date): string {
    const csrf = escapeHtml(options.csrf);
    let rows = '';
    for (const invite of options.invites) {
        const status = inviteStatus(invite, now);
        const user = options.users.find((candidate) => candidate.id === invite.userId);
        const link =
            status === 'pending' && invite.code
                ? `<input type="text" readonly spellcheck="false" value="${escapeHtml(
                      `${options.baseUrl}/invite/${invite.code}`
                  )}" aria-label="Invite link" style="min-width:320px">`
                : '<span class="faint">link hidden</span>';
        const revoke =
            status === 'pending'
                ? `<form method="post" action="/admin/invites/${escapeHtml(
                      invite.id
                  )}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny danger" type="submit">Revoke</button></form>`
                : '';
        const expires =
            status === 'pending'
                ? formatRelative(invite.expiresAt, now)
                : `${escapeHtml(status)} ${escapeHtml(formatRelative(invite.usedAt || invite.revokedAt || invite.expiresAt, now))}`;

        rows += `<tr>
<td>${escapeHtml(user ? user.username : '(deleted account)')}</td>
<td>${escapeHtml(invite.label || '-')}</td>
<td><span class="pill ${status === 'pending' ? 'pending' : status === 'used' ? 'used' : ''}">${escapeHtml(
            status
        )}</span></td>
<td class="muted">${expires}</td>
<td>${link}</td>
<td class="actions">${revoke}</td>
</tr>`;
    }
    return rows;
}

export function renderAdminPage(ctx: IPageContext, options: IAdminPageOptions): string {
    const now = new Date();
    const csrf = escapeHtml(options.csrf);
    const userRows = renderUserRows(options);
    const inviteRows = renderInviteRows(options, now);

    const userCount = options.users.length;
    const pendingInvites = options.invites.filter((invite) => inviteStatus(invite, now) === 'pending').length;
    const activeSessions = options.sessions.length;

    const created = options.createdInvite
        ? `<div class="msg ok"><strong>Invite created for ${escapeHtml(
              options.createdInvite.label
          )}</strong> &middot; expires ${escapeHtml(
              formatRelative(options.createdInvite.expiresAt, now)
          )}. Send this link to them:<br>${inviteLinkBlock(
              options.createdInvite.link,
              'New invite link'
          )}<div class="muted" style="margin-top:8px">This link is shown here and can be re-read in the table
below until it is used. It is single use.</div></div>`
        : '';

    const createdReset = options.createdReset
        ? `<div class="msg ok"><strong>Reset link for ${escapeHtml(
              options.createdReset.username
          )}</strong> &middot; expires ${escapeHtml(
              formatRelative(options.createdReset.expiresAt, now)
          )}. It replaces their current password when used:<br>${inviteLinkBlock(
              options.createdReset.link,
              'New reset link'
          )}</div>`
        : '';

    const sessionRows = options.sessions
        .map((session) => {
            const user = options.users.find((candidate) => candidate.id === session.userId);
            return `<tr>
<td><span class="mono">${escapeHtml(user ? user.username : '(deleted)')}</span></td>
<td class="muted mono">${escapeHtml(session.ip)}</td>
<td class="muted">${escapeHtml(formatTimestamp(session.lastSeenAt))} <span class="faint">(${escapeHtml(
                formatRelative(session.lastSeenAt, now)
            )})</span></td>
<td class="actions"><form method="post" action="/admin/sessions/${escapeHtml(
                session.id
            )}/revoke"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny danger" type="submit">End</button></form></td>
</tr>`;
        })
        .join('');

    const body = `<div class="topbar">
${brandLine(ctx.appName, 'Administration')}
<form class="logout" method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="tiny" type="submit">Sign out</button></form>
</div>
<div class="card wide">
<div class="bars"></div>
<div class="card-body">
<h1>Access control</h1>
<p class="lede">${userCount} account${userCount === 1 ? '' : 's'}, ${pendingInvites} pending invite${
        pendingInvites === 1 ? '' : 's'
    }, ${activeSessions} active session${activeSessions === 1 ? '' : 's'}.</p>
${messageBlock(options)}
${created}
${createdReset}
<h2>Invite someone</h2>
<p class="muted" style="margin-top:0">The invite creates a pending account. They open the link, choose their own
password, and are signed in immediately.</p>
<form method="post" action="/admin/invites" class="inline-form">
<input type="hidden" name="csrf" value="${csrf}">
<div class="field">
<label for="username">Username</label>
<input id="username" name="username" type="text" maxlength="32" autocapitalize="none" spellcheck="false" placeholder="alex" required>
</div>
<div class="field grow">
<label for="label">Name or note</label>
<input id="label" name="label" type="text" maxlength="80" placeholder="e.g. Alex - camera B" required>
</div>
<div class="field">
<label for="role">Role</label>
<select id="role" name="role">
<option value="user">user</option>
<option value="admin">admin</option>
</select>
</div>
<div class="field">
<label for="expires_days">Expires in</label>
<select id="expires_days" name="expires_days">
<option value="1">1 day</option>
<option value="3">3 days</option>
<option value="7" selected>7 days</option>
<option value="30">30 days</option>
</select>
</div>
<button class="primary" type="submit">Create invite</button>
</form>
</div>
<div class="section">
<h2>Invites</h2>
<table>
<thead><tr><th>Account</th><th>Note</th><th>Status</th><th>Expiry</th><th>Link</th><th></th></tr></thead>
<tbody>${inviteRows || '<tr><td colspan="6" class="faint">No invites yet.</td></tr>'}</tbody>
</table>
</div>
<div class="section">
<h2>Accounts</h2>
<table>
<thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
<tbody>${userRows}</tbody>
</table>
<div class="muted" style="margin-top:12px">Disabling an account or ending its sessions takes effect immediately,
including for anyone already watching a stream. The last admin cannot be disabled or deleted.</div>
</div>
<div class="section">
<h2>Active sessions</h2>
<table>
<thead><tr><th>Account</th><th>Address</th><th>Last seen</th><th></th></tr></thead>
<tbody>${sessionRows || '<tr><td colspan="4" class="faint">Nobody is signed in.</td></tr>'}</tbody>
</table>
</div>
<div class="section">
<h2>Your account</h2>
<p class="muted" style="margin-top:0">Change your own password, or see your sessions.</p>
<p style="margin-bottom:0"><a href="/account">Account settings</a></p>
</div>
<div class="section">
<h2>Before you rely on this</h2>
<p class="muted" style="margin-top:0">Accounts gate the website and the player connection. The streamer port
(${ctx.streamerPort}) is still open to the internet so the Unreal instances can publish, and it does not check credentials
yet: anyone who can reach that port could push a stream into the grid. Restrict it at the firewall to the
streaming machines, or add a streamer token, when that becomes a concern.</p>
</div>
</div>
<p class="foot">Account data lives on the server in <span class="mono">SignallingWebServer/data/auth.json</span>.
Back it up to keep the accounts, and treat it as a secret.</p>`;
    return layout(`Administration - ${ctx.appName}`, body, { wide: true });
}
