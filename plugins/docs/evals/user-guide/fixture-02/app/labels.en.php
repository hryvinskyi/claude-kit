<?php

declare(strict_types=1);

/**
 * Every label and message the screens show, by key.
 */
return [
    'menu.inbox' => 'Inbox',
    'menu.requests' => 'Requests',
    'menu.replies' => 'Templates',
    'menu.team' => 'Team',
    'menu.members' => 'Members',
    'menu.security' => 'Security',
    'menu.account' => 'Account',
    'menu.tokens' => 'Access tokens',
    'menu.staff' => 'Staff',
    'menu.teams' => 'Teams',

    'role.agent' => 'Agent',
    'role.team_admin' => 'Team admin',
    'role.staff' => 'Acme staff',

    'members.title' => 'Members',
    'members.name' => 'Name',
    'members.email' => 'Email',
    'members.role' => 'Role',
    'members.invite' => 'Send invitation',
    'members.remove' => 'Remove from team',
    'members.pending' => 'Invitations not accepted yet',
    'members.invited' => 'Invitation sent to %email%.',
    'members.invitation_expired' => 'The invitation is no longer valid. Send a new one.',
    'members.last_admin' => 'A team needs at least one team admin.',

    'security.title' => 'Security',
    'security.session_hours' => 'Sign-in lasts (hours)',
    'security.session_hours.help' => 'After this many hours a member signs in again. From 1 to 72.',
    'security.two_step' => 'Require two-step sign-in',
    'security.two_step.help' => 'Every member confirms each sign-in with a code from their phone.',
    'security.save' => 'Save security settings',
    'security.saved' => 'Security settings saved.',

    'tokens.title' => 'Access tokens',
    'tokens.name' => 'Name',
    'tokens.expiry' => 'Expires',
    'tokens.expiry.30' => 'In 30 days',
    'tokens.expiry.90' => 'In 90 days',
    'tokens.expiry.never' => 'Never',
    'tokens.create' => 'Create token',
    'tokens.created' => 'Created',
    'tokens.expires' => 'Expires',
    'tokens.revoke' => 'Revoke',
    'tokens.revoked' => 'The token was revoked. It stops working at once.',
    'tokens.shown_once' => 'Copy the token now. It is shown only once.',
    'tokens.none' => 'You have no access tokens. The Acme support team creates them: write to support@acme.example and say what the token is for.',

    'replies.title' => 'Templates',
    'replies.new' => 'New template',
    'replies.none' => 'No templates yet.',

    'staff.teams.title' => 'Teams',
    'staff.teams.status.open' => 'Open',
    'staff.teams.status.closed' => 'Closed',
    'staff.teams.close' => 'Close team',
];
