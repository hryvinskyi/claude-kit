<?php

declare(strict_types=1);

/**
 * Which role opens which screen and takes which action. A role holds everything the roles under it hold.
 */
return [
    'hierarchy' => [
        'staff' => ['team_admin'],
        'team_admin' => ['agent'],
    ],
    'screens' => [
        'requests' => ['role' => 'agent', 'menu' => ['menu.inbox', 'menu.requests']],
        'replies' => ['role' => 'agent', 'menu' => ['menu.inbox', 'menu.replies']],
        'team.members' => ['role' => 'team_admin', 'menu' => ['menu.team', 'menu.members']],
        'team.security' => ['role' => 'team_admin', 'menu' => ['menu.team', 'menu.security']],
        'account.tokens' => ['role' => 'agent', 'menu' => ['menu.account', 'menu.tokens']],
        'staff.teams' => ['role' => 'staff', 'menu' => ['menu.staff', 'menu.teams']],
    ],
    'actions' => [
        'members.invite' => 'team_admin',
        'members.remove' => 'team_admin',
        'tokens.create' => 'staff',
        'tokens.revoke' => 'agent',
        'security.session_hours' => 'team_admin',
        'security.two_step' => 'staff',
        'teams.close' => 'staff',
    ],
];
